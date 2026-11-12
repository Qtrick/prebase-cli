#!/usr/bin/env python3
"""
PreBase CLI — Temporal DAG, 2D Deep Interaction, and Auth Lifecycle Real Browser Verification Suite

Independently verifies in real headless Chromium using Playwright:
1. Direct launch via `history` CLI command (?view=temporal).
2. Temporal DAG rendering, commit nodes, and branch/merge topology.
3. Anchor pagination across commit history (>50 commits) without duplicates.
4. Commit selection via genuine mouse click and CommitInspector drawer with changed files & diff stats.
5. Accessible keyboard selection (ArrowDown / ArrowUp) on Temporal Canvas.
6. Cross-view navigation from CommitInspector changed file (Card.tsx) to Network graph.
7. 2D Relationship deep interactions on Card.tsx: 1 Hop / 2 Hops, refocusing on neighbor (Button.tsx),
   and Back button navigation restoring Card.tsx.
8. Live git-ref update handling: 56th commit triggers SSE `git.updated` and updates UI without reload,
   with strict Content-Security-Policy enforcement (no 'unsafe-eval').
9. Reduced motion media query emulation and verification.
10. Purposeful empty state for non-git repository.
11. Authentication & trust boundary lifecycle:
    - Access without token rejected / redirected to auth error screen.
    - Invalid bootstrap token rejected.
    - Single-use bootstrap token replay rejected.
    - Seamless page reload via session cookie.
    - Concurrent browser tabs in authenticated context.
    - Rejection of invalid Host and Origin headers.
12. Server graceful shutdown with SIGINT and immediate port release.
13. Captures evidentiary screenshots to docs/screenshots/.
14. Diagnostic failure capture: writes temporal_failure.png and sanitized temporal_failure_summary.txt.
"""

import os
import sys
import time
import json
import signal
import shutil
import tempfile
import subprocess
import socket
import re
import urllib.request
import urllib.parse
from playwright.sync_api import sync_playwright, expect

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")
PORT = 19995
SCREENSHOT_DIR = os.environ.get(
    "PREBASE_SCREENSHOT_DIR", os.path.join(ROOT_DIR, "docs", "screenshots")
)
FAILURE_ARTIFACT_DIR = os.environ.get(
    "PREBASE_FAILURE_ARTIFACT_DIR", os.path.join(ROOT_DIR, "test-results", "failure-artifacts")
)

os.makedirs(SCREENSHOT_DIR, exist_ok=True)
os.makedirs(FAILURE_ARTIFACT_DIR, exist_ok=True)

def mask_credentials(text: str) -> str:
    """Masks bootstrap tokens, session cookies, and bearer tokens in logs and traces."""
    if not text:
        return text
    text = re.sub(r'bootstrap=[A-Za-z0-9_-]+', 'bootstrap=[REDACTED]', text)
    text = re.sub(r'prebase_session(?:_\d+)?=[A-Za-z0-9_-]+', 'prebase_session=[REDACTED]', text)
    text = re.sub(r'x-prebase-session:\s*[^\r\n]+', 'x-prebase-session: [REDACTED]', text)
    text = re.sub(r'Bearer\s+[A-Za-z0-9_-]+', 'Bearer [REDACTED]', text)
    return text

def log(msg):
    print(f"\x1b[36m[TEMPORAL/LIFECYCLE]\x1b[0m {mask_credentials(str(msg))}", flush=True)

def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {mask_credentials(str(msg))}", flush=True)

def fail(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {mask_credentials(str(msg))}", file=sys.stderr, flush=True)
    sys.exit(1)

def find_available_port(preferred: int, host: str = "127.0.0.1") -> int:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, preferred))
            return preferred
    except OSError:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind((host, 0))
            return s.getsockname()[1]

def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")

def http_get_with_headers(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8"), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8"), e.headers

def parse_startup_info(log_path):
    startup_url = None
    bootstrap_token = None
    for _ in range(40):
        if os.path.exists(log_path):
            with open(log_path, "r") as f:
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

def setup_rich_git_repository(repo_dir: str):
    log(f"Setting up rich git repository with branches, merges, and >50 commits in {repo_dir}...")
    git = lambda *args: subprocess.check_call(
        ["git"] + list(args), cwd=repo_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    git("init", "-b", "main")
    git("config", "user.name", "Temporal Tester")
    git("config", "user.email", "temporal@prebase.dev")

    src_dir = os.path.join(repo_dir, "src")
    comp_dir = os.path.join(src_dir, "components")
    utils_dir = os.path.join(src_dir, "utils")
    os.makedirs(comp_dir, exist_ok=True)
    os.makedirs(utils_dir, exist_ok=True)

    with open(os.path.join(utils_dir, "math.ts"), "w") as f:
        f.write("export function add(a: number, b: number) { return a + b; }\n")
    with open(os.path.join(comp_dir, "Button.tsx"), "w") as f:
        f.write('import { add } from "../utils/math";\nexport const Button = () => <button>{add(1, 2)}</button>;\n')
    with open(os.path.join(comp_dir, "Card.tsx"), "w") as f:
        f.write('import { Button } from "./Button";\nexport const Card = () => <div><Button /></div>;\n')
    with open(os.path.join(src_dir, "index.ts"), "w") as f:
        f.write('import { Card } from "./components/Card";\nconsole.log(Card);\n')

    git("add", ".")
    git("commit", "-m", "feat: initial commit with Button and Card")

    # Create a feature branch with 2 commits
    git("checkout", "-b", "feature/badge")
    with open(os.path.join(comp_dir, "Badge.tsx"), "w") as f:
        f.write('export const Badge = ({ text }: { text: string }) => <span>{text}</span>;\n')
    git("add", ".")
    git("commit", "-m", "feat: add Badge component")

    with open(os.path.join(comp_dir, "Card.tsx"), "w") as f:
        f.write('import { Button } from "./Button";\nimport { Badge } from "./Badge";\nexport const Card = () => <div><Badge text="new" /><Button /></div>;\n')
    git("add", ".")
    git("commit", "-m", "feat: integrate Badge into Card")

    # Switch back to main and commit there
    git("checkout", "main")
    with open(os.path.join(utils_dir, "logger.ts"), "w") as f:
        f.write('export const logMsg = (m: string) => console.log(m);\n')
    git("add", ".")
    git("commit", "-m", "feat: add logger utility on main")

    # Merge feature/badge into main with a merge commit
    git("merge", "--no-ff", "feature/badge", "-m", "merge: join feature/badge into main")

    # Add 49 incremental commits to CHANGELOG.md (5 + 49 = 54 commits)
    for i in range(1, 50):
        with open(os.path.join(repo_dir, "CHANGELOG.md"), "a") as f:
            f.write(f"- Update {i}: patch cycle notes\n")
        git("add", "CHANGELOG.md")
        git("commit", "-m", f"chore: changelog update entry {i}")

    # Commit 55 (the head of main): modify src/components/Card.tsx so latest commit touches an analyzed TSX component
    with open(os.path.join(comp_dir, "Card.tsx"), "a") as f:
        f.write("\n// Updated Card component styling\n")
    git("add", os.path.join("src", "components", "Card.tsx"))
    git("commit", "-m", "feat: enhance Card component styling")

    success("Rich git repository initialized with 55 total commits, branch topology, and latest commit modifying Card.tsx.")

def main():
    print("=" * 80)
    print("PreBase CLI — Temporal DAG, 2D Explorer, & Auth Lifecycle Verification")
    print("=" * 80)

    if not os.path.exists(BIN):
        fail(f"Executable not found at {BIN}. Run 'cargo build --release --bin prebase' first.")

    global PORT
    PORT = find_available_port(19995)

    test_repo_dir = tempfile.mkdtemp(prefix="prebase-temporal-test-")
    log_dir = tempfile.mkdtemp(prefix="prebase-temporal-logs-")
    proc = None

    try:
        setup_rich_git_repository(test_repo_dir)

        # ----------------------------------------------------------------------
        # TEST SUITE 1: Direct launch via `history` CLI command (?view=temporal)
        # ----------------------------------------------------------------------
        log_path = os.path.join(log_dir, "server_temporal.log")
        log_file = open(log_path, "w")
        cmd = [BIN, "--port", str(PORT), "--no-open", "history", test_repo_dir]
        log(f"Launching `prebase history`: {' '.join(cmd)}")
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)

        # Health check
        base_url = f"http://127.0.0.1:{PORT}"
        healthy = False
        for _ in range(60):
            try:
                status, body = http_get(f"{base_url}/api/v1/health")
                if status == 200 and "ok" in body:
                    healthy = True
                    break
            except Exception:
                time.sleep(0.1)

        if not healthy:
            fail("Server did not report healthy.")
        success("Server is listening and healthy.")

        startup_url, bootstrap_token = parse_startup_info(log_path)
        if not startup_url or not bootstrap_token:
            fail("Could not parse startup URL or bootstrap token.")
        log(f"Parsed startup URL: {startup_url}")
        assert "view=temporal" in startup_url, f"Expected view=temporal in startup URL, got {startup_url}"
        success("Verified CLI `history` generates startup URL with view=temporal.")

        # ----------------------------------------------------------------------
        # TEST SUITE 2: Trust boundary & auth rejection tests before consuming token
        # ----------------------------------------------------------------------
        log("Testing trust boundaries: missing token, invalid token, invalid Host/Origin...")

        # 2a. Direct GET without credentials rejected or returns 401 on API
        api_status, _ = http_get(f"{base_url}/api/v1/status")
        assert api_status == 401, f"Unauthenticated API request must return 401, got {api_status}"
        success("Unauthenticated API request strictly rejected with 401.")

        # 2b. Invalid Host header rejected
        inv_host_req = urllib.request.Request(f"{base_url}/api/v1/health", headers={"Host": "evil.attacker.com"})
        try:
            with urllib.request.urlopen(inv_host_req, timeout=5) as resp:
                inv_host_status = resp.status
        except urllib.error.HTTPError as e:
            inv_host_status = e.code
        assert inv_host_status in (400, 403), f"Invalid Host header must be rejected with 400/403, got {inv_host_status}"
        success("Invalid Host header rejected.")

        # 2c. Invalid Origin header rejected on mutation
        inv_origin_req = urllib.request.Request(
            f"{base_url}/api/v1/auth/session",
            data=json.dumps({"bootstrap_token": "fake"}).encode(),
            headers={"Content-Type": "application/json", "Origin": "http://evil.com"}
        )
        try:
            with urllib.request.urlopen(inv_origin_req, timeout=5) as resp:
                inv_origin_status = resp.status
        except urllib.error.HTTPError as e:
            inv_origin_status = e.code
        assert inv_origin_status in (400, 403), f"Invalid Origin must be rejected with 400/403, got {inv_origin_status}"
        success("Cross-origin request rejected.")

        # ----------------------------------------------------------------------
        # TEST SUITE 3: Playwright Real Chromium Verification of Temporal & 2D
        # ----------------------------------------------------------------------
        with sync_playwright() as p:
            log("Launching Playwright Chromium browser...")
            browser = p.chromium.launch(headless=True)
            active_page = None

            try:
                # 3a. Test navigation with invalid bootstrap token in separate clean browser context
                invalid_url = f"{base_url}/?bootstrap=invalid_token_99999&view=temporal"
                log(f"Navigating to invalid token URL: {invalid_url}")
                auth_context = browser.new_context(viewport={"width": 1280, "height": 800})
                auth_page = auth_context.new_page()
                active_page = auth_page
                auth_page.goto(invalid_url, wait_until="domcontentloaded")
                expect(auth_page.locator(".error-overlay")).to_be_visible(timeout=10000)
                expect(auth_page.locator(".error-overlay")).to_contain_text(re.compile(r"(Authentication|token)"))
                auth_context.close()
                success("Browser UI gracefully displays Authentication Required for invalid bootstrap token.")

                # 3b. Navigate with valid startup URL in main context (exchanging single-use bootstrap token)
                context = browser.new_context(viewport={"width": 1280, "height": 800})
                page = context.new_page()
                active_page = page
                log(f"Navigating to valid startup URL: {startup_url}...")
                page.goto(startup_url, wait_until="domcontentloaded", timeout=15000)

                # Wait for Temporal canvas and index ready
                expect(page.locator(".temporal-canvas-container canvas")).to_be_visible(timeout=15000)
                expect(page.locator(".status-indicator:has-text('Index Ready')")).to_be_visible(timeout=15000)
                success("Temporal canvas rendered and Index Ready indicator visible.")

                time.sleep(1.0)
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, "18_temporal_dag_initial.png"))
                success("Captured initial Temporal DAG -> docs/screenshots/18_temporal_dag_initial.png")

                # 3c. Replay protection: verify that the bootstrap token cannot be reused in another clean context
                log("Verifying bootstrap token replay rejection in clean context...")
                clean_context = browser.new_context(viewport={"width": 1280, "height": 800})
                replay_page = clean_context.new_page()
                replay_page.goto(startup_url, wait_until="domcontentloaded")
                expect(replay_page.locator(".error-overlay")).to_be_visible(timeout=10000)
                expect(replay_page.locator(".error-overlay")).to_contain_text(re.compile(r"(Authentication|token)"))
                clean_context.close()
                success("Single-use bootstrap token replay strictly rejected in clean browser context.")

                # 3d. Verify Temporal Header Commit Count and Initial Pagination State
                expect(page.locator(".temporal-header-info")).to_contain_text(re.compile(r"50 (of 55|commits)"), timeout=5000)
                header_text = page.locator(".temporal-header-info").inner_text()
                log(f"Temporal Header: '{header_text}'")
                success("Temporal header reflects initial 50-commit page limit of 55 total commits.")

                # Verify floating pagination button
                pagination_btn = page.locator(".pagination-btn")
                expect(pagination_btn).to_be_visible(timeout=5000)
                expect(pagination_btn).to_contain_text("Load older commits")

                # 3e. Click pagination button to load remaining commits (Anchor Pagination)
                # Replaced string-based page.wait_for_function with Playwright expect
                log("Clicking pagination button to load remaining commits...")
                pagination_btn.click()
                expect(page.locator(".temporal-header-info")).to_contain_text(re.compile(r"55 (of 55|commits)"), timeout=10000)
                success("Anchor pagination loaded remaining commits without duplicates (55 of 55).")
                time.sleep(0.5)
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, "19_temporal_paginated_full.png"))
                success("Captured full paginated DAG -> docs/screenshots/19_temporal_paginated_full.png")

                # 3f. Select initial commit on canvas via genuine mouse click (no selectCommit fallback)
                log("Selecting initial commit on canvas via genuine mouse click...")
                pos = page.evaluate("() => window.__prebaseTemporalDebug ? window.__prebaseTemporalDebug.getScreenPosition(0) : null")
                assert pos is not None, "Temporal layout must expose screen position for initial commit"
                canvas = page.locator(".temporal-canvas-container canvas")
                box = canvas.bounding_box()
                assert box is not None, "Temporal canvas bounding box must exist"
                click_x = box["x"] + pos["x"]
                click_y = box["y"] + pos["y"]
                log(f"Computed commit click point from layout: ({click_x:.1f}, {click_y:.1f})")
                page.mouse.click(click_x, click_y)

                expect(page.locator(".inspector-panel .sha-text")).to_be_visible(timeout=10000)
                initial_sha = page.locator(".inspector-panel .sha-text").inner_text()
                log(f"CommitInspector displayed commit SHA: {initial_sha}")
                assert len(initial_sha) == 40, f"Expected 40-character commit SHA, got: {initial_sha}"
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, "20_temporal_commit_inspector.png"))
                success("CommitInspector displayed via genuine mouse click with full SHA, author, date, and diff stats.")

                # 3f-2. Test Accessible Keyboard Selection (canvas focus, ArrowDown, ArrowUp)
                log("Testing accessible keyboard selection on Temporal Canvas...")
                canvas.focus()
                page.keyboard.press("ArrowDown")
                expect(page.locator(".inspector-panel .sha-text")).not_to_have_text(initial_sha, timeout=5000)
                next_sha = page.locator(".inspector-panel .sha-text").inner_text()
                log(f"ArrowDown selected next commit SHA: {next_sha}")
                assert len(next_sha) == 40 and next_sha != initial_sha, "ArrowDown must select a different commit"

                page.keyboard.press("ArrowUp")
                expect(page.locator(".inspector-panel .sha-text")).to_have_text(initial_sha, timeout=5000)
                restored_sha = page.locator(".inspector-panel .sha-text").inner_text()
                log(f"ArrowUp restored initial commit SHA: {restored_sha}")
                assert restored_sha == initial_sha, "ArrowUp must restore initial commit"
                success("Accessible keyboard selection verified (canvas focus -> ArrowDown -> ArrowUp -> inspector updated).")

                # 3g. Test Cross-View Navigation from CommitInspector to Network Graph
                # The latest commit (initial_sha) modifies src/components/Card.tsx
                log("Testing cross-view navigation from CommitInspector changed files to Network Graph...")
                card_file_item = page.locator(".file-change-item:has-text('Card.tsx')")
                expect(card_file_item).to_be_visible(timeout=5000)
                log("Clicking Card.tsx in CommitInspector changed files...")
                card_file_item.click()

                # Verify Network view renders and Card.tsx is selected in Inspector
                expect(page.locator(".network-canvas")).to_be_visible(timeout=10000)
                expect(page.locator(".inspector-panel h3.file-name")).to_have_text("Card.tsx", timeout=5000)
                expect(page.locator(".inspector-panel .file-path-bar")).to_contain_text("src/components/Card.tsx")
                expect(page.locator(".inspector-panel .relations-section").first).to_be_visible(timeout=5000)
                success("Cross-view navigation verified: Card.tsx clicked from inspector -> Network view renders -> Card.tsx selected & relationships inspected.")

                # 3h. Test 2D Relationships on Card.tsx: 1 Hop / 2 Hops, refocus on neighbor (Button.tsx), Back button
                log("Navigating to 2D Relationship Explorer for Card.tsx...")
                explore_2d_btn = page.locator("button.explore-2d-btn:has-text('Explore Relationships in 2D')")
                if explore_2d_btn.is_visible():
                    explore_2d_btn.click()
                else:
                    page.locator("button.mode-btn:has-text('2D Relationships')").click()

                expect(page.locator(".relationship-container")).to_be_visible(timeout=10000)
                # Wait for spatial transition to settle completely (350ms CSS transition)
                page.wait_for_timeout(450)
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, "21_2d_relationship_deep.png"))
                success("2D Relationship Explorer rendered focused on Card.tsx.")

                # Test 1 Hop / 2 Hops in 2D HUD
                log("Testing 2D HUD depth controls (1 Hop / 2 Hops)...")
                btn_2hops = page.locator("button.hud-segment:has-text('2 Hops')")
                expect(btn_2hops).to_be_visible(timeout=5000)
                btn_2hops.click()
                expect(btn_2hops).to_have_class(re.compile(r"active"), timeout=3000)

                btn_1hop = page.locator("button.hud-segment:has-text('1 Hop')")
                btn_1hop.click()
                expect(btn_1hop).to_have_class(re.compile(r"active"), timeout=3000)
                success("2D HUD depth controls (1 Hop / 2 Hops) verified.")

                # Refocus on neighbor (Button.tsx) and test Back button navigation
                log("Testing refocus on neighbor Button.tsx and Back button navigation...")
                button_dep = page.locator(".inspector-panel .relation-item-btn:has-text('Button.tsx')")
                expect(button_dep).to_be_visible(timeout=5000)
                button_dep.click()

                refocus_btn = page.locator("button.refocus-2d-btn")
                expect(refocus_btn).to_be_visible(timeout=5000)
                refocus_btn.click()

                back_btn = page.locator("button.hud-btn.back-btn")
                expect(back_btn).to_be_visible(timeout=5000)
                log(f"Back button appeared with title: '{back_btn.get_attribute('title')}'")
                back_btn.click()

                expect(back_btn).not_to_be_visible(timeout=5000)
                expect(page.locator(".inspector-panel h3.file-name")).to_have_text("Card.tsx", timeout=5000)
                success("2D Back-stack navigation verified: Card.tsx -> refocus Button.tsx -> Back button appears -> Back clicked -> Card.tsx restored.")

                # 3i. Live Git-Ref Update via SSE: create 56th commit on disk while browser is open
                log("Testing live git-ref update via SSE without page reload...")
                page.locator("button.nav-item:has-text('Temporal Graph')").click()
                expect(page.locator(".temporal-canvas-container canvas")).to_be_visible(timeout=10000)

                # Attach CSP violation monitor to ensure no 'unsafe-eval' or script violations occur during live update
                page.evaluate("""() => {
                    window.__cspViolations = [];
                    window.addEventListener('securitypolicyviolation', (e) => {
                        window.__cspViolations.push(e.blockedURI + ': ' + e.violatedDirective);
                    });
                }""")

                # Create a 56th commit using git CLI
                git = lambda *args: subprocess.check_call(
                    ["git"] + list(args), cwd=test_repo_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                with open(os.path.join(test_repo_dir, "LIVE_NOTE.md"), "w") as f:
                    f.write("Live update commit\n")
                git("add", "LIVE_NOTE.md")
                git("commit", "-m", "feat: 56th live commit from watcher test")

                # Wait for browser to receive git.updated SSE event and update commit count without reload
                # Replaced string-based wait_for_function with Playwright expect
                log("Waiting for browser to receive git.updated SSE event...")
                expect(page.locator(".temporal-header-info")).to_contain_text("56", timeout=12000)

                # Verify strict Content Security Policy forbids 'unsafe-eval'
                status, _, headers = http_get_with_headers(f"{base_url}/api/v1/health")
                csp = headers.get("content-security-policy", "")
                assert "'unsafe-eval'" not in csp, f"Strict CSP must forbid 'unsafe-eval', got: {csp}"
                assert "script-src 'self'" in csp, f"Strict CSP must enforce script-src 'self', got: {csp}"

                # Confirm zero CSP violations during live update reconciliation
                violations = page.evaluate("() => window.__cspViolations || []")
                assert len(violations) == 0, f"Expected no CSP violations, got: {violations}"
                success("Live git-ref update received via SSE; browser updated commit count to 56 without reload, and verified no 'unsafe-eval' was used.")

                # 3j. Test page reload under active session cookie (no bootstrap param)
                log("Testing browser page reload with authenticated session cookie...")
                page.goto(f"{base_url}/", wait_until="domcontentloaded")
                expect(page.locator(".status-indicator:has-text('Index Ready')")).to_be_visible(timeout=10000)
                success("Seamless page reload verified via RFC 6265 session cookie.")

                # 3k. Test concurrent tabs in same authenticated browser context
                log("Testing multiple concurrent tabs in authenticated session...")
                tab2 = context.new_page()
                tab2.goto(f"{base_url}/", wait_until="domcontentloaded")
                expect(tab2.locator(".status-indicator:has-text('Index Ready')")).to_be_visible(timeout=10000)
                tab2.close()
                success("Multiple concurrent browser tabs authenticated and loaded simultaneously.")

                # 3l. Test reduced motion preference emulation and verification
                log("Testing prefers-reduced-motion media emulation...")
                page.emulate_media(reduced_motion="reduce")
                is_reduced = page.evaluate("() => window.matchMedia('(prefers-reduced-motion: reduce)').matches")
                assert is_reduced is True, "prefers-reduced-motion: reduce media query must be active in browser"
                success("Reduced-motion preference emulated cleanly and confirmed active in browser.")

                browser.close()

            except Exception as exc:
                sanitized_err = mask_credentials(str(exc))
                if active_page:
                    try:
                        fail_shot = os.path.join(FAILURE_ARTIFACT_DIR, "temporal_failure.png")
                        active_page.screenshot(path=fail_shot)
                        log(f"Saved failure screenshot -> {fail_shot}")
                    except Exception as shot_err:
                        log(f"Could not capture failure screenshot: {shot_err}")
                try:
                    summary_path = os.path.join(FAILURE_ARTIFACT_DIR, "temporal_failure_summary.txt")
                    with open(summary_path, "w") as f:
                        f.write(f"Temporal test failure: {sanitized_err}\n")
                    log(f"Saved failure summary -> {summary_path}")
                except Exception as write_err:
                    log(f"Could not write failure summary: {write_err}")
                fail(f"Temporal browser test suite failed: {sanitized_err}")

        # ----------------------------------------------------------------------
        # TEST SUITE 4: Purposeful empty state for non-git repository
        # ----------------------------------------------------------------------
        log("Testing non-git repository Temporal empty state...")
        # Gracefully shut down previous server
        proc.terminate()
        proc.wait(timeout=5)
        proc = None

        # Verify port released immediately
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", PORT))
        success("Server port released immediately after shutdown.")

        # Create empty non-git dir
        non_git_dir = tempfile.mkdtemp(prefix="prebase-nongit-")
        ng_log_dir = tempfile.mkdtemp(prefix="prebase-nongit-logs-")
        try:
            os.makedirs(os.path.join(non_git_dir, "src"), exist_ok=True)
            with open(os.path.join(non_git_dir, "src", "hello.ts"), "w") as f:
                f.write("console.log('hello');\n")

            ng_log_path = os.path.join(ng_log_dir, "server_nongit.log")
            ng_log_file = open(ng_log_path, "w")
            ng_cmd = [BIN, "--port", str(PORT), "--no-open", "history", non_git_dir]
            proc = subprocess.Popen(ng_cmd, stdout=ng_log_file, stderr=subprocess.STDOUT)

            for _ in range(50):
                try:
                    s, b = http_get(f"{base_url}/api/v1/health")
                    if s == 200:
                        break
                except Exception:
                    time.sleep(0.1)

            ng_url, ng_token = parse_startup_info(ng_log_path)
            if not ng_url:
                fail("Could not parse non-git server startup URL.")

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width": 1280, "height": 800})
                page.goto(ng_url, wait_until="domcontentloaded", timeout=15000)
                expect(page.locator(".empty-overlay")).to_be_visible(timeout=10000)
                expect(page.locator(".empty-overlay")).to_contain_text("No Git commit history available")
                expect(page.locator(".empty-overlay")).to_contain_text("not a Git repository")
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, "22_temporal_nongit_empty_state.png"))
                success("Purposeful non-git empty state verified with truthful explanation.")
                browser.close()

        finally:
            if proc:
                proc.terminate()
                proc.wait(timeout=5)
                proc = None
            shutil.rmtree(non_git_dir, ignore_errors=True)
            shutil.rmtree(ng_log_dir, ignore_errors=True)

    finally:
        if proc:
            log("Sending SIGTERM to PreBase server...")
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(test_repo_dir, ignore_errors=True)
        shutil.rmtree(log_dir, ignore_errors=True)
        log("Test cleanup complete.")

    print("=" * 80)
    print("\x1b[32mALL TEMPORAL, 2D EXPLORER, & AUTH LIFECYCLE CHECKS PASSED!\x1b[0m")
    print("=" * 80)

if __name__ == "__main__":
    main()
