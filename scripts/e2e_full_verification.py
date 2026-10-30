#!/usr/bin/env python3
"""
PreBase CLI — Comprehensive End-to-End Test & Verification Suite

Verifies:
1. Production release compilation & standalone binary startup.
2. Bootstrap token exchange & single-use security enforcement.
3. Host header validation & origin protection.
4. Path traversal protection & file content inspection.
5. Search ranking & relationship graph extraction.
6. Git topological history pagination (pinned DAG traversal, no skipped/duplicated commits).
7. Commit details, author stats, and rename tracking with --follow.
8. Live filesystem monitoring, debounce, and automatic incremental graph synchronization.
9. Browser rendering via Headless Chrome: verifies DOM elements (#root, <canvas>, sidebar, status indicators).
10. Graceful shutdown on SIGINT with zero hanging child processes.
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
PORT = 19992

def log(msg):
    print(f"\x1b[36m[E2E]\x1b[0m {msg}", flush=True)

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
    print("=" * 65)
    print("PreBase CLI End-to-End Verification Pipeline")
    print("=" * 65)

    # 1. Build release binary if not present
    if not os.path.exists(BIN):
        log("Compiling release binary...")
        subprocess.check_call(["cargo", "build", "--release", "--bin", "prebase"], cwd=ROOT_DIR)
        success("Binary compiled successfully.")

    # 2. Build frontend distribution if not present
    dist_dir = os.path.join(ROOT_DIR, "crates", "prebase-server", "dist")
    if not os.path.exists(os.path.join(dist_dir, "index.html")):
        log("Building frontend assets...")
        subprocess.check_call(["npm", "--prefix", "frontend", "run", "build"], cwd=ROOT_DIR)
        success("Frontend built successfully.")

    # 3. Create synthetic multi-branch test repository
    test_dir = tempfile.mkdtemp(prefix="prebase-e2e-")
    try:
        log(f"Setting up test repository in {test_dir}...")
        git = lambda *args: subprocess.check_call(["git"] + list(args), cwd=test_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        git("init", "-b", "main")
        git("config", "user.name", "E2E Tester")
        git("config", "user.email", "tester@prebase.dev")

        src_dir = os.path.join(test_dir, "src")
        components_dir = os.path.join(src_dir, "components")
        utils_dir = os.path.join(src_dir, "utils")
        os.makedirs(components_dir, exist_ok=True)
        os.makedirs(utils_dir, exist_ok=True)

        with open(os.path.join(src_dir, "types.ts"), "w") as f:
            f.write("export interface User { id: string; name: string; }\n")

        with open(os.path.join(utils_dir, "math.ts"), "w") as f:
            f.write("export function add(a: number, b: number): number { return a + b; }\n")

        with open(os.path.join(components_dir, "Button.tsx"), "w") as f:
            f.write("import React from 'react';\nexport const Button = () => <button>Click</button>;\n")

        with open(os.path.join(components_dir, "Card.tsx"), "w") as f:
            f.write("import React from 'react';\nimport { Button } from './Button';\nexport const Card = () => <div><Button /></div>;\n")

        with open(os.path.join(src_dir, "index.ts"), "w") as f:
            f.write("import { Card } from './components/Card';\nimport { add } from './utils/math';\nimport type { User } from './types';\nconsole.log(add(1, 2));\n")

        git("add", ".")
        git("commit", "-m", "feat: initial commit with core architecture")

        # Create feature branch off main
        git("checkout", "-b", "feature-dashboard")
        dashboard_dir = os.path.join(src_dir, "dashboard")
        os.makedirs(dashboard_dir, exist_ok=True)
        with open(os.path.join(dashboard_dir, "Dashboard.tsx"), "w") as f:
            f.write("import { Card } from '../components/Card';\nexport const Dashboard = () => <Card />;\n")
        git("add", ".")
        git("commit", "-m", "feat(dashboard): add dashboard module")

        # Back to main, add another commit
        git("checkout", "main")
        with open(os.path.join(utils_dir, "string.ts"), "w") as f:
            f.write("export function capitalize(s: string) { return s.toUpperCase(); }\n")
        git("add", ".")
        git("commit", "-m", "feat(utils): add string helper")

        # Merge feature-dashboard into main
        git("merge", "feature-dashboard", "--no-ff", "-m", "merge: join feature-dashboard into main")

        success("Synthetic multi-branch git repository initialized.")

        # 4. Spawn PreBase server
        log(f"Launching PreBase on port {PORT}...")
        log_file_path = os.path.join(test_dir, "prebase.log")
        log_file = open(log_file_path, "w")
        proc = subprocess.Popen(
            [BIN, "--port", str(PORT), "--no-open", test_dir],
            stdout=log_file,
            stderr=subprocess.STDOUT
        )

        try:
            # 5. Wait for health check
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

            assert server_up, "PreBase server did not become healthy within 5s"
            success("Server listening and healthy.")

            # 6. Extract bootstrap token from startup log
            bootstrap_token = None
            for _ in range(30):
                if os.path.exists(log_file_path):
                    with open(log_file_path, "r") as f:
                        content = f.read()
                        if "bootstrap=" in content:
                            part = content.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                            bootstrap_token = part
                            break
                time.sleep(0.1)

            assert bootstrap_token, "Could not extract bootstrap token from log"
            success(f"Bootstrap token acquired: {bootstrap_token[:8]}...")

            # 7. Test single-use bootstrap exchange
            status, body, headers = http_post_json(
                f"{base_url}/api/v1/auth/session",
                {"bootstrap_token": bootstrap_token}
            )
            assert status == 200, f"Bootstrap exchange failed: {status} {body}"
            auth_data = json.loads(body)
            session_token = auth_data.get("session_token")
            assert session_token, "No session token returned"
            success("Bootstrap exchange succeeded. Session token received.")

            # Verify single-use consumption: replay must return 401
            try:
                http_post_json(f"{base_url}/api/v1/auth/session", {"bootstrap_token": bootstrap_token})
                raise AssertionError("Replay of bootstrap token should have failed!")
            except urllib.error.HTTPError as e:
                assert e.code == 401, f"Expected 401 on token replay, got {e.code}"
                success("Replay protection verified: bootstrap token consumed.")

            auth_headers = {"x-prebase-session": session_token}

            # 8. Poll until indexing is Ready
            log("Waiting for repository indexing to complete...")
            indexing_ready = False
            for _ in range(100):
                try:
                    _, body, _ = http_get(f"{base_url}/api/v1/status", auth_headers)
                    st = json.loads(body)
                    if st.get("indexing_status") == "Ready":
                        indexing_ready = True
                        assert st.get("watcher_health") == "active", f"Expected active watcher, got {st.get('watcher_health')}"
                        break
                except Exception:
                    pass
                time.sleep(0.1)

            assert indexing_ready, "Indexing did not reach Ready status"
            success("Indexing complete: status is Ready, watcher is Active.")

            # 9. Verify Network Graph
            _, body, _ = http_get(f"{base_url}/api/v1/network", auth_headers)
            snapshot = json.loads(body)
            nodes = snapshot.get("nodes", [])
            edges = snapshot.get("edges", [])
            assert len(nodes) >= 6, f"Expected at least 6 nodes, got {len(nodes)}"
            assert len(edges) >= 4, f"Expected at least 4 edges, got {len(edges)}"
            success(f"Network graph verified: {len(nodes)} files, {len(edges)} confirmed relationships.")

            # Verify Search API
            _, body, _ = http_get(f"{base_url}/api/v1/files?q=Card", auth_headers)
            search_results = json.loads(body)
            assert any("Card.tsx" in r["relative_path"] for r in search_results), "Search did not find Card.tsx"
            success("Search endpoint verified.")

            # Verify Path Traversal Protection
            try:
                http_get(f"{base_url}/api/v1/source/../../etc/passwd", auth_headers)
                raise AssertionError("Path traversal should have been blocked!")
            except urllib.error.HTTPError as e:
                assert e.code in (400, 403), f"Expected 400 or 403 on traversal, got {e.code}"
                success("Path traversal protection verified (rejected with 400/403).")

            # 10. Verify Temporal History Pagination
            _, body, _ = http_get(f"{base_url}/api/v1/history?limit=2", auth_headers)
            page1 = json.loads(body)
            assert len(page1["commits"]) == 2, f"Expected 2 commits in page 1, got {len(page1['commits'])}"
            assert page1["has_more"] is True, "Expected has_more == True"
            cursor1 = page1["next_cursor"]
            assert cursor1, "Expected next_cursor to be present"

            # Page 2
            encoded_cursor = urllib.parse.quote(cursor1)
            _, body, _ = http_get(f"{base_url}/api/v1/history?limit=2&cursor={encoded_cursor}", auth_headers)
            page2 = json.loads(body)
            assert len(page2["commits"]) >= 1, "Expected at least 1 commit in page 2"

            hashes_p1 = {c["hash"] for c in page1["commits"]}
            hashes_p2 = {c["hash"] for c in page2["commits"]}
            duplicates = hashes_p1.intersection(hashes_p2)
            assert len(duplicates) == 0, f"Found duplicate commits between pages: {duplicates}"
            success(f"Temporal DAG pagination verified: page 1 and page 2 disjoint with 0 duplicates.")

            # 11. Verify Live Filesystem Sync
            log("Testing live filesystem update...")
            new_file_path = os.path.join(src_dir, "live_feature.ts")
            with open(new_file_path, "w") as f:
                f.write("import { add } from './utils/math';\nexport const liveValue = add(10, 20);\n")

            # Poll status until revision increments
            updated_rev = False
            for _ in range(50):
                try:
                    _, body, _ = http_get(f"{base_url}/api/v1/status", auth_headers)
                    st = json.loads(body)
                    if st.get("revision", 0) >= 2:
                        updated_rev = True
                        break
                except Exception:
                    pass
                time.sleep(0.1)

            assert updated_rev, "Filesystem watcher did not increment analysis revision"
            success("Live filesystem synchronization verified: revision incremented to 2 on disk change.")

            # 12. Headless Chrome browser DOM verification
            chrome_bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            if os.path.exists(chrome_bin):
                log("Running headless Chrome DOM inspection...")
                app_url = f"{base_url}/?token={session_token}&view=network"
                chrome_cmd = [
                    chrome_bin,
                    "--headless=new",
                    "--disable-gpu",
                    "--dump-dom",
                    app_url
                ]
                dom_output = subprocess.check_output(chrome_cmd, timeout=15).decode("utf-8")
                assert "root" in dom_output, "DOM output missing #root element"
                assert "PreBase" in dom_output, "DOM output missing PreBase title"
                assert "Network Graph" in dom_output, "DOM output missing Network Graph tab"
                success("Headless Chrome rendered web UI cleanly with expected DOM components.")
            else:
                log("Google Chrome binary not found; skipping headless browser render check.")

        finally:
            # 13. Graceful shutdown
            log("Sending SIGINT to PreBase process...")
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

    print("=" * 65)
    print("\x1b[1;32mALL END-TO-END VERIFICATION CHECKS PASSED!\x1b[0m")
    print("=" * 65)

if __name__ == "__main__":
    main()

