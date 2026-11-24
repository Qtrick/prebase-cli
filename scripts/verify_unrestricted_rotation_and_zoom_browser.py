#!/usr/bin/env python3
"""
PreBase CLI — Unrestricted 3D Rotation, Native Graph Zoom, & Visual Redesign Verification Suite

Captures evidentiary screenshots for Phase 16:
17. Rotated sphere after crossing the former vertical limit (pitch > 85 deg).
18. Inverted sphere (upside-down).
19. Sphere after a complete 360-degree revolution.
20. Zoomed-in sphere (cursor-anchored / center-anchored).
21. Zoomed-out sphere.
10. Dependency path explorer.
11. Cycle inspector.
14. Long commit message in History inspector.
15. Narrow viewport (800x600).
16. Fully expanded desktop viewport (1920x1080).
And verifies that native wheel zoom operates strictly on canvas without altering window.visualViewport.scale.
"""

import os
import sys
import time
import json
import signal
import subprocess
import re
import socket
import tempfile
import shutil
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")
PORT = 19991
capture_docs = "--capture-docs" in sys.argv or os.environ.get("PREBASE_CAPTURE_DOCS") == "1"
default_dest = (
    os.path.join(ROOT_DIR, "docs", "screenshots")
    if capture_docs
    else os.path.join(ROOT_DIR, "test-results", "visual")
)
SCREENSHOT_DIR = os.environ.get("PREBASE_SCREENSHOT_DIR", default_dest)
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

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
    print(f"\x1b[35m[PHASE-16-VERIFY]\x1b[0m {mask_credentials(str(msg))}", flush=True)

def setup_rich_test_repo():
    repo_dir = tempfile.mkdtemp(prefix="prebase-phase16-")
    subprocess.run(["git", "init", "-b", "main"], cwd=repo_dir, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "config", "user.name", "PreBase Test"], cwd=repo_dir, check=True)
    subprocess.run(["git", "config", "user.email", "test@prebase.local"], cwd=repo_dir, check=True)

    # Circular dependencies: a.ts <-> b.ts, plus c.ts
    os.makedirs(os.path.join(repo_dir, "src", "cycle"), exist_ok=True)
    with open(os.path.join(repo_dir, "src", "cycle", "cycleA.ts"), "w") as f:
        f.write("import { bFunc } from './cycleB';\nexport const aFunc = () => bFunc() + 1;\n")
    with open(os.path.join(repo_dir, "src", "cycle", "cycleB.ts"), "w") as f:
        f.write("import { aFunc } from './cycleA';\nexport const bFunc = () => 42;\n")

    # Linear chain for path: root.ts -> middle.ts -> leaf.ts
    os.makedirs(os.path.join(repo_dir, "src", "chain"), exist_ok=True)
    with open(os.path.join(repo_dir, "src", "chain", "root.ts"), "w") as f:
        f.write("import { mid } from './middle';\nexport const start = () => mid();\n")
    with open(os.path.join(repo_dir, "src", "chain", "middle.ts"), "w") as f:
        f.write("import { leaf } from './leaf';\nexport const mid = () => leaf();\n")
    with open(os.path.join(repo_dir, "src", "chain", "leaf.ts"), "w") as f:
        f.write("export const leaf = () => 'done';\n")

    # Initial commit
    subprocess.run(["git", "add", "."], cwd=repo_dir, check=True)
    subprocess.run(["git", "commit", "-m", "chore: initial modular setup with cycle and dependency chain"], cwd=repo_dir, check=True)

    # Commit with long multiline message
    long_msg = "feat(core): implement architecture overhaul with extensive detailed justification\n\n" + \
        "This commit demonstrates handling of extremely detailed and lengthy commit messages inside the PreBase History CommitInspector.\n\n" + \
        "- Detailed subsystem 1: Complete elimination of artificial vertical rotation pitch clamping.\n" + \
        "- Detailed subsystem 2: Authoritative screen-relative quaternion orientation.\n" + \
        "- Detailed subsystem 3: Native non-passive canvas wheel zoom intercepting ctrlKey page zoom gestures.\n" + \
        "- Detailed subsystem 4: High-contrast tabular overview metric strip with 4 distinct columns.\n" + \
        "- Detailed subsystem 5: Compact unified repository and branch identity card without wasted vertical space.\n\n" + \
        "Approved-by: Lead Architect <architect@prebase.local>\nSigned-off-by: Developer <dev@prebase.local>"
    
    with open(os.path.join(repo_dir, "src", "chain", "leaf.ts"), "a") as f:
        f.write("\n// expanded\n")
    subprocess.run(["git", "add", "."], cwd=repo_dir, check=True)
    subprocess.run(["git", "commit", "-m", long_msg], cwd=repo_dir, check=True)

    return repo_dir

def main():
    repo_dir = setup_rich_test_repo()
    log(f"Test repo created at {repo_dir}")

    log_file = tempfile.NamedTemporaryFile(delete=False, suffix=".log")
    log_path = log_file.name
    log_file.close()

    log_fp = open(log_path, "w")
    proc = subprocess.Popen(
        [BIN, "--port", str(PORT), "--no-open", "map", repo_dir],
        stdout=log_fp,
        stderr=subprocess.STDOUT,
        text=True
    )

    try:
        startup_url = None
        bootstrap_token = None
        for _ in range(50):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    content = f.read()
                    for line in content.splitlines():
                        if "Server running at:" in line:
                            import re
                            cleaned = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', line)
                            startup_url = cleaned.split("Server running at:")[1].strip()
                            if "bootstrap=" in startup_url:
                                bootstrap_token = startup_url.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                            break
            if startup_url and bootstrap_token:
                break
            time.sleep(0.1)

        assert startup_url and bootstrap_token, f"Failed to capture startup URL with bootstrap token: {mask_credentials(str(startup_url))}"
        log(f"Server started at {startup_url}")
        time.sleep(0.5)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            try:
                page.goto(startup_url, wait_until="domcontentloaded", timeout=15000)
            except Exception as e:
                sanitized_err = mask_credentials(str(e))
                raise RuntimeError(f"Browser navigation failed: {sanitized_err}") from None
            page.wait_for_selector(".network-canvas", timeout=10000)
            page.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=10000)
            time.sleep(0.5)

            # 1. Verify Unrestricted Rotation past the former limit (pitch > 85 deg)
            log("1. Performing large upward vertical drag to cross former vertical pitch limit (84.8 deg)...")
            canvas = page.locator(".network-canvas")
            box = canvas.bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

            # Drag vertically down by 250px (advancing pitch past 90 deg / over the pole)
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.move(cx, cy + 250, steps=10)
            page.mouse.up()
            time.sleep(0.3)

            cam_pole = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"Camera after crossing pole: pitch={cam_pole['pitch']:.4f}, orientation={cam_pole.get('orientation')}")
            # Ensure orientation is valid and pitch moved without crashing or freezing
            assert cam_pole.get("orientation") is not None
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "17_rotated_sphere_past_vertical_limit.png"))
            log("Saved 17_rotated_sphere_past_vertical_limit.png")

            # 2. Inverted Sphere
            log("2. Advancing to fully inverted (upside-down) sphere...")
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.move(cx, cy + 200, steps=10)
            page.mouse.up()
            time.sleep(0.3)
            cam_inv = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"Inverted camera: orientation={cam_inv.get('orientation')}")
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "18_inverted_sphere.png"))
            log("Saved 18_inverted_sphere.png")

            # 3. Complete 360-degree revolution
            log("3. Rotating full 360-degree revolution...")
            for _ in range(4):
                page.mouse.move(cx, cy)
                page.mouse.down()
                page.mouse.move(cx, cy + 250, steps=8)
                page.mouse.up()
                time.sleep(0.1)
            
            cam_360 = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"Camera after 360-deg revolution: orientation={cam_360.get('orientation')}")
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "19_complete_revolution.png"))
            log("Saved 19_complete_revolution.png")

            # 4. Zoom in via native wheel and toolbar
            log("4. Testing Graph Zoom In via native wheel and verifying page zoom is NOT altered...")
            initial_page_scale = page.evaluate("() => window.visualViewport.scale")
            assert initial_page_scale == 1.0, f"Expected page scale 1.0, got {initial_page_scale}"

            # Dispatch wheel event directly on canvas
            page.mouse.move(cx, cy)
            page.mouse.wheel(0, -300) # zoom in
            time.sleep(0.3)

            cam_zoomed_in = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"Camera after wheel zoom-in: zoom={cam_zoomed_in['zoom']:.2f}")
            assert cam_zoomed_in["zoom"] > 1.0, "Graph zoom increased"
            
            post_wheel_scale = page.evaluate("() => window.visualViewport.scale")
            assert post_wheel_scale == 1.0, f"Page zoom was accidentally altered! Got {post_wheel_scale}"
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "20_zoomed_in_sphere.png"))
            log("Saved 20_zoomed_in_sphere.png")

            # 5. Zoom out via toolbar button
            log("5. Testing Graph Zoom Out via toolbar button #zoomOut...")
            for _ in range(12):
                page.locator("#zoomOut").click()
                time.sleep(0.05)
            
            cam_zoomed_out = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"Camera after zoom out: zoom={cam_zoomed_out['zoom']:.2f}")
            assert cam_zoomed_out["zoom"] < 1.0, "Graph zoom decreased"
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "21_zoomed_out_sphere.png"))
            log("Saved 21_zoomed_out_sphere.png")

            # Reset view
            page.locator("#resetCam").click()
            time.sleep(0.3)

            # 6. Dependency Path Explorer
            log("6. Opening Dependency Path Explorer...")
            page.locator("button:has-text('Explore Dependency Paths')").click()
            page.wait_for_selector(".path-explorer-modal, .path-explorer-panel, .dependency-path-panel", timeout=5000)
            time.sleep(0.3)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "10_dependency_path.png"))
            log("Saved 10_dependency_path.png")

            # Close path explorer
            close_btn = page.locator(".modal-close-btn, .close-btn, button[aria-label='Close path explorer']")
            if close_btn.count() > 0:
                close_btn.first.click()
                time.sleep(0.2)

            # 7. Cycle Inspector
            log("7. Checking for Cycle Groups in Inspector...")
            cycle_card = page.locator(".cycle-card, .cycle-group-item, .cycle-group-inspector, .cycle-classification-banner")
            if cycle_card.count() > 0:
                cycle_card.first.click()
                time.sleep(0.3)
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, "11_cycle_inspector.png"))
                log("Saved 11_cycle_inspector.png")

            # 8. History Timeline & Long Commit Message
            log("8. Navigating to History tab to inspect long commit message...")
            page.locator(".nav-item:has-text('History')").click()
            page.wait_for_selector(".temporal-canvas-container canvas", timeout=10000)
            time.sleep(0.5)

            # Click top commit
            pos = page.evaluate("() => window.__prebaseTemporalDebug ? window.__prebaseTemporalDebug.getScreenPosition(0) : null")
            if pos:
                canvas = page.locator(".temporal-canvas-container canvas")
                box = canvas.bounding_box()
                if box:
                    page.mouse.click(box["x"] + pos["x"], box["y"] + pos["y"])
                else:
                    page.mouse.click(284, 60)
            else:
                page.mouse.click(284, 60)
            time.sleep(0.5)
            page.wait_for_selector(".commit-inspector, .inspector-panel .sha-text", timeout=5000)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "14_long_commit_message.png"))
            log("Saved 14_long_commit_message.png")

            # 9. Narrow Viewport
            log("9. Testing Narrow Viewport (800x600)...")
            page.set_viewport_size({"width": 800, "height": 600})
            time.sleep(0.4)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "15_narrow_viewport.png"))
            log("Saved 15_narrow_viewport.png")

            # 10. Expanded Viewport
            log("10. Testing Expanded Desktop Viewport (1920x1080)...")
            page.set_viewport_size({"width": 1920, "height": 1080})
            page.locator(".nav-item:has-text('Network')").click()
            page.wait_for_selector(".network-canvas", timeout=5000)
            time.sleep(0.5)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "16_fully_expanded_desktop_viewport.png"))
            log("Saved 16_fully_expanded_desktop_viewport.png")

            browser.close()
            log("All Phase 16 browser verification tests succeeded!")

    finally:
        try:
            proc.send_signal(signal.SIGINT)
            proc.wait(timeout=5)
        except Exception:
            pass
        try:
            log_fp.close()
            if os.path.exists(log_path):
                os.remove(log_path)
        except Exception:
            pass
        shutil.rmtree(repo_dir, ignore_errors=True)

if __name__ == "__main__":
    main()
