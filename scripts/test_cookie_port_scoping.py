#!/usr/bin/env python3
"""
scripts/test_cookie_port_scoping.py

RFC 6265 Section 8.5 Cookie Port-Scoping & Multi-Instance Isolation Verification
---------------------------------------------------------------------------------
Empirically demonstrates and verifies that standard browser cookie jars scope
cookies by host (e.g. 127.0.0.1) and path (/), NOT by TCP port number.

RFC 6265 Section 8.5 ("Weak Confidentiality"):
    "Cookies do not provide confidentiality for concurrent sessions on
     different ports of the same host name. If a cookie does not specify
     a domain, the cookie is scoped to the host name. However, this scope
     is not qualified by port number. Therefore, if a cookie is set by a
     service running on one port, the browser will include that cookie in
     subsequent requests to a service running on another port of the same
     host name."

PreBase Defense Architecture:
    Because browsers send Port A's cookies to Port B on 127.0.0.1:
    1. An un-suffixed cookie name (`prebase_session`) would lead to severe
       session clobbering and collision whenever multiple PreBase instances
       run on different ports of localhost (e.g. repo 1 on 19881, repo 2 on 19882)
       or when an unrelated local web service shares localhost.
    2. PreBase resolves this by partitioning cookie names by allocated TCP port:
           `prebase_session_{port}={token}; HttpOnly; SameSite=Strict; Path=/`
    3. The auth middleware on port N strictly validates that the incoming Cookie
       contains `prebase_session_{N}=...`. Mismatched port cookies (e.g. from
       port 19881 presented to port 19882) are rejected with 401 Unauthorized.
    4. Multiple concurrent instances on different ports coexist harmoniously
       in the browser jar without clobbering each other.

This script implements:
    Phase 1: Empirical verification of RFC 6265 §8.5 (Server A cookie sent to Server B).
    Phase 2: Verification of PreBase auth rejection on Server B for foreign port cookie.
    Phase 3: Multi-instance concurrent coexistence without session clobbering.
    Phase 4: Complete log sanitization preventing secret token leakage.
    Phase 5: Deterministic server and browser resource cleanup.

Execution:
    python3 scripts/test_cookie_port_scoping.py
"""

import http.server
import re
import socket
import sys
import threading
import time
from typing import Dict, List, Optional, Tuple

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

DEFAULT_PORT_A = 19881
DEFAULT_PORT_B = 19882

TOKEN_A = "pb_sec_tok_alpha_9f83a4c2e17b8849d63025e1a"
TOKEN_B = "pb_sec_tok_bravo_5d72e10c84b39174f82613a0c"

def log_info(msg: str) -> None:
    print(f"\x1b[36m[COOKIE-VERIFY]\x1b[0m {msg}", flush=True)

def log_success(msg: str) -> None:
    print(f"\x1b[32m[PASS]\x1b[0m {msg}", flush=True)

def log_fail(msg: str) -> None:
    print(f"\x1b[31m[FAIL]\x1b[0m {msg}", file=sys.stderr, flush=True)

def log_warn(msg: str) -> None:
    print(f"\x1b[33m[WARN]\x1b[0m {msg}", flush=True)

def sanitize(text: str, secrets: Optional[List[str]] = None) -> str:
    """
    Sanitizes log messages so sensitive token secrets are never output in plain text.
    Replaces exact secret matches and regex matches for session cookies / headers.
    """
    if secrets is None:
        secrets = [TOKEN_A, TOKEN_B]
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED_SECRET]")
    # Mask any session token value in prebase_session_<port>=<val>
    text = re.sub(r"(prebase_session_\d+=)[^;\s]+", r"\1[REDACTED_SECRET]", text)
    text = re.sub(r"(x-prebase-session:\s*)[^\r\n]+", r"\1[REDACTED_SECRET]", text)
    return text

def find_available_port(preferred: int, host: str = "127.0.0.1") -> int:
    """Attempts to bind to preferred port; falls back to ephemeral port if occupied."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, preferred))
            return preferred
    except OSError:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind((host, 0))
            return s.getsockname()[1]

class ReusableHTTPServer(http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True

def extract_cookie_token(cookie_header: Optional[str], port: int) -> Optional[str]:
    """
    Simulates PreBase's auth extraction logic from crates/prebase-server/src/auth.rs:
    Only accepts `prebase_session_{port}=<token>`.
    """
    if not cookie_header:
        return None
    port_prefix = f"prebase_session_{port}="
    for item in cookie_header.split(";"):
        item = item.strip()
        if item.startswith(port_prefix):
            return item[len(port_prefix):]
    return None

class ServerAHandler(http.server.BaseHTTPRequestHandler):
    """
    Simulates PreBase Instance A (port A).
    Issues `prebase_session_{port_a}` and validates requests against `port_a`.
    """
    port_a: int = DEFAULT_PORT_A
    token_a: str = TOKEN_A
    requests_log: List[Tuple[str, Optional[str], int]] = []

    def do_GET(self) -> None:
        cookie_header = self.headers.get("Cookie")
        matched_token = extract_cookie_token(cookie_header, self.port_a)

        if self.path == "/":
            # Initial landing / login bootstrap: sets port-partitioned cookie
            body = (
                f"<!DOCTYPE html><html><head><title>Server A</title></head>"
                f"<body><h1>PreBase Instance A (Port {self.port_a})</h1></body></html>"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header(
                "Set-Cookie",
                f"prebase_session_{self.port_a}={self.token_a}; HttpOnly; SameSite=Strict; Path=/",
            )
            self.end_headers()
            self.wfile.write(body)
            self.requests_log.append((self.path, cookie_header, 200))
        elif self.path == "/api/status":
            # Protected endpoint
            if matched_token == self.token_a:
                body = b'{"status":"ok","instance":"A"}'
                status = 200
            else:
                body = b'{"error":"unauthorized"}'
                status = 401
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.requests_log.append((self.path, cookie_header, status))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args) -> None:
        pass

class ServerBHandler(http.server.BaseHTTPRequestHandler):
    """
    Simulates PreBase Instance B (or unrelated service on port B).
    Demonstrates cross-port cookie receipt and port-prefix isolation.
    """
    port_b: int = DEFAULT_PORT_B
    token_b: str = TOKEN_B
    requests_log: List[Tuple[str, Optional[str], int]] = []

    def do_GET(self) -> None:
        cookie_header = self.headers.get("Cookie")
        matched_token = extract_cookie_token(cookie_header, self.port_b)

        if self.path == "/" or self.path == "/target-endpoint":
            # Endpoint visited by browser from Server A
            # Evaluates auth as Server B
            status = 200 if (matched_token == self.token_b) else 401
            body = (
                f"<!DOCTYPE html><html><head><title>Server B</title></head>"
                f"<body><h1>PreBase Instance B (Port {self.port_b}) - Status {status}</h1></body></html>"
            ).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.requests_log.append((self.path, cookie_header, status))
        elif self.path == "/login-b":
            # Server B issues its own port-partitioned cookie
            body = b'<!DOCTYPE html><html><body><h1>Server B Logged In</h1></body></html>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header(
                "Set-Cookie",
                f"prebase_session_{self.port_b}={self.token_b}; HttpOnly; SameSite=Strict; Path=/",
            )
            self.end_headers()
            self.wfile.write(body)
            self.requests_log.append((self.path, cookie_header, 200))
        elif self.path == "/api/status":
            if matched_token == self.token_b:
                body = b'{"status":"ok","instance":"B"}'
                status = 200
            else:
                body = b'{"error":"unauthorized"}'
                status = 401
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.requests_log.append((self.path, cookie_header, status))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args) -> None:
        pass

def run_cookie_port_scoping_test() -> bool:
    port_a = find_available_port(DEFAULT_PORT_A)
    port_b_candidate = DEFAULT_PORT_B if DEFAULT_PORT_B != port_a else port_a + 1
    port_b = find_available_port(port_b_candidate)
    while port_b == port_a:
        port_b = find_available_port(port_b + 1)

    log_info("Initializing test harness on 127.0.0.1:")
    log_info(f"  • Server A (PreBase Instance 1): http://127.0.0.1:{port_a}")
    log_info(f"  • Server B (PreBase Instance 2): http://127.0.0.1:{port_b}")

    ServerAHandler.port_a = port_a
    ServerAHandler.token_a = TOKEN_A
    ServerAHandler.requests_log = []

    ServerBHandler.port_b = port_b
    ServerBHandler.token_b = TOKEN_B
    ServerBHandler.requests_log = []

    server_a: Optional[ReusableHTTPServer] = None
    server_b: Optional[ReusableHTTPServer] = None
    thread_a: Optional[threading.Thread] = None
    thread_b: Optional[threading.Thread] = None

    try:
        server_a = ReusableHTTPServer(("127.0.0.1", port_a), ServerAHandler)
        server_b = ReusableHTTPServer(("127.0.0.1", port_b), ServerBHandler)

        thread_a = threading.Thread(target=server_a.serve_forever, daemon=True)
        thread_b = threading.Thread(target=server_b.serve_forever, daemon=True)

        thread_a.start()
        thread_b.start()
        log_info("Both local HTTP servers running.")

        time.sleep(0.05)

        if PLAYWRIGHT_AVAILABLE:
            log_info("Launching Playwright headless Chromium browser...")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                context = browser.new_context()
                page = context.new_page()

                # Record client-side request headers for cross-verification
                requests_dispatched: List[Tuple[str, Optional[str]]] = []
                def on_request(req):
                    cookie_val = req.all_headers().get("cookie")
                    requests_dispatched.append((req.url, cookie_val))
                page.on("request", on_request)

                try:
                    # -----------------------------------------------------------------
                    # PHASE 1: Empirical Verification of RFC 6265 Section 8.5
                    # -----------------------------------------------------------------
                    log_info("--- Phase 1: Verify RFC 6265 §8.5 Cookie Port Scoping ---")
                    url_a = f"http://127.0.0.1:{port_a}/"
                    log_info(f"Navigating to Server A at {url_a}...")
                    resp_a = page.goto(url_a)
                    assert resp_a is not None and resp_a.status == 200, "Server A initial response must be 200"

                    cookies_after_a = context.cookies()
                    cookie_name_a = f"prebase_session_{port_a}"
                    matched_a = next((c for c in cookies_after_a if c["name"] == cookie_name_a), None)

                    assert matched_a is not None, f"Browser cookie jar must contain {cookie_name_a}"
                    log_info(
                        f"Browser stored cookie: {matched_a['name']}={sanitize(matched_a['value'])} "
                        f"[domain={matched_a['domain']}, path={matched_a['path']}, httpOnly={matched_a['httpOnly']}]"
                    )

                    # Now navigate to Server B on Port B (different port on same host)
                    url_b = f"http://127.0.0.1:{port_b}/target-endpoint"
                    log_info(f"Navigating to Server B at {url_b}...")
                    page.goto(url_b)

                    # Inspect what Server B received
                    assert len(ServerBHandler.requests_log) > 0, "Server B must have received request"
                    path_b, captured_cookie_b, status_b = ServerBHandler.requests_log[-1]

                    sanitized_b = sanitize(captured_cookie_b or "[NONE]")
                    log_info(f"Server B received Cookie header: '{sanitized_b}'")

                    # EMPIRICAL PROOF OF RFC 6265 §8.5:
                    # The browser sent prebase_session_<port_a> to port_b!
                    assert captured_cookie_b is not None, (
                        "RFC 6265 §8.5 failure: Browser did not send cookie across ports on 127.0.0.1"
                    )
                    assert f"prebase_session_{port_a}=" in captured_cookie_b, (
                        f"Expected 'prebase_session_{port_a}=' in Server B's incoming Cookie header"
                    )
                    assert f"prebase_session_{port_a}={TOKEN_A}" in captured_cookie_b, (
                        "Transmitted cookie secret did not match Token A"
                    )

                    log_success(
                        f"RFC 6265 §8.5 EMPIRICALLY CONFIRMED: Chromium sent '{cookie_name_a}' "
                        f"from port {port_a} to port {port_b} on 127.0.0.1 (cookies scoped to host, not port)."
                    )

                    # -----------------------------------------------------------------
                    # PHASE 2: Verification of PreBase Auth Middleware Port Rejection
                    # -----------------------------------------------------------------
                    log_info("--- Phase 2: Verify PreBase Auth Isolation on Server B ---")
                    # Server B must reject the foreign port cookie with HTTP 401
                    assert status_b == 401, (
                        f"Security failure: Server B should have rejected foreign port cookie with 401, got {status_b}"
                    )
                    log_success(
                        f"AUTH DEFENSE CONFIRMED: Server B (port {port_b}) rejected cookie '{cookie_name_a}' "
                        f"with HTTP 401 Unauthorized because port suffix did not match."
                    )

                    # -----------------------------------------------------------------
                    # PHASE 3: Multi-Instance Concurrent Coexistence (No Clobbering)
                    # -----------------------------------------------------------------
                    log_info("--- Phase 3: Verify Multi-Instance Concurrent Coexistence ---")
                    # Authenticate on Server B
                    url_b_login = f"http://127.0.0.1:{port_b}/login-b"
                    log_info(f"Authenticating on Server B at {url_b_login}...")
                    resp_b_login = page.goto(url_b_login)
                    assert resp_b_login is not None and resp_b_login.status == 200

                    # Both cookies must now coexist in the browser jar
                    all_cookies = context.cookies()
                    cookie_name_b = f"prebase_session_{port_b}"
                    has_cookie_a = any(c["name"] == cookie_name_a for c in all_cookies)
                    has_cookie_b = any(c["name"] == cookie_name_b for c in all_cookies)
                    assert has_cookie_a and has_cookie_b, (
                        "Browser jar must retain both port-partitioned cookies simultaneously without clobbering"
                    )
                    log_info(f"Browser cookie jar retains both '{cookie_name_a}' and '{cookie_name_b}'.")

                    # Test Server A API: must succeed with 200 OK
                    api_a_resp = page.goto(f"http://127.0.0.1:{port_a}/api/status")
                    assert api_a_resp is not None and api_a_resp.status == 200, "Server A API status must be 200"
                    content_a = api_a_resp.body().decode("utf-8")
                    assert '"instance":"A"' in content_a, "Server A must identify instance A"
                    log_success("Server A API authenticated successfully in presence of Server B cookie.")

                    # Test Server B API: must succeed with 200 OK
                    api_b_resp = page.goto(f"http://127.0.0.1:{port_b}/api/status")
                    assert api_b_resp is not None and api_b_resp.status == 200, "Server B API status must be 200"
                    content_b = api_b_resp.body().decode("utf-8")
                    assert '"instance":"B"' in content_b, "Server B must identify instance B"
                    log_success("Server B API authenticated successfully in presence of Server A cookie.")

                finally:
                    context.close()
                    browser.close()
                    log_info("Playwright browser and context closed cleanly.")
        else:
            log_info("Playwright not detected. Running RFC 6265 §8.5 verification via Python standard library http.cookiejar...")
            import http.cookiejar
            import urllib.request
            import urllib.error

            jar = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

            # -----------------------------------------------------------------
            # PHASE 1: Empirical Verification of RFC 6265 Section 8.5
            # -----------------------------------------------------------------
            log_info("--- Phase 1: Verify RFC 6265 §8.5 Cookie Port Scoping ---")
            url_a = f"http://127.0.0.1:{port_a}/"
            log_info(f"Navigating to Server A at {url_a}...")
            with opener.open(url_a) as resp_a:
                assert resp_a.status == 200, "Server A initial response must be 200"

            cookie_name_a = f"prebase_session_{port_a}"
            matched_a = any(c.name == cookie_name_a for c in jar)
            assert matched_a, f"Cookie jar must contain {cookie_name_a}"
            log_info(f"Client stored cookie: {cookie_name_a}=[REDACTED_SECRET]")

            # Now navigate to Server B on Port B (different port on same host)
            url_b = f"http://127.0.0.1:{port_b}/target-endpoint"
            log_info(f"Navigating to Server B at {url_b}...")
            try:
                with opener.open(url_b) as resp_b:
                    status_b = resp_b.status
            except urllib.error.HTTPError as e:
                status_b = e.code

            assert len(ServerBHandler.requests_log) > 0, "Server B must have received request"
            path_b, captured_cookie_b, _ = ServerBHandler.requests_log[-1]

            sanitized_b = sanitize(captured_cookie_b or "[NONE]")
            log_info(f"Server B received Cookie header: '{sanitized_b}'")

            assert captured_cookie_b is not None, (
                "RFC 6265 §8.5 failure: Client did not send cookie across ports on 127.0.0.1"
            )
            assert f"prebase_session_{port_a}=" in captured_cookie_b, (
                f"Expected 'prebase_session_{port_a}=' in Server B's incoming Cookie header"
            )
            assert f"prebase_session_{port_a}={TOKEN_A}" in captured_cookie_b, (
                "Transmitted cookie secret did not match Token A"
            )

            log_success(
                f"RFC 6265 §8.5 EMPIRICALLY CONFIRMED: Client sent '{cookie_name_a}' "
                f"from port {port_a} to port {port_b} on 127.0.0.1 (cookies scoped to host, not port)."
            )

            # -----------------------------------------------------------------
            # PHASE 2: Verification of PreBase Auth Middleware Port Rejection
            # -----------------------------------------------------------------
            log_info("--- Phase 2: Verify PreBase Auth Isolation on Server B ---")
            assert status_b == 401, (
                f"Security failure: Server B should have rejected foreign port cookie with 401, got {status_b}"
            )
            log_success(
                f"AUTH DEFENSE CONFIRMED: Server B (port {port_b}) rejected cookie '{cookie_name_a}' "
                f"with HTTP 401 Unauthorized because port suffix did not match."
            )

            # -----------------------------------------------------------------
            # PHASE 3: Multi-Instance Concurrent Coexistence (No Clobbering)
            # -----------------------------------------------------------------
            log_info("--- Phase 3: Verify Multi-Instance Concurrent Coexistence ---")
            url_b_login = f"http://127.0.0.1:{port_b}/login-b"
            log_info(f"Authenticating on Server B at {url_b_login}...")
            with opener.open(url_b_login) as resp_b_login:
                assert resp_b_login.status == 200

            cookie_name_b = f"prebase_session_{port_b}"
            has_cookie_a = any(c.name == cookie_name_a for c in jar)
            has_cookie_b = any(c.name == cookie_name_b for c in jar)
            assert has_cookie_a and has_cookie_b, (
                "Cookie jar must retain both port-partitioned cookies simultaneously without clobbering"
            )
            log_info(f"Cookie jar retains both '{cookie_name_a}' and '{cookie_name_b}'.")

            with opener.open(f"http://127.0.0.1:{port_a}/api/status") as api_a_resp:
                assert api_a_resp.status == 200, "Server A API status must be 200"
                content_a = api_a_resp.read().decode("utf-8")
                assert '"instance":"A"' in content_a, "Server A must identify instance A"
            log_success("Server A API authenticated successfully in presence of Server B cookie.")

            with opener.open(f"http://127.0.0.1:{port_b}/api/status") as api_b_resp:
                assert api_b_resp.status == 200, "Server B API status must be 200"
                content_b = api_b_resp.read().decode("utf-8")
                assert '"instance":"B"' in content_b, "Server B must identify instance B"
            log_success("Server B API authenticated successfully in presence of Server A cookie.")

        # -----------------------------------------------------------------
        # PHASE 4: Token Sanitization Verification
        # -----------------------------------------------------------------
        log_info("--- Phase 4: Token Sanitization Audit ---")
        sample_log_with_secrets = (
            f"Cookie: prebase_session_{port_a}={TOKEN_A}; prebase_session_{port_b}={TOKEN_B}"
        )
        sanitized_output = sanitize(sample_log_with_secrets)
        assert TOKEN_A not in sanitized_output, "Sanitizer leaked TOKEN_A!"
        assert TOKEN_B not in sanitized_output, "Sanitizer leaked TOKEN_B!"
        assert "[REDACTED_SECRET]" in sanitized_output, "Sanitizer did not apply redaction mask"
        log_success("Log sanitization audit passed: zero raw token leaks.")

    except Exception as exc:
        log_fail(f"Test failed with exception: {sanitize(str(exc))}")
        import traceback
        traceback.print_exc()
        return False

    finally:
        log_info("Tearing down local HTTP servers...")
        if server_a:
            server_a.shutdown()
            server_a.server_close()
        if server_b:
            server_b.shutdown()
            server_b.server_close()
        if thread_a:
            thread_a.join(timeout=2.0)
        if thread_b:
            thread_b.join(timeout=2.0)
        log_info("All server resources and ports released cleanly.")

    return True

def main() -> None:
    print("=" * 76)
    print("PreBase Security Test: RFC 6265 §8.5 Cookie Port-Scoping Verification")
    print("=" * 76)

    passed = run_cookie_port_scoping_test()
    if passed:
        log_success("RFC 6265 Section 8.5 Cookie Port-Scoping Verification SUCCEEDED.")
        sys.exit(0)
    else:
        log_fail("RFC 6265 Section 8.5 Cookie Port-Scoping Verification FAILED.")
        sys.exit(1)

if __name__ == "__main__":
    main()
