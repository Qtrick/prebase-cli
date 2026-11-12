#!/usr/bin/env python3
"""
PreBase CLI — Watcher Feedback-Loop & Event-Storm Prevention Test
Verifies that:
1. Writing logs directly to server.log inside the watched repository does NOT
   trigger an infinite reanalysis loop.
2. High-frequency file modifications are coalesced and throttled safely.
"""

import os
import sys
import time
import shutil
import tempfile
import subprocess
import urllib.request
import json
import re

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")

def log(msg):
    print(f"\x1b[36m[FEEDBACK-TEST]\x1b[0m {msg}", flush=True)

def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {msg}", flush=True)

def fail(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {msg}", file=sys.stderr, flush=True)
    sys.exit(1)

def parse_startup_info(log_path):
    startup_url, bootstrap_token = None, None
    for _ in range(50):
        if os.path.exists(log_path):
            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
                for line in content.splitlines():
                    if "Server running at:" in line:
                        startup_url = line.split("Server running at:")[1].strip()
                        startup_url = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', startup_url)
                        if "bootstrap=" in startup_url:
                            bootstrap_token = startup_url.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                        break
        if startup_url and bootstrap_token:
            break
        time.sleep(0.1)
    return startup_url, bootstrap_token

def http_post_json(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode("utf-8"), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8"), e.headers

def http_get(url, token=None):
    req = urllib.request.Request(url)
    if token:
        req.add_header("x-prebase-session", token)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode("utf-8"), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8"), e.headers

def main():
    log("Starting Watcher Feedback-Loop & Event-Storm Verification...")
    if not os.path.exists(BIN):
        fail(f"Executable not found at {BIN}. Run 'cargo build --release --bin prebase' first.")

    workspace = tempfile.mkdtemp(prefix="prebase-feedback-test-")
    proc = None
    log_file = None
    try:
        repo_dir = os.path.join(workspace, "repo")
        os.makedirs(repo_dir, exist_ok=True)
        src = os.path.join(repo_dir, "src")
        os.makedirs(src, exist_ok=True)

        git = lambda *args: subprocess.check_call(
            ["git"] + list(args), cwd=repo_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        git("init", "-b", "main")
        git("config", "user.name", "Test")
        git("config", "user.email", "test@prebase.dev")

        with open(os.path.join(src, "index.ts"), "w") as f:
            f.write("export const initial = 1;\n")
        git("add", ".")
        git("commit", "-m", "chore: initial commit")

        # Crucial test condition: write server.log directly INSIDE the watched repo!
        # In Run #18, this caused a runaway loop of >3,700 revisions.
        log_file_path = os.path.join(repo_dir, "server.log")
        log_file = open(log_file_path, "w")

        cmd = [BIN, "--port", "0", "--no-open", "map", repo_dir]
        log(f"Spawning PreBase with stdout redirected to {log_file_path} inside watched repo...")
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)

        startup_url, token = parse_startup_info(log_file_path)
        if not startup_url or not token:
            fail("Failed to parse startup info from server.log")

        base_url = startup_url.split("?")[0].rstrip("/")
        # Authenticate via bootstrap token to obtain session token
        auth_url = f"{base_url}/api/v1/auth/session"
        status, body, headers = http_post_json(auth_url, {"bootstrap_token": token, "expose_token": True})
        assert status == 200, f"Auth failed with status {status}: {body}"
        auth_data = json.loads(body)
        session_token = auth_data.get("session_token")
        assert session_token, f"Failed to obtain session token: {body}"

        # Check initial revision
        status, body, _ = http_get(f"{base_url}/api/v1/network", token=session_token)
        assert status == 200, f"Network query failed: {body}"
        initial_data = json.loads(body)
        init_rev = initial_data["revision"]
        log(f"Initial network graph revision: {init_rev}")

        # Wait 3 seconds while server logger writes periodic entries
        log("Monitoring revisions over 3.0s idle window with server.log in repo...")
        time.sleep(3.0)

        status, body, _ = http_get(f"{base_url}/api/v1/network", token=session_token)
        assert status == 200
        idle_data = json.loads(body)
        idle_rev = idle_data["revision"]
        log(f"Network graph revision after 3.0s: {idle_rev}")

        revision_delta = idle_rev - init_rev
        assert revision_delta <= 1, (
            f"REANALYSIS STORM DETECTED! Revision climbed by {revision_delta} (from {init_rev} to {idle_rev}). "
            f"Expected <= 1 change."
        )
        success(f"No feedback loop detected (revision delta: {revision_delta})")

        # Now test rapid file modifications to an unignored file
        log("Triggering 10 rapid modifications to src/index.ts over 200ms...")
        for i in range(10):
            with open(os.path.join(src, "index.ts"), "w") as f:
                f.write(f"export const value = {i};\n")
            time.sleep(0.02)

        log("Waiting 1.5s for debouncer and cooldown to coalesce...")
        time.sleep(1.5)

        status, body, _ = http_get(f"{base_url}/api/v1/network", token=session_token)
        assert status == 200
        burst_data = json.loads(body)
        burst_rev = burst_data["revision"]
        log(f"Network graph revision after burst: {burst_rev}")

        burst_delta = burst_rev - idle_rev
        assert 1 <= burst_delta <= 3, (
            f"Coalescing failure! Expected 1..3 revisions after burst, got delta of {burst_delta} (from {idle_rev} to {burst_rev})"
        )
        success(f"Burst modifications coalesced cleanly (delta: {burst_delta}, final revision: {burst_rev})")

    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
        if log_file:
            log_file.close()
        shutil.rmtree(workspace, ignore_errors=True)

    print("=" * 70)
    print("\x1b[32mALL WATCHER FEEDBACK-LOOP & EVENT-STORM CHECKS PASSED!\x1b[0m")
    print("=" * 70)

if __name__ == "__main__":
    main()
