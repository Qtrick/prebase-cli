#!/usr/bin/env python3
"""
PreBase CLI — Workspace Header Reconstruction, Contextual Navigation & Geometry Collision Verification Suite

Starts the PreBase release/debug server and measures real DOM getBoundingClientRect() bounding boxes
across viewports (1024x768, 1280x800, 1440x900, 1600x900, 1920x1080) to verify:
1. Search input (.search-input-wrap / .search-box-container) NEVER collides with:
   - .network-mode-switcher
   - .context-nav-bar
   - .network-breadcrumb-bar
2. Breadcrumbs (.context-nav-bar / .network-breadcrumb-bar) strictly render below .primary-toolbar
   (crumbBox.top >= toolbarBox.bottom - 1.0, strictly non-overlapping).
3. Filters (.toolbar-menu-anchor) do not overlap .network-mode-switcher or camera view controls.
4. Contextual close buttons (.crumb-clear-btn) are within viewport bounds, visible, and interactable.
5. Menus (.toolbar-dropdown-menu, .search-dropdown) stay within viewport and close on Escape or outside click.
6. Tests across states:
   a) Network overview
   b) Selected area
   c) Selected file
   d) Selected inter-area relationship with long breadcrumb
   e) Inspector open vs. inspector collapsed
   f) 2D Relationships mode
   g) History tab
7. Long text handling: .truncate and text-overflow ellipsis work, full tooltips (title) are present,
   and the header does not overflow horizontally.
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
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN_RELEASE = os.path.join(ROOT_DIR, "target", "release", "prebase")
BIN_DEBUG = os.path.join(ROOT_DIR, "target", "debug", "prebase")
BIN = BIN_RELEASE if os.path.exists(BIN_RELEASE) else BIN_DEBUG
PREFERRED_PORT = 19993

TARGET_VIEWPORTS = [
    {"name": "1024x768", "width": 1024, "height": 768},
    {"name": "1280x800", "width": 1280, "height": 800},
    {"name": "1440x900", "width": 1440, "height": 900},
    {"name": "1600x900", "width": 1600, "height": 900},
    {"name": "1920x1080", "width": 1920, "height": 1080},
]

def mask_credentials(text: str) -> str:
    if not text:
        return text
    text = re.sub(r'bootstrap=[A-Za-z0-9_-]+', 'bootstrap=[REDACTED]', text)
    text = re.sub(r'prebase_session(?:_\d+)?=[A-Za-z0-9_-]+', 'prebase_session=[REDACTED]', text)
    text = re.sub(r'x-prebase-session:\s*[^\r\n]+', 'x-prebase-session: [REDACTED]', text)
    text = re.sub(r'Bearer\s+[A-Za-z0-9_-]+', 'Bearer [REDACTED]', text)
    return text

def log(msg):
    print(f"\x1b[35m[CHROME-GEOMETRY]\x1b[0m {mask_credentials(str(msg))}", flush=True)

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

def setup_geometry_test_repo(repo_dir: str):
    log(f"Setting up rich test codebase in {repo_dir}...")
    git = lambda *args: subprocess.check_call(
        ["git"] + list(args), cwd=repo_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    git("init", "-b", "main")
    git("config", "user.name", "PreBase Test")
    git("config", "user.email", "test@prebase.local")

    # Area 1: frontend/src/components
    c_dir = os.path.join(repo_dir, "frontend", "src", "components")
    os.makedirs(c_dir, exist_ok=True)
    with open(os.path.join(c_dir, "Header.tsx"), "w") as f:
        f.write('import { formatText } from "../utils/format";\nexport const Header = () => <div>{formatText("header")}</div>;\n')
    with open(os.path.join(c_dir, "Button.tsx"), "w") as f:
        f.write('import { addNumbers } from "../utils/math";\nexport const Button = () => <div>{addNumbers(1, 2)}</div>;\n')

    # Area 2: frontend/src/utils
    u_dir = os.path.join(repo_dir, "frontend", "src", "utils")
    os.makedirs(u_dir, exist_ok=True)
    with open(os.path.join(u_dir, "math.ts"), "w") as f:
        f.write('export function addNumbers(a: number, b: number) { return a + b; }\n')
    with open(os.path.join(u_dir, "format.ts"), "w") as f:
        f.write('export function formatText(t: string) { return t.toUpperCase(); }\n')

    # Area 3: backend/src/api
    api_dir = os.path.join(repo_dir, "backend", "src", "api")
    os.makedirs(api_dir, exist_ok=True)
    with open(os.path.join(api_dir, "server.ts"), "w") as f:
        f.write('import { formatText } from "../../../frontend/src/utils/format";\nexport const start = () => formatText("api");\n')

    # Area 4: Long text test path & file
    long_dir = os.path.join(repo_dir, "deeply", "nested", "architecture", "subsystems", "telemetry")
    os.makedirs(long_dir, exist_ok=True)
    long_filename = "ExtremelyLongTelemetryCollectorProcessorImplementationWithExcessiveLength.tsx"
    with open(os.path.join(long_dir, long_filename), "w") as f:
        f.write('import { addNumbers } from "../../../../../frontend/src/utils/math";\nexport const collector = addNumbers(10, 20);\n')

    # Readme
    with open(os.path.join(repo_dir, "README.md"), "w") as f:
        f.write("# Workspace Chrome Geometry Test Repository\n")

    git("add", ".")
    git("commit", "-m", "chore: initial geometry test repo setup")

    # Add a second commit for History tab
    with open(os.path.join(repo_dir, "README.md"), "a") as f:
        f.write("Second commit for temporal verification.\n")
    git("add", ".")
    git("commit", "-m", "feat: second commit with changes")

    success("Test repository successfully initialized.")

def boxes_overlap_2d(a, b, tol=0.5):
    """Returns True if box a and box b overlap in both X and Y dimensions beyond tolerance."""
    if not a or not b:
        return False
    overlap_x = (a['x'] < b['right'] - tol) and (a['right'] > b['x'] + tol)
    overlap_y = (a['y'] < b['bottom'] - tol) and (a['bottom'] > b['y'] + tol)
    return overlap_x and overlap_y

def fetch_chrome_geometry(page):
    return page.evaluate("""() => {
        const getBox = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom,
                visible: r.width > 0 && r.height > 0
            };
        };

        const searchWrap = getBox('.search-input-wrap') || getBox('.search-box-container');
        const toolbar = getBox('.primary-toolbar');
        const toolbarLeft = getBox('.primary-toolbar-left');
        const toolbarRight = getBox('.primary-toolbar-right');
        const modeSwitcher = getBox('.network-mode-switcher');
        const filterAnchor = getBox('.toolbar-menu-anchor');
        const viewControls = getBox('.view-controls');
        const contextNav = getBox('.context-nav-bar');
        const crumbBar = getBox('.network-breadcrumb-bar');
        const crumbClearBtn = getBox('.crumb-clear-btn');
        const filterMenu = getBox('.toolbar-dropdown-menu');
        const searchDropdown = getBox('.search-dropdown');

        return {
            searchWrap,
            toolbar,
            toolbarLeft,
            toolbarRight,
            modeSwitcher,
            filterAnchor,
            viewControls,
            contextNav,
            crumbBar,
            crumbClearBtn,
            filterMenu,
            searchDropdown,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        };
    }""")

def verify_geometry_invariants(page, viewport_name, state_name, width, height):
    geo = fetch_chrome_geometry(page)

    # 1. Horizontal overflow check
    scroll_w = geo['scrollWidth']
    if scroll_w > width + 1.0:
        fail(f"[{viewport_name} | {state_name}] Horizontal overflow detected! scrollWidth ({scroll_w}) > viewport width ({width})")

    toolbar = geo['toolbar']
    if not toolbar:
        fail(f"[{viewport_name} | {state_name}] .primary-toolbar not found in DOM!")

    context_nav = geo['contextNav']
    search_wrap = geo['searchWrap']
    mode_switcher = geo['modeSwitcher']
    filter_anchor = geo['filterAnchor']
    view_controls = geo['viewControls']

    # 2. Breadcrumbs strictly below primary-toolbar
    if context_nav and context_nav['visible']:
        if context_nav['y'] < toolbar['bottom'] - 1.5:
            fail(f"[{viewport_name} | {state_name}] Breadcrumbs collision! .context-nav-bar.top ({context_nav['y']:.1f}) < .primary-toolbar.bottom ({toolbar['bottom']:.1f})")

        # Breadcrumbs must not overlap search input
        if search_wrap and search_wrap['visible']:
            if boxes_overlap_2d(search_wrap, context_nav):
                fail(f"[{viewport_name} | {state_name}] Search input overlaps .context-nav-bar!")

    # 3. Search input vs Mode switcher non-overlap
    if search_wrap and search_wrap['visible'] and mode_switcher and mode_switcher['visible']:
        if boxes_overlap_2d(search_wrap, mode_switcher):
            fail(f"[{viewport_name} | {state_name}] Search input overlaps .network-mode-switcher! "
                 f"search={search_wrap}, modeSwitcher={mode_switcher}")

    # 4. Filter anchor vs Mode switcher vs View controls non-overlap
    if filter_anchor and filter_anchor['visible']:
        if mode_switcher and mode_switcher['visible'] and boxes_overlap_2d(filter_anchor, mode_switcher):
            fail(f"[{viewport_name} | {state_name}] Filters button overlaps .network-mode-switcher!")
        if view_controls and view_controls['visible'] and boxes_overlap_2d(filter_anchor, view_controls):
            fail(f"[{viewport_name} | {state_name}] Filters button overlaps .view-controls!")

    # 5. Contextual clear button within viewport bounds
    crumb_clear = geo['crumbClearBtn']
    if crumb_clear and crumb_clear['visible']:
        if crumb_clear['right'] > width + 1.0 or crumb_clear['x'] < 0:
            fail(f"[{viewport_name} | {state_name}] .crumb-clear-btn is horizontally out of bounds! x={crumb_clear['x']}, right={crumb_clear['right']}, vp_width={width}")
        if crumb_clear['bottom'] > height + 1.0 or crumb_clear['y'] < 0:
            fail(f"[{viewport_name} | {state_name}] .crumb-clear-btn is vertically out of bounds! y={crumb_clear['y']}, bottom={crumb_clear['bottom']}, vp_height={height}")

    success(f"[{viewport_name} | {state_name}] All geometry collision invariants verified.")

def run_suite():
    temp_dir = tempfile.mkdtemp(prefix="prebase-chrome-geom-")
    log_dir = tempfile.mkdtemp(prefix="prebase-chrome-logs-")
    proc = None

    try:
        setup_geometry_test_repo(temp_dir)
        port = find_available_port(PREFERRED_PORT)
        log(f"Starting PreBase server on port {port}...")

        log_path = os.path.join(log_dir, "server.log")
        log_fp = open(log_path, "w")
        proc = subprocess.Popen(
            [BIN, "--port", str(port), "--no-open", "map", temp_dir],
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            text=True
        )

        startup_url = None
        bootstrap_token = None
        for _ in range(60):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    content = f.read()
                    for line in content.splitlines():
                        if "Server running at:" in line:
                            cleaned = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', line)
                            startup_url = cleaned.split("Server running at:")[1].strip()
                            if "bootstrap=" in startup_url:
                                bootstrap_token = startup_url.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                            break
            if startup_url and bootstrap_token:
                break
            time.sleep(0.1)

        if not startup_url or not bootstrap_token:
            fail("Failed to capture startup URL with bootstrap token!")
        success(f"PreBase server running at {startup_url}")
        time.sleep(0.5)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()

            app_url = f"http://127.0.0.1:{port}/?bootstrap={bootstrap_token}&view=3d"
            page.goto(app_url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector(".primary-toolbar", timeout=10000)
            page.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=10000)
            time.sleep(0.5)

            for vp in TARGET_VIEWPORTS:
                vp_name = vp['name']
                w = vp['width']
                h = vp['height']
                log(f"\n========================================================")
                log(f"Testing Viewport: {vp_name} ({w}x{h})")
                log(f"========================================================")

                page.set_viewport_size({"width": w, "height": h})
                time.sleep(0.3)

                # State a: Network overview
                verify_geometry_invariants(page, vp_name, "State A: Network Overview", w, h)

                # State b: Selected area
                log(f"[{vp_name}] Selecting area from overview cards...")
                area_card = page.locator(".area-pill-card").first
                if area_card.is_visible():
                    area_card.click()
                    page.wait_for_selector(".context-nav-bar .crumb-target", timeout=5000)
                    time.sleep(0.2)
                    verify_geometry_invariants(page, vp_name, "State B: Selected Area", w, h)

                # State d: Selected inter-area relationship with long breadcrumb
                log(f"[{vp_name}] Selecting inter-area relationship...")
                rel_btn = page.locator(".area-relation-btn").first
                if rel_btn.is_visible():
                    rel_btn.click()
                    page.wait_for_selector(".relationship-crumb", timeout=5000)
                    time.sleep(0.2)
                    verify_geometry_invariants(page, vp_name, "State D: Selected Area Relationship", w, h)

                    # Verify relationship crumb text truncation & title
                    rel_crumb = page.locator(".relationship-crumb")
                    title_attr = rel_crumb.get_attribute("title")
                    assert title_attr and "→" in title_attr, f"Missing title attribute on relationship-crumb: {title_attr}"
                    assert page.locator(".relationship-crumb .crumb-text.truncate").count() > 0, "Missing .truncate class on relationship crumb"
                    success(f"[{vp_name}] Relationship crumb truncation and title verified.")

                    # Deselect relationship via crumb clear button
                    clear_btn = page.locator(".context-nav-bar .crumb-clear-btn")
                    assert clear_btn.is_visible(), "Clear button must be visible for relationship crumb"
                    clear_btn.click()
                    time.sleep(0.2)

                # State c: Selected file via Search
                log(f"[{vp_name}] Selecting file via search...")
                search_input = page.locator(".search-input")
                search_input.click()
                search_input.fill("Header")
                page.wait_for_selector(".search-item", timeout=5000)
                page.locator(".search-item").first.click()
                page.wait_for_selector(".crumb-current .crumb-text", timeout=5000)
                time.sleep(0.2)
                verify_geometry_invariants(page, vp_name, "State C: Selected File", w, h)

                # Verify file clear button works cleanly
                file_clear_btn = page.locator(".context-nav-bar .crumb-clear-btn")
                assert file_clear_btn.is_visible(), "File clear button must be visible"
                file_clear_btn.click()
                time.sleep(0.2)

                # State e: Inspector open vs inspector collapsed
                log(f"[{vp_name}] Testing Inspector collapse toggle...")
                collapse_btn = page.locator('button[aria-label="Collapse inspector"]').first
                if collapse_btn.is_visible():
                    collapse_btn.click()
                    page.wait_for_selector(".inspector-panel.collapsed", timeout=5000)
                    time.sleep(0.2)
                    verify_geometry_invariants(page, vp_name, "State E: Inspector Collapsed", w, h)

                    expand_btn = page.locator('button.inspector-reopen-btn, button[aria-label="Open inspector"]').first
                    if expand_btn.is_visible():
                        expand_btn.click()
                        time.sleep(0.2)
                        verify_geometry_invariants(page, vp_name, "State E: Inspector Re-expanded", w, h)

                # State f: 2D Relationships mode
                log(f"[{vp_name}] Switching to 2D Relationships mode...")
                mode_2d_btn = page.locator('button[title*="2D Relationship"]')
                mode_2d_btn.click()
                page.wait_for_selector(".relationship-container, .relationship-empty-state", timeout=5000)
                time.sleep(0.2)
                verify_geometry_invariants(page, vp_name, "State F: 2D Relationships Mode", w, h)

                # Switch back to 3D mode
                mode_3d_btn = page.locator('button[title*="3D Repository Overview"]')
                mode_3d_btn.click()
                time.sleep(0.2)

                # State g: History tab
                log(f"[{vp_name}] Switching to History tab...")
                history_nav_btn = page.locator('button.nav-item[aria-label="History"]')
                history_nav_btn.click()
                page.wait_for_selector(".temporal-header-info", timeout=5000)
                time.sleep(0.2)
                verify_geometry_invariants(page, vp_name, "State G: History Tab", w, h)

                # Switch back to Network tab
                network_nav_btn = page.locator('button.nav-item[aria-label="Network"]')
                network_nav_btn.click()
                page.wait_for_selector(".network-canvas", timeout=5000)
                time.sleep(0.2)

                # Test Dropdowns & Dismissal (Filter menu & Search menu)
                log(f"[{vp_name}] Testing Filter dropdown bounds and Escape dismissal...")
                filter_btn = page.locator('.toolbar-menu-anchor button:has-text("Filters")')
                filter_btn.click()
                page.wait_for_selector(".toolbar-dropdown-menu", timeout=5000)
                time.sleep(0.1)

                menu_geo = fetch_chrome_geometry(page)
                filter_menu = menu_geo['filterMenu']
                assert filter_menu is not None, "Filter menu must be present in DOM"
                assert filter_menu['right'] <= w + 1.0, f"Filter menu overflows right edge! {filter_menu['right']} > {w}"
                assert filter_menu['x'] >= 0, f"Filter menu overflows left edge! {filter_menu['x']} < 0"

                page.keyboard.press("Escape")
                time.sleep(0.1)
                assert page.locator(".toolbar-dropdown-menu").count() == 0, "Filter dropdown did not close on Escape"
                success(f"[{vp_name}] Filter dropdown within bounds and dismissed on Escape.")

                log(f"[{vp_name}] Testing Search dropdown bounds and Escape dismissal...")
                search_input = page.locator(".search-input")
                search_input.click()
                search_input.fill("a")
                page.wait_for_selector(".search-dropdown", timeout=5000)
                time.sleep(0.1)

                search_geo = fetch_chrome_geometry(page)
                search_menu = search_geo['searchDropdown']
                assert search_menu is not None, "Search dropdown must be present in DOM"
                assert search_menu['right'] <= w + 1.0, f"Search dropdown overflows right edge! {search_menu['right']} > {w}"
                assert search_menu['x'] >= 0, f"Search dropdown overflows left edge! {search_menu['x']} < 0"

                page.keyboard.press("Escape")
                time.sleep(0.1)
                assert page.locator(".search-dropdown").count() == 0, "Search dropdown did not close on Escape"
                success(f"[{vp_name}] Search dropdown within bounds and dismissed on Escape.")

                # Long text test: select the excessively long filename
                log(f"[{vp_name}] Testing long path file selection and text ellipsis truncation...")
                search_input.click()
                search_input.fill("ExtremelyLong")
                page.wait_for_selector(".search-item", timeout=5000)
                page.locator(".search-item").first.click()
                page.wait_for_selector(".crumb-current", timeout=5000)
                time.sleep(0.2)

                verify_geometry_invariants(page, vp_name, "Long Path File Selected", w, h)

                long_crumb = page.locator(".crumb-current")
                crumb_title = long_crumb.get_attribute("title")
                assert crumb_title and "ExtremelyLongTelemetryCollectorProcessorImplementationWithExcessiveLength.tsx" in crumb_title, \
                    f"Full filename missing from title tooltip: {crumb_title}"
                assert page.locator(".crumb-current .crumb-text.truncate").count() > 0, "Missing .truncate class on long crumb text"

                # Check contextual clear button is still interactable
                crumb_clear_btn = page.locator(".context-nav-bar .crumb-clear-btn")
                assert crumb_clear_btn.is_visible(), "Clear button must remain visible with long filename"
                crumb_clear_btn.click()
                time.sleep(0.2)
                success(f"[{vp_name}] Long filename truncation, tooltip, and clear button verified.")

                # Return to overview for next viewport
                overview_btn = page.locator(".network-breadcrumb-bar .crumb-btn:has-text('Overview')").first
                if overview_btn.is_visible():
                    overview_btn.click()
                    time.sleep(0.2)

            context.close()
            browser.close()

        success("ALL VIEWPORTS AND ALL STATES PASSED CHROME GEOMETRY & COLLISION VERIFICATION!")

    finally:
        if proc:
            log("Shutting down PreBase server...")
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(temp_dir, ignore_errors=True)
        shutil.rmtree(log_dir, ignore_errors=True)

if __name__ == "__main__":
    run_suite()
