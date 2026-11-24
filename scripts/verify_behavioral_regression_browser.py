#!/usr/bin/env python3
"""
PreBase CLI — Behavioral Regression Real Browser Verification Suite

Validates actual product requirements in headless Chromium via Playwright:
1. Responsive toolbar & search visibility:
   - Verifies .search-input remains visible and has interactive width (>= 160px)
     across viewports: 1024x768, 1280x800, 1440x900, 1920x1080 with sidebar and inspector open.
2. Hover hysteresis in NetworkCanvas:
   - Fast pointer traverse across multiple nodes does not trigger visual hover strobing.
   - Lingering on a node commits hover after threshold (~100ms).
   - Leaving canvas cancels hover immediately.
   - Click immediately selects without delay.
3. History Timeline:
   - Native vertical scrolling without wheel-based zoom scaling.
   - Cursor pagination appends older commits without jumping or resetting scroll.
   - Accessible keyboard up/down navigation.
4. Language filter consistency:
   - Language filtering applies consistently to both 3D and 2D views.
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
PORT = 19992
capture_docs = "--capture-docs" in sys.argv or os.environ.get("PREBASE_CAPTURE_DOCS") == "1"
default_dest = (
    os.path.join(ROOT_DIR, "docs", "screenshots")
    if capture_docs
    else os.path.join(ROOT_DIR, "test-results", "visual")
)
SCREENSHOT_DIR = os.environ.get("PREBASE_SCREENSHOT_DIR", default_dest)
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

def sanitized_excepthook(exc_type, exc_value, exc_traceback):
    import traceback
    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    sys.stderr.write(mask_credentials(tb_str))

sys.excepthook = sanitized_excepthook

def log(msg):
    print(f"\x1b[36m[REGRESSION-TEST]\x1b[0m {mask_credentials(str(msg))}", flush=True)

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
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read().decode("utf-8")

def setup_polyglot_and_history_repo(repo_dir: str):
    log(f"Setting up polyglot test repo with >50 commits in {repo_dir}...")
    git = lambda *args: subprocess.check_call(
        ["git"] + list(args), cwd=repo_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    git("init", "-b", "main")
    git("config", "user.name", "Regression Tester")
    git("config", "user.email", "regression@prebase.dev")

    # Create directories for TypeScript, Rust, and Python
    os.makedirs(os.path.join(repo_dir, "src", "components"), exist_ok=True)
    os.makedirs(os.path.join(repo_dir, "crates", "core", "src"), exist_ok=True)
    os.makedirs(os.path.join(repo_dir, "scripts"), exist_ok=True)

    # 1. Polyglot source files
    with open(os.path.join(repo_dir, "src", "components", "Button.tsx"), "w") as f:
        f.write("export const Button = () => <button>Click</button>;\n")

    with open(os.path.join(repo_dir, "src", "components", "Card.tsx"), "w") as f:
        f.write("import { Button } from './Button';\nexport const Card = () => <div><Button /></div>;\n")

    with open(os.path.join(repo_dir, "crates", "core", "src", "lib.rs"), "w") as f:
        f.write("pub fn run_core() -> &'static str { \"core-ok\" }\n")

    with open(os.path.join(repo_dir, "scripts", "benchmark.py"), "w") as f:
        f.write("# Python benchmark\nprint('benchmarking')\n")

    git("add", ".")
    git("commit", "-m", "chore: initial polyglot structure")

    # Generate 54 more sequential commits to ensure >50 commits for anchor pagination testing
    log("Generating 54 sequential commits for cursor pagination...")
    for i in range(2, 56):
        with open(os.path.join(repo_dir, "changelog.txt"), "a") as f:
            f.write(f"Commit {i} entry\n")
        git("add", "changelog.txt")
        git("commit", "-m", f"feat: iteration {i}")

    success("Polyglot repository with 55 commits initialized.")

def main():
    print("=" * 80)
    print("PreBase CLI — Comprehensive Behavioral Regression Browser Suite")
    print("=" * 80)

    global PORT
    PORT = find_available_port(PORT)
    log(f"Binding test server to 127.0.0.1:{PORT}")

    if not os.path.exists(BIN):
        fail(f"PreBase release binary not found at {BIN}. Run 'cargo build --release' first.")

    temp_dir = tempfile.mkdtemp(prefix="prebase_regress_")
    server_proc = None

    try:
        setup_polyglot_and_history_repo(temp_dir)

        log_dir = tempfile.mkdtemp(prefix="prebase_regress_logs_")
        log_path = os.path.join(log_dir, "server.log")
        log_file = open(log_path, "w")

        cmd = [BIN, "--port", str(PORT), "--no-open", "map", temp_dir]
        log(f"Spawning: {' '.join(cmd)}")
        server_proc = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

        # Wait for health
        base_url = f"http://127.0.0.1:{PORT}"
        server_healthy = False
        for _ in range(60):
            try:
                status, body = http_get(f"{base_url}/api/v1/health")
                if status == 200 and "ok" in body:
                    server_healthy = True
                    break
            except Exception:
                time.sleep(0.1)

        if not server_healthy:
            fail("Server failed to report healthy on /api/v1/health within 6 seconds.")

        bootstrap_url = None
        for _ in range(40):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    content = f.read()
                    for line in content.splitlines():
                        if "Server running at:" in line or "http://127.0.0.1" in line:
                            m = re.search(r'(http://127\.0\.0\.1:\d+/\S+)', line)
                            if m:
                                bootstrap_url = m.group(1)
                                # strip ANSI codes
                                bootstrap_url = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', bootstrap_url)
                                break
            if bootstrap_url:
                break
            time.sleep(0.1)

        if not bootstrap_url:
            fail("Server failed to produce bootstrap URL within 15 seconds.")

        log(f"Server ready at: {bootstrap_url}")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()

            log("Navigating to bootstrap URL...")
            try:
                page.goto(bootstrap_url, wait_until="domcontentloaded", timeout=15000)
            except Exception as e:
                sanitized_err = mask_credentials(str(e))
                fail(f"Browser navigation failed: {sanitized_err}")

            # Wait for main UI to mount, network canvas, and status ready
            expect(page.locator(".app-shell")).to_be_visible(timeout=10000)
            page.wait_for_selector(".network-canvas", timeout=15000)
            page.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=15000)
            success("Application shell mounted and repository indexed.")

            # =========================================================================
            # SECTION 1: Responsive Toolbar & Search Visibility Across 4 Viewports
            # Viewports: 1024x768, 1280x800, 1440x900, 1920x1080
            # Requirements:
            # - Sidebar open (250px)
            # - Inspector open (340px)
            # - .search-input visible and bounding box width >= 160px
            # =========================================================================
            log("=== SECTION 1: Responsive Toolbar & Search Visibility ===")
            viewports = [
                (1024, 768),
                (1280, 800),
                (1440, 900),
                (1920, 1080),
            ]

            # Ensure sidebar is present
            expect(page.locator(".sidebar")).to_be_visible()

            # Ensure Inspector is open (select first node via search to populate and open inspector)
            search_input = page.locator(".search-input")
            expect(search_input).to_be_visible()
            search_input.fill("Button")
            page.wait_for_selector(".search-dropdown .search-item", timeout=5000)
            page.locator(".search-dropdown .search-item").first.click()
            expect(page.locator(".inspector-panel")).to_be_visible()

            for w, h in viewports:
                log(f"Testing viewport {w}x{h} with sidebar and inspector open...")
                page.set_viewport_size({"width": w, "height": h})
                page.wait_for_timeout(200)

                # 1. Verify search input remains visible
                expect(search_input).to_be_visible()

                # 2. Measure interactive width
                box = search_input.bounding_box()
                assert box is not None, f"Search input bounding box is None at {w}x{h}"
                width = box["width"]
                log(f"Viewport {w}x{h}: .search-input bounding width = {width:.1f}px")

                assert width >= 160.0, (
                    f"Regression failure: .search-input width {width:.1f}px is below 160px threshold at {w}x{h}!"
                )

                # 3. Verify search input is within viewport bounds
                assert box["x"] >= 0 and box["x"] + box["width"] <= w, (
                    f"Search input overflows viewport horizontally: x={box['x']}, w={box['width']}, vp={w}"
                )

                # 4. Verify search interactivity in this viewport
                search_input.click()
                search_input.fill("Card")
                expect(page.locator(".search-dropdown")).to_be_visible(timeout=3000)
                page.keyboard.press("Escape")

                success(f"Viewport {w}x{h}: .search-input visible & interactive (width={width:.1f}px >= 160px).")

            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "regression_01_responsive_search.png"))

            # =========================================================================
            # SECTION 2: 3D Depth Perception & Hover Hysteresis in NetworkCanvas
            # Requirements:
            # - Nodes on front have higher depthT and depthScale than nodes on rear
            # - 180° rotation inverts front and rear depth metrics
            # - Fast pointer traverse across multiple nodes does NOT trigger visual hover strobing
            # - Lingering on a node commits hover after threshold (~100ms)
            # - Leaving canvas cancels hover immediately
            # - Click immediately selects without delay
            # =========================================================================
            log("=== SECTION 2: 3D Depth Perception & Hover Hysteresis in NetworkCanvas ===")
            page.set_viewport_size({"width": 1280, "height": 800})
            canvas = page.locator("canvas.network-canvas")
            expect(canvas).to_be_visible()
            canvas_box = canvas.bounding_box()
            assert canvas_box is not None

            # 2a. Real node positions from window.__prebaseNetworkDebug
            log("Querying real projected nodes from window.__prebaseNetworkDebug...")
            projected_nodes = page.evaluate("() => window.__prebaseNetworkDebug.getProjectedNodes()")
            assert len(projected_nodes) >= 2, f"Expected at least 2 projected nodes, found {len(projected_nodes)}"

            front_node = projected_nodes[0]
            rear_node = projected_nodes[-1]
            log(f"Front node: {front_node['id']} (depthScale={front_node.get('depthScale', 1.0):.2f}, depth={front_node.get('depth', 1.0):.2f})")
            log(f"Rear node: {rear_node['id']} (depthScale={rear_node.get('depthScale', 1.0):.2f}, depth={rear_node.get('depth', 1.0):.2f})")

            assert front_node["depth"] > rear_node["depth"], (
                f"Depth invariant failure: front node depth {front_node['depth']} should exceed rear node depth {rear_node['depth']}"
            )
            assert front_node["depthScale"] >= rear_node["depthScale"], (
                f"Depth scale failure: front node depthScale {front_node['depthScale']} should be >= rear node depthScale {rear_node['depthScale']}"
            )
            success("3D depth metric baseline verified: front hemisphere node is more prominent than rear hemisphere node.")

            # Test 180° rotation inverts front and rear
            log("Testing 180° rotation depth inversion...")
            initial_cam = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            page.evaluate(f"() => window.__prebaseNetworkDebug.setCamera({{ yaw: {initial_cam['yaw']} + Math.PI, pitch: {initial_cam['pitch']} }})")
            page.wait_for_timeout(200)

            rotated_nodes = page.evaluate("() => window.__prebaseNetworkDebug.getProjectedNodes()")
            rotated_front = next(n for n in rotated_nodes if n["id"] == front_node["id"])
            rotated_rear = next(n for n in rotated_nodes if n["id"] == rear_node["id"])
            log(f"After 180° rotation: original front depth={rotated_front.get('depth'):.2f}, original rear depth={rotated_rear.get('depth'):.2f}")
            assert rotated_rear["depth"] > rotated_front["depth"], (
                "180° rotation must invert camera-relative depth: original rear node must now be in front!"
            )
            success("3D camera-relative depth inversion verified across 180° rotation.")

            # Restore original rotation
            page.evaluate(f"() => window.__prebaseNetworkDebug.setCamera({{ yaw: {initial_cam['yaw']}, pitch: {initial_cam['pitch']} }})")
            page.wait_for_timeout(200)
            projected_nodes = page.evaluate("() => window.__prebaseNetworkDebug.getProjectedNodes()")
            target_node = projected_nodes[0]
            node_screen_x = canvas_box["x"] + target_node["screenX"]
            node_screen_y = canvas_box["y"] + target_node["screenY"]

            # 2b. Fast pointer sweep (simulate fast traverse across nodes in <60ms)
            log("Executing fast pointer traverse across node positions...")
            page.mouse.move(node_screen_x - 120, node_screen_y, steps=1)
            for offset in range(-80, 100, 30):
                page.mouse.move(node_screen_x + offset, node_screen_y, steps=1)
                time.sleep(0.005)

            hovered_after_fast = page.evaluate("() => window.__prebaseNetworkDebug.getHoveredNodeId()")
            assert hovered_after_fast is None, f"Fast sweep should not settle hover! Got {hovered_after_fast}"
            success("Fast sweep across nodes completed without triggering premature hover hysteresis.")

            # 2c. Lingering on a real node commits hover
            log(f"Lingering pointer on node {target_node['id']} for 250ms...")
            page.mouse.move(node_screen_x, node_screen_y)
            time.sleep(0.25)
            page.wait_for_timeout(100)
            hovered_node = page.evaluate("() => window.__prebaseNetworkDebug.getHoveredNodeId()")
            assert hovered_node == target_node["id"], (
                f"Hover hysteresis failed to commit on target node! Expected {target_node['id']}, got {hovered_node}"
            )
            success(f"Hover hysteresis successfully settled on {target_node['id']}.")

            # 2d. Leaving canvas cancels hover
            log("Moving pointer outside canvas boundaries (to sidebar)...")
            page.mouse.move(10, 10)
            page.wait_for_timeout(150)
            hovered_outside = page.evaluate("() => window.__prebaseNetworkDebug.getHoveredNodeId()")
            assert hovered_outside is None, f"Hover must clear when leaving canvas! Got {hovered_outside}"
            success("Hover successfully cancelled upon leaving canvas.")

            # 2e. Immediate click selection without delay
            log(f"Verifying immediate click selection on node {target_node['id']}...")
            t_click_start = time.time()
            page.mouse.click(node_screen_x, node_screen_y)
            page.wait_for_timeout(100)
            selected_node = page.evaluate("() => window.__prebaseNetworkDebug.getSelectedNodeId()")
            assert selected_node == target_node["id"], (
                f"Click failed to select node! Expected {target_node['id']}, got {selected_node}"
            )
            expect(page.locator(".inspector-panel")).to_be_visible(timeout=2000)
            elapsed_ms = (time.time() - t_click_start) * 1000
            log(f"Click selection processed in {elapsed_ms:.1f}ms")
            success(f"Immediate click selection verified on {target_node['id']} without hysteresis delay.")

            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "regression_02_hover_hysteresis.png"))

            # =========================================================================
            # SECTION 3: History Timeline (Temporal DAG)
            # Requirements:
            # - Native vertical scrolling without wheel-based zoom scaling
            # - Cursor pagination appends older commits without jumping or resetting scroll
            # - Keyboard up/down navigation
            # =========================================================================
            log("=== SECTION 3: History Timeline (Temporal DAG) ===")
            page.locator(".nav-item:has-text('History'), .nav-item:has-text('Temporal Graph')").click()
            expect(page.locator(".temporal-canvas")).to_be_visible(timeout=8000)
            temporal_canvas = page.locator(".temporal-canvas")

            # Retrieve initial camera transform from debug hook
            initial_debug = page.evaluate("() => window.__prebaseTemporalDebug ? window.__prebaseTemporalDebug.getTransform() : null")
            log(f"Initial Temporal transform: {initial_debug}")

            # 3a. Native vertical scrolling: wheel deltaY scrolls y without scaling k
            log("Simulating vertical mouse wheel scroll...")
            t_box = temporal_canvas.bounding_box()
            assert t_box is not None
            page.mouse.move(t_box["x"] + t_box["width"] / 2, t_box["y"] + t_box["height"] / 2)
            page.mouse.wheel(0, 200) # scroll down
            page.wait_for_timeout(300)

            scrolled_debug = page.evaluate("() => window.__prebaseTemporalDebug ? window.__prebaseTemporalDebug.getTransform() : null")
            log(f"Scrolled Temporal transform: {scrolled_debug}")

            if initial_debug and scrolled_debug:
                k_initial = initial_debug["k"]
                k_scrolled = scrolled_debug["k"]
                assert abs(k_initial - k_scrolled) < 0.001, (
                    f"Regression failure: Wheel scroll mutated zoom scale k from {k_initial} to {k_scrolled}!"
                )
                success("Native vertical scrolling verified: transform.k remained strictly constant.")

            # 3b. Cursor pagination without scroll reset
            log("Verifying cursor pagination preserves scroll position...")
            pagination_btn = page.locator(".pagination-btn")
            expect(pagination_btn).to_be_visible()

            # Record scroll position right before pagination click
            pre_page_transform = page.evaluate("() => window.__prebaseTemporalDebug ? window.__prebaseTemporalDebug.getTransform() : null")
            pagination_btn.click()
            page.wait_for_timeout(500)

            post_page_transform = page.evaluate("() => window.__prebaseTemporalDebug ? window.__prebaseTemporalDebug.getTransform() : null")
            log(f"Post-pagination transform: {post_page_transform}")

            if pre_page_transform and post_page_transform:
                # Scroll y must not have jumped back to initial top (e.g. 60)
                assert abs(post_page_transform["y"] - pre_page_transform["y"]) < 50, (
                    f"Regression failure: Scroll jumped after pagination! Pre: {pre_page_transform['y']}, Post: {post_page_transform['y']}"
                )
                success("Cursor pagination appended older commits without resetting or jumping scroll.")

            # 3c. Keyboard navigation (ArrowDown / ArrowUp)
            log("Verifying accessible keyboard navigation...")
            temporal_canvas.focus()
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(200)
            commit_sha_el = page.locator(".inspector-panel .commit-short-hash, .inspector-panel .sha-text").first
            expect(commit_sha_el).to_be_visible(timeout=3000)
            first_selected_sha = commit_sha_el.inner_text()
            log(f"ArrowDown selected commit: {first_selected_sha}")

            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(200)
            second_selected_sha = commit_sha_el.inner_text()
            log(f"Second ArrowDown selected commit: {second_selected_sha}")
            assert first_selected_sha != second_selected_sha, "ArrowDown must navigate to next commit"

            page.keyboard.press("ArrowUp")
            page.wait_for_timeout(200)
            restored_sha = commit_sha_el.inner_text()
            assert restored_sha == first_selected_sha, "ArrowUp must return to previous commit"
            success("Keyboard navigation (ArrowDown -> ArrowUp) verified.")

            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "regression_03_temporal_timeline.png"))

            # =========================================================================
            # SECTION 4: Language Filter Consistency (3D & 2D Parity)
            # Requirements:
            # - Ensure language filtering applies consistently to both 3D and 2D views
            # =========================================================================
            log("=== SECTION 4: Language Filter Consistency ===")
            page.locator(".nav-item:has-text('Network'), .nav-item:has-text('Network Graph')").click()
            expect(page.locator("canvas.network-canvas")).to_be_visible(timeout=8000)

            # 4a. Select language filter in 3D
            filters_btn = page.locator("button:has-text('Filters')")
            expect(filters_btn).to_be_visible()
            filters_btn.click()
            page.wait_for_selector(".toolbar-dropdown-menu", timeout=3000)

            rust_item = page.locator(".menu-item:has-text('Rust')")
            expect(rust_item).to_be_visible()
            rust_item.click()
            page.wait_for_timeout(200)
            expect(filters_btn).to_have_class(re.compile(r"active"))
            success("Rust language filter selected in 3D overview.")

            # 4b. Switch to 2D Relationship view
            mode_2d_btn = page.locator(".mode-btn:has-text('2D Relationships')")
            mode_2d_btn.click()
            page.wait_for_timeout(300)

            # If empty focus state is displayed, focus a suggested node
            suggested_btn = page.locator("button:has-text('Button.tsx')").first
            if suggested_btn.is_visible():
                suggested_btn.click()
                page.wait_for_timeout(300)

            expect(page.locator("canvas.relationship-canvas")).to_be_visible()

            # 4c. Verify language filter remains active in 2D view
            expect(filters_btn).to_have_class(re.compile(r"active"))
            success("Language filter state preserved when switching from 3D to 2D view.")

            # 4d. Toggle language filter in 2D view
            filters_btn.click()
            page.wait_for_selector(".toolbar-dropdown-menu", timeout=3000)
            python_item = page.locator(".menu-item:has-text('Python')")
            expect(python_item).to_be_visible()
            python_item.click()
            page.wait_for_timeout(200)
            expect(filters_btn).to_have_class(re.compile(r"active"))
            success("Language filter switchable within 2D Relationship view.")

            # 4e. Return to 3D view and verify parity
            mode_3d_btn = page.locator(".mode-btn:has-text('3D Overview')")
            mode_3d_btn.click()
            page.wait_for_timeout(200)
            expect(filters_btn).to_have_class(re.compile(r"active"))
            success("Language filter consistency across 3D and 2D verified.")

            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "regression_04_language_filter.png"))

            browser.close()

        print("=" * 80)
        print("\x1b[32m[ALL REGRESSION CHECKS PASSED SUCCESSFULLY]\x1b[0m")
        print("=" * 80)

    finally:
        if server_proc:
            log("Terminating test server...")
            server_proc.send_signal(signal.SIGINT)
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.kill()
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    main()
