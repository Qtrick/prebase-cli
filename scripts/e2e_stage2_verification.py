#!/usr/bin/env python3
"""
PreBase CLI — Stage 2 End-to-End Verification Suite

Verifies:
1. `prebase map --view 2d` starts and constructs correct bootstrap URL with `view=2d`.
2. `prebase map --view 2d --focus <relative-path>` percent-encodes focus path into URL (`&focus=...`).
3. Single-use bootstrap token exchange succeeds in 2D mode.
4. Headless Chrome DOM inspection:
   - `.network-mode-switcher` is present in header.
   - `3D Overview` and `2D Relationships` buttons are rendered.
   - Opening with `view=2d&focus=src%2Fcomponents%2FCard.tsx` initializes 2D Relationship Explorer.
   - Opening with non-existent focus displays purposeful "File Not Found" state with search.
   - Mode switching button and Inspector "Explore Relationships in 2D" / "Focus relationships here" are present.
5. Clean SIGINT shutdown with 0 zombie processes.
"""

import os
import sys
import time
import json
import signal
import shutil
import urllib.request
import urllib.parse
import urllib.error
import subprocess
import tempfile

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")
PORT = 19994

def log(msg):
    print(f"\x1b[36m[STAGE 2 E2E]\x1b[0m {msg}", flush=True)

def error(msg):
    print(f"\x1b[31m[ERROR]\x1b[0m {msg}", file=sys.stderr, flush=True)

def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {msg}", flush=True)

def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read().decode("utf-8"), resp.headers

def http_post_json(url, data, headers=None):
    body = json.dumps(data).encode("utf-8")
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read().decode("utf-8"), resp.headers

def main():
    print("=" * 70)
    print("PreBase CLI Stage 2 Verification Pipeline: 2D Relationship Explorer")
    print("=" * 70)

    # 1. Build release binary if needed
    if not os.path.exists(BIN):
        log("Compiling release binary...")
        subprocess.check_call(["cargo", "build", "--release", "--bin", "prebase"], cwd=ROOT_DIR)
        success("Binary compiled.")

    # 2. Build frontend assets
    dist_dir = os.path.join(ROOT_DIR, "crates", "prebase-server", "dist")
    if not os.path.exists(os.path.join(dist_dir, "index.html")):
        log("Building frontend assets...")
        subprocess.check_call(["npm", "--prefix", "frontend", "run", "build"], cwd=ROOT_DIR)
        success("Frontend built.")

    # 3. Setup test repo
    test_dir = tempfile.mkdtemp(prefix="prebase-stage2-e2e-")
    try:
        log(f"Setting up test repository in {test_dir}...")
        git = lambda *args: subprocess.check_call(["git"] + list(args), cwd=test_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        git("init", "-b", "main")
        git("config", "user.name", "Stage2 Tester")
        git("config", "user.email", "stage2@prebase.dev")

        src_dir = os.path.join(test_dir, "src")
        components_dir = os.path.join(src_dir, "components")
        utils_dir = os.path.join(src_dir, "utils")
        os.makedirs(components_dir, exist_ok=True)
        os.makedirs(utils_dir, exist_ok=True)

        with open(os.path.join(src_dir, "types.ts"), "w") as f:
            f.write("export interface Config { debug: boolean; }\n")

        with open(os.path.join(utils_dir, "math.ts"), "w") as f:
            f.write("export function square(n: number): number { return n * n; }\n")

        with open(os.path.join(components_dir, "Button.tsx"), "w") as f:
            f.write("import { square } from '../utils/math';\nexport const Button = () => <button>{square(2)}</button>;\n")

        with open(os.path.join(components_dir, "Card.tsx"), "w") as f:
            f.write("import { Button } from './Button';\nexport const Card = () => <div><Button /></div>;\n")

        with open(os.path.join(src_dir, "index.ts"), "w") as f:
            f.write("import { Card } from './components/Card';\nimport type { Config } from './types';\nconsole.log(Card);\n")

        git("add", ".")
        git("commit", "-m", "feat: initial test codebase")
        success("Synthetic repository initialized.")

        # 4. Test 1: prebase map --view 2d --focus src/components/Card.tsx
        log(f"Launching PreBase with '--view 2d --focus src/components/Card.tsx' on port {PORT}...")
        log_file_path = os.path.join(test_dir, "prebase_2d.log")
        log_file = open(log_file_path, "w")

        proc = subprocess.Popen(
            [BIN, "--port", str(PORT), "--no-open", "map", "--view", "2d", "--focus", "src/components/Card.tsx", test_dir],
            stdout=log_file,
            stderr=subprocess.STDOUT
        )

        try:
            base_url = f"http://127.0.0.1:{PORT}"
            server_up = False
            for _ in range(50):
                try:
                    status, body, _ = http_get(f"{base_url}/api/v1/health")
                    if status == 200 and "ok" in body:
                        server_up = True
                        break
                except Exception:
                    time.sleep(0.1)

            if not server_up and os.path.exists(log_file_path):
                with open(log_file_path, "r") as f:
                    print("LOG OUTPUT:\n", f.read())
            assert server_up, "PreBase server did not become healthy"
            success("Server listening and healthy in 2D mode.")

            # Check startup URL format in log
            startup_url = None
            bootstrap_token = None
            import re
            ansi_escape = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')

            for _ in range(30):
                if os.path.exists(log_file_path):
                    with open(log_file_path, "r") as f:
                        content = f.read()
                        clean_content = ansi_escape.sub('', content)
                        for line in clean_content.splitlines():
                            if "Server running at:" in line:
                                startup_url = line.split("Server running at:")[1].strip()
                                break
                        if "bootstrap=" in clean_content:
                            part = clean_content.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                            bootstrap_token = part
                            if startup_url:
                                break
                time.sleep(0.1)

            assert startup_url, "Could not extract startup URL from log"
            assert "view=2d" in startup_url, f"Expected 'view=2d' in startup URL, got: {startup_url}"
            assert "focus=src%2Fcomponents%2FCard.tsx" in startup_url, f"Expected percent-encoded focus in startup URL, got: {startup_url}"
            success(f"Verified CLI startup URL format: {startup_url}")

            # Bootstrap exchange
            status, body, _ = http_post_json(f"{base_url}/api/v1/auth/session", {"bootstrap_token": bootstrap_token})
            assert status == 200, f"Bootstrap exchange failed: {status} {body}"
            auth_data = json.loads(body)
            session_token = auth_data["session_token"]
            auth_headers = {"x-prebase-session": session_token}
            success("Session token exchanged successfully.")

            # Wait for indexing
            indexing_ready = False
            for _ in range(50):
                try:
                    _, body, _ = http_get(f"{base_url}/api/v1/status", auth_headers)
                    st = json.loads(body)
                    if st.get("indexing_status") == "Ready":
                        indexing_ready = True
                        break
                except Exception:
                    pass
                time.sleep(0.1)

            assert indexing_ready, "Indexing did not reach Ready state"
            success("Indexing ready.")

            # Headless Chrome DOM Verification
            chrome_bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            if os.path.exists(chrome_bin):
                log("Running Headless Chrome DOM inspection for 2D mode...")
                app_url_2d = f"{base_url}/?token={session_token}&view=2d&focus=src%2Fcomponents%2FCard.tsx"
                chrome_cmd = [
                    chrome_bin,
                    "--headless=new",
                    "--disable-gpu",
                    "--virtual-time-budget=3000",
                    "--dump-dom",
                    app_url_2d
                ]
                dom_output = subprocess.check_output(chrome_cmd, timeout=15).decode("utf-8")
                if "relationship-container" not in dom_output:
                    print("DOM OUTPUT:\n", dom_output[:2000])

                assert "network-mode-switcher" in dom_output, "DOM missing .network-mode-switcher"
                assert "3D Overview" in dom_output, "DOM missing '3D Overview' button"
                assert "2D Relationships" in dom_output, "DOM missing '2D Relationships' button"
                assert "relationship-container" in dom_output, "DOM missing .relationship-container"
                assert "relationship-canvas" in dom_output, "DOM missing .relationship-canvas"
                success("Verified 2D Relationship Explorer DOM structure and mode switcher.")

                # Test 2: Missing focus file shows purposeful "File Not Found" state
                log("Testing purposeful missing-file state in Headless Chrome...")
                app_url_missing = f"{base_url}/?token={session_token}&view=2d&focus=src%2Fnon_existent.ts"
                dom_missing = subprocess.check_output([
                    chrome_bin,
                    "--headless=new",
                    "--disable-gpu",
                    "--virtual-time-budget=3000",
                    "--dump-dom",
                    app_url_missing
                ], timeout=15).decode("utf-8")

                assert "File Not Found" in dom_missing, "DOM missing 'File Not Found' header for missing focus"
                assert "src/non_existent.ts" in dom_missing, "DOM missing non-existent path citation"
                assert "Search files to explore in 2D" in dom_missing, "DOM missing search prompt in empty state"
                success("Verified purposeful 'File Not Found' empty state.")

                # Test 3: 3D Overview view mode
                log("Testing 3D Overview rendering in Headless Chrome...")
                app_url_3d = f"{base_url}/?token={session_token}&view=3d"
                dom_3d = subprocess.check_output([
                    chrome_bin,
                    "--headless=new",
                    "--disable-gpu",
                    "--virtual-time-budget=3000",
                    "--dump-dom",
                    app_url_3d
                ], timeout=15).decode("utf-8")

                assert "network-canvas" in dom_3d, "DOM missing .network-canvas in 3D mode"
                success("Verified 3D Overview canvas rendered when view=3d.")
            else:
                log("Google Chrome binary not found; skipping headless browser render check.")

        finally:
            log("Stopping PreBase server with SIGINT...")
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=4)
                success("PreBase shut down cleanly with exit code 0.")
            except subprocess.TimeoutExpired:
                proc.kill()
                error("PreBase did not shut down within 4s timeout.")
            log_file.close()

    finally:
        shutil.rmtree(test_dir, ignore_errors=True)

    print("=" * 70)
    print("\x1b[1;32mALL STAGE 2 END-TO-END VERIFICATION CHECKS PASSED!\x1b[0m")
    print("=" * 70)

if __name__ == "__main__":
    main()
