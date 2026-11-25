#!/usr/bin/env python3
"""
PreBase CLI — Installed-Binary-to-Browser Session Reuse End-to-End Verification

Tests the complete Campaign 2 browser reuse, -n/--new, conflicting flags,
and authenticated daemon lifecycle against the installed release binary.
"""

import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INSTALL_SCRIPT = os.path.join(ROOT_DIR, "scripts", "install.sh")


def main():
    print("=" * 75)
    print("PreBase CLI — Installed Browser Session Reuse E2E Verification")
    print("=" * 75)

    with tempfile.TemporaryDirectory(prefix="prebase-reuse-e2e-") as tmp:
        prefix_dir = os.path.join(tmp, "prefix")
        repo_dir = os.path.join(tmp, "repo")
        os.makedirs(os.path.join(repo_dir, "src"), exist_ok=True)
        with open(os.path.join(repo_dir, "package.json"), "w") as f:
            f.write('{"name": "reuse-e2e"}\n')
        with open(os.path.join(repo_dir, "src", "a.ts"), "w") as f:
            f.write('import { b } from "./b";\nexport const a = b + 1;\n')
        with open(os.path.join(repo_dir, "src", "b.ts"), "w") as f:
            f.write("export const b = 41;\n")
        subprocess.run(["git", "init"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo_dir, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_dir, check=True)
        subprocess.run(["git", "add", "."], cwd=repo_dir, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=repo_dir, check=True, capture_output=True)

        # 1. Install into isolated temporary prefix
        res_inst = subprocess.run(
            ["bash", INSTALL_SCRIPT, "--prefix", prefix_dir],
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
        )
        assert res_inst.returncode == 0, f"install.sh failed: {res_inst.stderr}"
        installed_bin = os.path.join(prefix_dir, "bin", "prebase")
        assert os.path.exists(installed_bin), f"Missing installed binary at {installed_bin}"
        print(f"[PASS] Installed release binary to isolated prefix: {installed_bin}")

        env = os.environ.copy()
        env["PREBASE_NO_OS_OPEN"] = "1"

        # 2. Launch foreground server with --no-open to obtain initial bootstrap URL
        fg_proc = subprocess.Popen(
            [installed_bin, "--no-open", "map", repo_dir],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        try:
            startup_url = None
            deadline = time.time() + 10.0
            while time.time() < deadline:
                line = fg_proc.stdout.readline()
                if not line:
                    if fg_proc.poll() is not None:
                        break
                    time.sleep(0.05)
                    continue
                if "Server running at:" in line:
                    raw = line.split("Server running at:")[1].strip()
                    startup_url = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", raw)
                    break
            assert startup_url and "bootstrap=" in startup_url, f"Expected bootstrap URL, got: {startup_url}"
            print("[PASS] Foreground --no-open printed authenticated bootstrap URL.")

            # Verify .prebase (0700) and server.json (0600) permissions
            prebase_dir = os.path.join(repo_dir, ".prebase")
            session_file = os.path.join(prebase_dir, "server.json")
            for _ in range(30):
                if os.path.exists(session_file):
                    break
                time.sleep(0.05)
            assert os.path.exists(session_file), "Expected .prebase/server.json"
            assert stat.S_IMODE(os.stat(prebase_dir).st_mode) == 0o700
            assert stat.S_IMODE(os.stat(session_file).st_mode) == 0o600
            print("[PASS] Verified .prebase (0700) and server.json (0600) permissions.")

            # 3. Verify conflicting flag rejection (-n --no-open)
            res_conflict = subprocess.run(
                [installed_bin, "map", "-n", "--no-open", repo_dir],
                capture_output=True,
                text=True,
                env=env,
            )
            assert res_conflict.returncode == 2, f"Expected exit code 2 for -n --no-open, got {res_conflict.returncode}"
            print("[PASS] Conflicting -n --no-open rejected with exit code 2.")

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(viewport={"width": 1280, "height": 800})
                tab1 = context.new_page()
                tab1.goto(startup_url, wait_until="domcontentloaded", timeout=15000)
                tab1.wait_for_selector(".network-canvas", timeout=15000)
                tab1.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=15000)
                time.sleep(0.3)
                print("[PASS] Tab 1 authenticated and registered workspace SSE client.")

                # 4. Reuse Tab 1 via `prebase history`
                res_hist = subprocess.run(
                    [installed_bin, "history", repo_dir],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                assert res_hist.returncode == 0, f"prebase history failed: {res_hist.stderr}"
                assert "Reused existing PreBase workspace" in res_hist.stdout, res_hist.stdout
                tab1.wait_for_selector(".temporal-canvas", timeout=10000)
                print("[PASS] `prebase history` reused Tab 1 and switched to History view.")

                # 5. Reuse Tab 1 via `prebase map --view 2d --focus src/a.ts`
                res_2d = subprocess.run(
                    [installed_bin, "map", "--view", "2d", "--focus", "src/a.ts", repo_dir],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                assert res_2d.returncode == 0, f"prebase map --view 2d failed: {res_2d.stderr}"
                assert "Reused existing PreBase workspace" in res_2d.stdout, res_2d.stdout
                tab1.wait_for_selector(".relationship-canvas", timeout=10000)
                print("[PASS] `prebase map --view 2d --focus src/a.ts` reused Tab 1.")

                # 6. Open independent Tab 2 via `prebase map -n`
                res_new = subprocess.run(
                    [installed_bin, "map", "-n", repo_dir],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                assert res_new.returncode == 0, f"prebase map -n failed: {res_new.stderr}"
                new_url = None
                for line in res_new.stdout.splitlines():
                    if "opening new browser tab at:" in line:
                        raw = line.split("opening new browser tab at:")[1].strip()
                        new_url = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", raw)
                        break
                assert new_url and "bootstrap=" in new_url, f"Expected new-tab bootstrap URL, got: {res_new.stdout}"

                tab2 = context.new_page()
                tab2.goto(new_url, wait_until="domcontentloaded", timeout=15000)
                tab2.wait_for_selector(".network-canvas", timeout=15000)
                assert tab1.locator(".relationship-canvas").is_visible(), "Tab 1 must stay in 2D independently"
                print("[PASS] `prebase map -n` opened independent Tab 2 in 3D while Tab 1 stayed in 2D.")

                # 7. Close Tab 2 and verify Tab 1 is still reusable
                tab2.close(run_before_unload=True)
                time.sleep(0.5)
                res_3d = subprocess.run(
                    [installed_bin, "map", "--view", "3d", repo_dir],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                assert res_3d.returncode == 0, f"prebase map --view 3d failed: {res_3d.stderr}"
                assert "Reused existing PreBase workspace" in res_3d.stdout, res_3d.stdout
                try:
                    tab1.wait_for_selector(".canvas-view-layer.active .network-canvas", timeout=3000)
                except Exception:
                    fg_proc.terminate()
                    rem_out, _ = fg_proc.communicate(timeout=3)
                    diag = tab1.evaluate("() => ({ url: location.href, layer: document.querySelector('.canvas-view-layer')?.className, tab: document.querySelector('.nav-item.active')?.textContent, acks: window.performance.getEntriesByType('resource').filter(r => r.name.includes('workspace')).map(r => r.name) })")
                    raise AssertionError(f"Tab 1 did not switch to 3D! stdout={res_3d.stdout!r}, diag={diag}\nFG LOG:\n{rem_out}")
                print("[PASS] After closing Tab 2, Tab 1 was reused cleanly for 3D view.")

                context.close()
                browser.close()

            # 8. Check `prebase status --json` redacts session_token
            res_stat = subprocess.run(
                [installed_bin, "status", "--json", repo_dir],
                capture_output=True,
                text=True,
                env=env,
            )
            assert res_stat.returncode == 0
            stat_json = json.loads(res_stat.stdout)
            assert stat_json["active"] is True
            assert "session_token" not in stat_json["session"]
            print("[PASS] `prebase status --json` reports active server and redacts session_token.")

            # 9. Stop via `prebase stop`
            res_stop = subprocess.run(
                [installed_bin, "stop", "--json", repo_dir],
                capture_output=True,
                text=True,
                env=env,
            )
            assert res_stop.returncode == 0, f"prebase stop failed: {res_stop.stderr}"
            stop_json = json.loads(res_stop.stdout)
            assert stop_json["stopped"] is True
            fg_proc.wait(timeout=5)
            print("[PASS] `prebase stop --json` gracefully terminated server and cleaned session.")
        finally:
            if fg_proc.poll() is None:
                fg_proc.terminate()
                fg_proc.wait(timeout=5)

    print("=" * 75)
    print("ALL INSTALLED SESSION REUSE E2E VERIFICATIONS PASSED!")
    print("=" * 75)


if __name__ == "__main__":
    main()
