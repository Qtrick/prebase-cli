#!/usr/bin/env python3
"""
PreBase CLI — Release Binary Smoke Test Suite

Validates that a packaged/compiled prebase release executable is fully functional:
  1. CLI version and help flags.
  2. Spawns cleanly against a real repository fixture.
  3. Serves HTTP readiness and health endpoint.
  4. Single-use bootstrap token exchange produces authenticated session.
  5. Indexing transitions to Ready state.
  6. Embedded SPA HTML serves valid asset links.
  7. Embedded JS and CSS assets return correct Content-Type and HTTP 200.
  8. Missing static resources return HTTP 404 (not SPA HTML fallback).
  9. Network Graph and Temporal History APIs return valid structured data.
 10. Clean shutdown via signal releases socket port immediately.
"""

import sys
import os
import subprocess
import tempfile
import time
import json
import urllib.request
import urllib.error
import signal
import socket
import re

# Enforce supported Python version (3.10 <= ver < 3.14)
if sys.version_info < (3, 10) or sys.version_info >= (3, 14):
    print(
        f"[WARN] PreBase tooling officially targets Python 3.10-3.13. Current Python: {sys.version}",
        file=sys.stderr,
    )

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def log(msg):
    print(f"\x1b[36m[SMOKE]\x1b[0m {msg}", flush=True)


def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {msg}", flush=True)


def error(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {msg}", file=sys.stderr, flush=True)


def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read().decode("utf-8"), resp.headers


def http_get_raw(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read(), resp.headers


def http_post_json(url, data, headers=None):
    body = json.dumps(data).encode("utf-8")
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read().decode("utf-8"), resp.headers


def run_smoke_test(binary_path):
    assert os.path.isfile(binary_path), f"Binary not found: {binary_path}"
    assert os.access(binary_path, os.X_OK), f"Binary is not executable: {binary_path}"

    log(f"Testing binary: {binary_path} (size: {os.path.getsize(binary_path)} bytes)")

    # 1. prebase --version
    out = subprocess.check_output([binary_path, "--version"]).decode("utf-8").strip()
    assert "prebase" in out and "0.1.0" in out, f"Unexpected --version output: {out}"
    success(f"Verified --version: {out}")

    # 2. prebase --help
    help_out = subprocess.check_output([binary_path, "--help"]).decode("utf-8")
    assert "map" in help_out and "history" in help_out, "Help missing subcommands"
    success("Verified --help output")

    # 3. Create synthetic test repo
    test_dir = tempfile.mkdtemp(prefix="prebase-smoke-")
    proc = None
    log_file = None
    try:
        git = lambda *args: subprocess.check_call(
            ["git"] + list(args), cwd=test_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        git("init", "-b", "main")
        git("config", "user.name", "Smoke Tester")
        git("config", "user.email", "smoke@prebase.dev")

        src_dir = os.path.join(test_dir, "src")
        os.makedirs(src_dir, exist_ok=True)
        with open(os.path.join(src_dir, "utils.ts"), "w") as f:
            f.write("export function greet(name: string) { return `Hello ${name}`; }\n")
        with open(os.path.join(src_dir, "index.ts"), "w") as f:
            f.write("import { greet } from './utils';\nconsole.log(greet('PreBase'));\n")
        with open(os.path.join(test_dir, "README.md"), "w") as f:
            f.write("# Smoke Test Repo\n")

        git("add", ".")
        git("commit", "-m", "feat: initial commit for smoke test")

        port = find_free_port()
        log_path = os.path.join(test_dir, "server.log")
        log_file = open(log_path, "w")

        # 4. Spawn binary against fixture
        log(f"Spawning target release binary on port {port}...")
        proc = subprocess.Popen(
            [binary_path, "--port", str(port), "--no-open", test_dir],
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

        base_url = f"http://127.0.0.1:{port}"

        # 5. Wait for HTTP readiness
        server_healthy = False
        for _ in range(50):
            try:
                status, body, _ = http_get(f"{base_url}/api/v1/health")
                if status == 200 and "ok" in body:
                    server_healthy = True
                    break
            except Exception:
                time.sleep(0.1)

        assert server_healthy, "PreBase release server did not become healthy within 5s"
        success("Server is healthy and serving HTTP 200 on /api/v1/health")

        # 6. Extract bootstrap token
        bootstrap_token = None
        for _ in range(30):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    content = f.read()
                    if "bootstrap=" in content:
                        part = content.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                        bootstrap_token = part
                        break
            time.sleep(0.1)

        assert bootstrap_token, "Could not extract bootstrap token from startup log"
        success("Bootstrap token extracted securely")

        # 7. Exchange bootstrap token
        status, body, headers = http_post_json(
            f"{base_url}/api/v1/auth/session",
            {"bootstrap_token": bootstrap_token, "expose_token": True},
        )
        assert status == 200, f"Token exchange failed: {status} {body}"
        auth_data = json.loads(body)
        session_token = auth_data.get("session_token")
        assert session_token, "Missing session token in exchange response"
        success("Session token exchanged successfully")

        auth_headers = {"x-prebase-session": session_token}

        # 8. Wait for indexing Ready
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

        assert indexing_ready, "Indexing did not reach Ready state within timeout"
        success("Indexing reached Ready status")

        # 9. Verify embedded frontend index.html and its embedded asset links
        status, html_content, headers = http_get(f"{base_url}/")
        assert status == 200, f"Root / returned status {status}"
        assert "<!doctype html>" in html_content.lower() or "<html" in html_content.lower()
        success("Embedded frontend root HTML served successfully")

        # Extract embedded assets referenced in index.html
        js_matches = re.findall(r'src="(/assets/[^"]+\.js)"', html_content)
        css_matches = re.findall(r'href="(/assets/[^"]+\.css)"', html_content)

        assert len(js_matches) > 0, "No embedded JS asset referenced in index.html"
        assert len(css_matches) > 0, "No embedded CSS asset referenced in index.html"

        # Verify JS asset serving and MIME type
        for js_path in js_matches:
            status, raw_bytes, h = http_get_raw(f"{base_url}{js_path}")
            assert status == 200, f"JS asset {js_path} returned {status}"
            content_type = h.get("Content-Type", "")
            assert "javascript" in content_type, f"JS asset {js_path} wrong Content-Type: {content_type}"
            assert len(raw_bytes) > 1000, f"JS asset {js_path} unexpectedly small: {len(raw_bytes)} bytes"
            success(f"Verified embedded JS asset {js_path} (MIME: {content_type}, {len(raw_bytes)} bytes)")

        # Verify CSS asset serving and MIME type
        for css_path in css_matches:
            status, raw_bytes, h = http_get_raw(f"{base_url}{css_path}")
            assert status == 200, f"CSS asset {css_path} returned {status}"
            content_type = h.get("Content-Type", "")
            assert "css" in content_type, f"CSS asset {css_path} wrong Content-Type: {content_type}"
            assert len(raw_bytes) > 500, f"CSS asset {css_path} unexpectedly small: {len(raw_bytes)} bytes"
            success(f"Verified embedded CSS asset {css_path} (MIME: {content_type}, {len(raw_bytes)} bytes)")

        # 10. Missing static asset must return 404 (not HTML fallback)
        try:
            http_get(f"{base_url}/assets/non_existent_bundle_12345.js")
            raise AssertionError("Missing asset should have returned 404!")
        except urllib.error.HTTPError as e:
            assert e.code == 404, f"Expected 404 for missing asset, got {e.code}"
            success("Verified 404 response for missing static asset (no HTML fallback leakage)")

        # 11. Verify Network API
        _, net_body, _ = http_get(f"{base_url}/api/v1/network", auth_headers)
        net_data = json.loads(net_body)
        nodes = net_data.get("nodes", [])
        assert len(nodes) >= 2, f"Expected at least 2 nodes, got {len(nodes)}"
        node_ids = {n["id"] for n in nodes}
        assert any("index.ts" in nid for nid in node_ids), "Missing index.ts node"
        assert any("utils.ts" in nid for nid in node_ids), "Missing utils.ts node"
        success(f"Verified Network API: {len(nodes)} nodes, {len(net_data.get('edges', []))} edges")

        # 12. Verify Temporal API
        _, hist_body, _ = http_get(f"{base_url}/api/v1/history?limit=10", auth_headers)
        hist_data = json.loads(hist_body)
        commits = hist_data.get("commits", [])
        assert len(commits) >= 1, f"Expected at least 1 commit, got {len(commits)}"
        assert "smoke test" in commits[0]["summary"], f"Unexpected commit summary: {commits[0]['summary']}"
        success(f"Verified Temporal API: commit {commits[0]['short_hash']} ('{commits[0]['summary']}')")

        # 13. Clean shutdown and immediate port release
        log("Testing graceful shutdown on SIGTERM...")
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)
        assert proc.returncode == 0, f"Expected exit code 0, got {proc.returncode}"
        assert not is_port_in_use(port), f"Port {port} still in use after shutdown"
        success("Server shut down cleanly with exit code 0 and released port immediately")

    finally:
        if proc and proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass
        if log_file:
            log_file.close()
        import shutil
        shutil.rmtree(test_dir, ignore_errors=True)


def main():
    binary_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT_DIR, "target", "release", "prebase")
    print("=" * 70)
    print("PreBase CLI — Release Binary Smoke Test Suite")
    print("=" * 70)
    run_smoke_test(binary_path)
    print("=" * 70)
    print("\x1b[1;32mALL RELEASE BINARY SMOKE TESTS PASSED!\x1b[0m")
    print("=" * 70)


if __name__ == "__main__":
    main()

