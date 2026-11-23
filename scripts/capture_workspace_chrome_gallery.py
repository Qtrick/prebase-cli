#!/usr/bin/env python3
"""
PreBase CLI — Workspace Chrome Visual Verification & Screenshot Gallery
Captures the 12 required states across viewports, breadcrumbs, menus, and themes.
"""

import os
import re
import sys
import time
import socket
import tempfile
import urllib.request
import subprocess
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")
SCREENSHOT_DIR = os.path.join(ROOT_DIR, "docs", "screenshots")
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

def find_available_port(preferred: int = 19985) -> int:
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    return 0

def http_get(url: str, timeout: float = 2.0):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode('utf-8', errors='ignore')

def create_rich_fixture_repo(path: str):
    subprocess.check_call(["git", "init", "-b", "main"], cwd=path, stdout=subprocess.DEVNULL)
    subprocess.check_call(["git", "config", "user.name", "PreBase Gallery"], cwd=path)
    subprocess.check_call(["git", "config", "user.email", "gallery@prebase.dev"], cwd=path)

    # Area 1: frontend/src/transport
    os.makedirs(os.path.join(path, "frontend", "src", "transport"), exist_ok=True)
    with open(os.path.join(path, "frontend", "src", "transport", "api.ts"), "w") as f:
        f.write("import { formatDate } from '../utils/formatter';\nexport function fetchApi() { return formatDate(new Date()); }\n")

    # Area 2: frontend/src/utils
    os.makedirs(os.path.join(path, "frontend", "src", "utils"), exist_ok=True)
    with open(os.path.join(path, "frontend", "src", "utils", "formatter.ts"), "w") as f:
        f.write("export function formatDate(d: Date) { return d.toISOString(); }\n")
    with open(os.path.join(path, "frontend", "src", "utils", "helper.ts"), "w") as f:
        f.write("export const APP_NAME = 'PreBase';\n")

    # Area 3: crates/core
    os.makedirs(os.path.join(path, "crates", "core", "src"), exist_ok=True)
    with open(os.path.join(path, "crates", "core", "src", "lib.rs"), "w") as f:
        f.write("pub fn run() -> bool { true }\n")

    subprocess.check_call(["git", "add", "."], cwd=path)
    subprocess.check_call(["git", "commit", "-m", "Initial commit for chrome gallery"], cwd=path)

def main():
    port = find_available_port(19985)
    test_repo = tempfile.mkdtemp(prefix="prebase-gallery-repo-")
    log_dir = tempfile.mkdtemp(prefix="prebase-gallery-logs-")
    create_rich_fixture_repo(test_repo)

    log_path = os.path.join(log_dir, "server.log")
    log_file = open(log_path, "w")

    cmd = [BIN, "--port", str(port), "--no-open", "map", test_repo]
    proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)

    try:
        base_url = f"http://127.0.0.1:{port}"
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
            raise RuntimeError("Server did not report healthy.")

        startup_url = None
        for _ in range(30):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    content = f.read()
                    for line in content.splitlines():
                        if "Server running at:" in line:
                            raw = line.split("Server running at:")[1].strip()
                            startup_url = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', raw).strip()
                            break
            if startup_url:
                break
            time.sleep(0.1)

        if not startup_url:
            startup_url = base_url

        print(f"[GALLERY] Server active at {startup_url}", flush=True)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()

            page.goto(startup_url, wait_until="networkidle", timeout=20000)
            page.wait_for_selector(".graph-container", timeout=10000)
            page.wait_for_timeout(500)

            # 1. Desktop Overview (1440x900)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_01_desktop_overview.png"))
            print("[PASS] Captured chrome_01_desktop_overview.png", flush=True)

            # 2. Narrow Workspace (1024x768 with Inspector open)
            page.set_viewport_size({"width": 1024, "height": 768})
            page.locator(".search-input").fill("api.ts")
            page.wait_for_selector(".search-dropdown .search-item", timeout=5000)
            page.locator(".search-dropdown .search-item").first.click()
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_02_narrow_workspace.png"))
            print("[PASS] Captured chrome_02_narrow_workspace.png", flush=True)

            # 3. Inspector Collapsed
            page.set_viewport_size({"width": 1440, "height": 900})
            collapse_btn = page.locator('button[aria-label="Collapse inspector"]')
            if collapse_btn.is_visible():
                collapse_btn.click()
                page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_03_inspector_collapsed.png"))
            print("[PASS] Captured chrome_03_inspector_collapsed.png", flush=True)

            reopen_btn = page.locator('.inspector-reopen-btn')
            if reopen_btn.is_visible():
                reopen_btn.click()
                page.wait_for_timeout(300)

            # 4. 3D Mode Active
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_04_3d_mode_active.png"))
            print("[PASS] Captured chrome_04_3d_mode_active.png", flush=True)

            # 5. 2D Mode Active
            mode_2d_btn = page.locator('.mode-btn:has-text("2D")').first
            mode_2d_btn.click()
            page.wait_for_timeout(500)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_05_2d_mode_active.png"))
            print("[PASS] Captured chrome_05_2d_mode_active.png", flush=True)

            mode_3d_btn = page.locator('.mode-btn:has-text("3D")').first
            mode_3d_btn.click()
            page.wait_for_timeout(400)

            # 6. Filter Menu Open
            filter_btn = page.locator('.toolbar-btn:has-text("Filters")').first
            filter_btn.click()
            page.wait_for_selector('.toolbar-dropdown-menu', timeout=3000)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_06_filter_menu_open.png"))
            print("[PASS] Captured chrome_06_filter_menu_open.png", flush=True)
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)

            # 7. View Options Menu Open
            view_menu_btn = page.locator('.view-controls .toolbar-menu-anchor button').first
            view_menu_btn.click()
            page.wait_for_selector('.toolbar-dropdown-menu', timeout=3000)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_07_view_options_menu_open.png"))
            print("[PASS] Captured chrome_07_view_options_menu_open.png", flush=True)
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)

            # 8. Search Results Open
            search_input = page.locator('.search-input')
            search_input.fill("a")
            page.wait_for_selector('.search-dropdown', timeout=3000)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_08_search_results_open.png"))
            print("[PASS] Captured chrome_08_search_results_open.png", flush=True)
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)

            # 9. Selected Area Breadcrumb
            page.evaluate("() => { const ov = document.querySelector('.area-pill-card'); if (ov) ov.click(); }")
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_09_selected_area_breadcrumb.png"))
            print("[PASS] Captured chrome_09_selected_area_breadcrumb.png", flush=True)

            # 10. Selected File Breadcrumb
            search_input.fill("formatter.ts")
            page.wait_for_selector('.search-dropdown .search-item', timeout=5000)
            page.locator('.search-dropdown .search-item').first.click()
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_10_selected_file_breadcrumb.png"))
            print("[PASS] Captured chrome_10_selected_file_breadcrumb.png", flush=True)

            # 11. Selected Inter-Area Relationship Breadcrumb
            page.evaluate("""() => {
                const conns = document.querySelectorAll('.outgoing-area-row, .area-edge-btn, .dependency-link');
                if (conns.length > 0) conns[0].click();
            }""")
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_11_selected_relationship_breadcrumb.png"))
            print("[PASS] Captured chrome_11_selected_relationship_breadcrumb.png", flush=True)

            # 12. Light Theme
            theme_btn = page.locator('button.theme-toggle, button[aria-label*="theme" i]').first
            if theme_btn.is_visible():
                theme_btn.click()
                page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "chrome_12_light_theme.png"))
            print("[PASS] Captured chrome_12_light_theme.png", flush=True)

            browser.close()

        print("[GALLERY] All 12 gallery screenshots captured successfully!", flush=True)
    finally:
        if proc:
            proc.terminate()
            proc.wait(timeout=5)
        log_file.close()

if __name__ == "__main__":
    main()
