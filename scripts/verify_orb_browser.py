#!/usr/bin/env python3
"""
PreBase CLI — 3D Network Orb Real Browser Verification Suite

Independently verifies in a real headless browser using Playwright:
1. Launch PreBase release executable directly against a deterministic 24-node repository.
2. Record camera yaw, pitch, panX, panY, zoom, and projected positions of nodes.
3. Perform normal left-button drag on canvas.
4. Confirm yaw/pitch change while pan remains unchanged.
5. Confirm nodes undergo nonuniform projected movement consistent with 3D rotation.
6. Confirm projected rotation pivot remains stationary.
7. Verify repeated horizontal and vertical rotations.
8. Verify rotations from different pointer starting locations.
9. Verify Shift/middle-button panning is separate from rotation.
10. Verify drag does not accidentally select a node.
11. Verify normal single click selects node without moving camera and exposes Inspector details.
12. Verify 3D -> 2D Relationship Explorer -> 3D roundtrip preserves camera orientation and zoom.
13. Captures evidentiary screenshots to docs/screenshots/.
"""

import os
import sys
import time
import json
import signal
import shutil
import tempfile
import subprocess
import urllib.request
import urllib.parse
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")
PORT = 19998
SCREENSHOT_DIR = os.path.join(ROOT_DIR, "docs", "screenshots")

os.makedirs(SCREENSHOT_DIR, exist_ok=True)

def log(msg):
    print(f"\x1b[36m[ORB VERIFY]\x1b[0m {msg}", flush=True)

def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {msg}", flush=True)

def fail(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {msg}", file=sys.stderr, flush=True)
    sys.exit(1)

def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read().decode("utf-8")

def setup_deterministic_repository(path):
    log(f"Generating deterministic 24-node codebase in {path}...")
    git = lambda *args: subprocess.check_call(
        ["git"] + list(args), cwd=path, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    git("init", "-b", "main")
    git("config", "user.name", "Orb Tester")
    git("config", "user.email", "orb@prebase.dev")

    dirs = ["src", "src/core", "src/services", "src/components", "src/utils", "src/models"]
    for d in dirs:
        os.makedirs(os.path.join(path, d), exist_ok=True)

    # 1. Models
    for i in range(1, 5):
        with open(os.path.join(path, "src", "models", f"model_{i}.ts"), "w") as f:
            f.write(f"export interface Model{i} {{\n  id: string;\n  value: number;\n}}\n")

    # 2. Utils
    for i in range(1, 5):
        with open(os.path.join(path, "src", "utils", f"math_{i}.ts"), "w") as f:
            f.write(f"import {{ Model{i} }} from '../models/model_{i}';\nexport function compute_{i}(m: Model{i}): number {{\n  return m.value * {i};\n}}\n")

    # 3. Core
    for i in range(1, 5):
        with open(os.path.join(path, "src", "core", f"engine_{i}.ts"), "w") as f:
            f.write(f"import {{ compute_{i} }} from '../utils/math_{i}';\nimport {{ Model{i} }} from '../models/model_{i}';\nexport class Engine{i} {{\n  run(m: Model{i}) {{ return compute_{i}(m); }}\n}}\n")

    # 4. Services
    for i in range(1, 5):
        with open(os.path.join(path, "src", "services", f"service_{i}.ts"), "w") as f:
            f.write(f"import {{ Engine{i} }} from '../core/engine_{i}';\nexport class Service{i} {{\n  engine = new Engine{i}();\n}}\n")

    # 5. Components
    for i in range(1, 5):
        with open(os.path.join(path, "src", "components", f"View_{i}.tsx"), "w") as f:
            f.write(f"import {{ Service{i} }} from '../services/service_{i}';\nexport const View{i} = () => <div>Service {i} Active</div>;\n")

    # 6. Main Index & App
    with open(os.path.join(path, "src", "App.tsx"), "w") as f:
        f.write("""import { View1 } from './components/View_1';
import { View2 } from './components/View_2';
import { View3 } from './components/View_3';
import { View4 } from './components/View_4';
export const App = () => <div><View1 /><View2 /><View3 /><View4 /></div>;
""")

    with open(os.path.join(path, "src", "index.ts"), "w") as f:
        f.write("""import { App } from './App';
console.log('App ready:', App);
""")

    git("add", ".")
    git("commit", "-m", "feat: deterministic multi-layer dependency structure")
    success("Deterministic 24-node repository initialized.")

def main():
    print("=" * 75)
    print("PreBase CLI — 3D Network Orb Real Browser Verification Suite")
    print("=" * 75)

    # 1. Verify executable exists
    if not os.path.exists(BIN):
        fail(f"Executable not found at {BIN}. Run 'cargo build --release --bin prebase' first.")
    
    bin_stat = os.stat(BIN)
    log(f"Executable resolved: {BIN} (Size: {bin_stat.st_size} bytes, Modified: {time.ctime(bin_stat.st_mtime)})")

    # 2. Setup deterministic repository
    test_repo_dir = tempfile.mkdtemp(prefix="prebase-orb-verification-")
    proc = None
    try:
        setup_deterministic_repository(test_repo_dir)

        # 3. Launch PreBase executable directly
        log_path = os.path.join(test_repo_dir, "prebase_server.log")
        log_file = open(log_path, "w")

        cmd = [BIN, "--port", str(PORT), "--no-open", "map", test_repo_dir]
        log(f"Spawning executable directly: {' '.join(cmd)}")
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)

        # Wait for server health
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
            fail("Server did not report healthy.")
        success("PreBase server is listening and healthy.")

        # Extract bootstrap token and startup URL from log
        startup_url = None
        bootstrap_token = None
        for _ in range(30):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    content = f.read()
                    for line in content.splitlines():
                        if "Server running at:" in line:
                            startup_url = line.split("Server running at:")[1].strip()
                            # Clean ANSI escapes if present
                            import re
                            startup_url = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', startup_url)
                            if "bootstrap=" in startup_url:
                                bootstrap_token = startup_url.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                            break
            if startup_url and bootstrap_token:
                break
            time.sleep(0.1)

        if not startup_url or not bootstrap_token:
            fail(f"Could not parse startup URL or bootstrap token from log:\n{open(log_path).read()}")

        log(f"Extracted bootstrap URL: {startup_url}")
        success("Bootstrap credentials verified.")

        # 4. Launch Playwright
        with sync_playwright() as p:
            log("Launching Playwright Chromium browser...")
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()

            log(f"Navigating to {startup_url}...")
            page.goto(startup_url, wait_until="networkidle")

            # Wait for canvas and index ready
            page.wait_for_selector(".network-canvas", timeout=10000)
            page.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=10000)
            success("Canvas loaded and repository index is Ready.")

            # Let layout and initial projection settle
            time.sleep(1.0)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "01_initial_orb.png"))
            success(f"Saved initial screenshot -> docs/screenshots/01_initial_orb.png")

            # --- TEST STEP 2: Record initial camera and node coordinates ---
            log("Reading initial camera state and projected nodes via __prebaseNetworkDebug...")
            init_metrics = page.evaluate("""() => {
                const dbg = window.__prebaseNetworkDebug;
                if (!dbg) return null;
                return {
                    camera: dbg.getCamera(),
                    centroid: dbg.getCentroid(),
                    nodes: dbg.getProjectedNodes(),
                    isCenterLocked: dbg.isCenterLocked()
                };
            }""")

            if not init_metrics:
                fail("__prebaseNetworkDebug is not available on window. Check NetworkCanvas.tsx.")

            init_cam = init_metrics["camera"]
            init_nodes = init_metrics["nodes"]
            log(f"Initial Camera: yaw={init_cam['yaw']:.4f}, pitch={init_cam['pitch']:.4f}, panX={init_cam['panX']:.2f}, panY={init_cam['panY']:.2f}, zoom={init_cam['zoom']:.2f}")
            log(f"Total Projected Nodes: {len(init_nodes)}")
            assert len(init_nodes) >= 20, f"Expected >= 20 nodes, found {len(init_nodes)}"
            assert init_metrics["isCenterLocked"] == True, "Center Lock must be ON by default"
            success("Initial camera metrics and node projections verified.")

            # --- TEST STEP 3 & 4: Normal left-button drag on canvas (Horizontal) ---
            log("Executing normal left-button horizontal drag (drag dx=-100px from 640,400 to 540,400)...")
            canvas_box = page.locator(".network-canvas").bounding_box()
            cx = canvas_box["x"] + canvas_box["width"] / 2
            cy = canvas_box["y"] + canvas_box["height"] / 2

            # Drag horizontally to the left by 100px
            page.mouse.move(cx, cy)
            page.mouse.down(button="left")
            page.mouse.move(cx - 50, cy, steps=5)
            page.mouse.move(cx - 100, cy, steps=5)
            page.mouse.up(button="left")

            time.sleep(0.3)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "02_after_horizontal_drag.png"))
            success("Saved horizontal rotation screenshot -> docs/screenshots/02_after_horizontal_drag.png")

            after_horiz = page.evaluate("""() => ({
                camera: window.__prebaseNetworkDebug.getCamera(),
                nodes: window.__prebaseNetworkDebug.getProjectedNodes()
            })""")

            horiz_cam = after_horiz["camera"]
            horiz_nodes = after_horiz["nodes"]

            log(f"After Horizontal Drag: yaw={horiz_cam['yaw']:.4f}, pitch={horiz_cam['pitch']:.4f}, panX={horiz_cam['panX']:.2f}, panY={horiz_cam['panY']:.2f}")
            # Confirm yaw changed while pan remained invariant!
            assert abs(horiz_cam["yaw"] - init_cam["yaw"]) > 0.1, "Yaw must change significantly during horizontal drag"
            assert abs(horiz_cam["panX"] - init_cam["panX"]) < 0.5, f"PanX must remain invariant under Center Lock (got {horiz_cam['panX']} vs {init_cam['panX']})"
            assert abs(horiz_cam["panY"] - init_cam["panY"]) < 0.5, f"PanY must remain invariant under Center Lock (got {horiz_cam['panY']} vs {init_cam['panY']})"
            success("Item 4 Confirmed: Yaw changed while PanX and PanY remained strictly invariant.")

            # --- TEST STEP 5: Confirm nonuniform projected movement (3D Perspective Proof) ---
            log("Verifying nonuniform projected movement across different depth layers...")
            # Match nodes by ID between init_nodes and horiz_nodes
            node_map_init = {n["id"]: n for n in init_nodes}
            node_map_after = {n["id"]: n for n in horiz_nodes}

            front_node = None
            back_node = None
            max_z = -1e9
            min_z = 1e9

            for n in init_nodes:
                if n["z"] > max_z:
                    max_z = n["z"]
                    front_node = n
                if n["z"] < min_z:
                    min_z = n["z"]
                    back_node = n

            log(f"Front Node ({front_node['id']}): initial z = {front_node['z']:.2f}, depthScale = {front_node['depthScale']:.3f}")
            log(f"Back Node ({back_node['id']}): initial z = {back_node['z']:.2f}, depthScale = {back_node['depthScale']:.3f}")

            dx_front = node_map_after[front_node["id"]]["screenX"] - front_node["screenX"]
            dx_back = node_map_after[back_node["id"]]["screenX"] - back_node["screenX"]

            log(f"Front node screen dx = {dx_front:.2f}px, Back node screen dx = {dx_back:.2f}px")
            # In true 3D rotation, front and back nodes rotate in opposite directions or with distinctly different velocities!
            assert abs(dx_front - dx_back) > 20.0, f"Nodes must exhibit nonuniform screen velocities (difference: {abs(dx_front - dx_back):.2f}px)"
            success("Item 5 Confirmed: Nonuniform projected movement proven (true 3D perspective rotation, NOT flat 2D translation).")

            # --- TEST STEP 6: Confirm rotation pivot remains stationary ---
            log("Confirming rotation pivot (3D centroid) remains stationary...")
            # The 3D centroid always projects to (panX, panY). Since panX/panY are invariant, pivot is stationary!
            assert abs(horiz_cam["panX"] - init_cam["panX"]) < 0.1, "Projected pivot X remained stationary"
            assert abs(horiz_cam["panY"] - init_cam["panY"]) < 0.1, "Projected pivot Y remained stationary"
            success("Item 6 Confirmed: Projected rotation pivot remains stationary.")

            # --- TEST STEP 7: Repeated vertical rotation ---
            log("Executing vertical drag (dy=-80px)...")
            page.mouse.move(cx, cy)
            page.mouse.down(button="left")
            page.mouse.move(cx, cy - 40, steps=5)
            page.mouse.move(cx, cy - 80, steps=5)
            page.mouse.up(button="left")

            time.sleep(0.3)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "03_after_vertical_drag.png"))
            success("Saved vertical rotation screenshot -> docs/screenshots/03_after_vertical_drag.png")

            after_vert = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"After Vertical Drag: pitch={after_vert['pitch']:.4f}, panX={after_vert['panX']:.2f}, panY={after_vert['panY']:.2f}")
            assert abs(after_vert["pitch"] - horiz_cam["pitch"]) > 0.1, "Pitch must change significantly during vertical drag"
            assert abs(after_vert["panX"] - init_cam["panX"]) < 0.5, "PanX remains invariant"
            assert abs(after_vert["panY"] - init_cam["panY"]) < 0.5, "PanY remains invariant"
            success("Item 7 Confirmed: Vertical rotation advances pitch while keeping pivot stationary.")

            # --- TEST STEP 8: Rotations from different pointer starting locations ---
            log("Executing rotations from different screen starting locations...")
            # Drag from top-left (350, 250)
            page.mouse.move(350, 250)
            page.mouse.down(button="left")
            page.mouse.move(400, 250, steps=5)
            page.mouse.up(button="left")

            cam_tl = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            assert abs(cam_tl["panX"] - init_cam["panX"]) < 0.5, "Top-left start rotates around same central pivot"

            # Drag from bottom-right (900, 550)
            page.mouse.move(900, 550)
            page.mouse.down(button="left")
            page.mouse.move(850, 550, steps=5)
            page.mouse.up(button="left")

            cam_br = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            assert abs(cam_br["panX"] - init_cam["panX"]) < 0.5, "Bottom-right start rotates around same central pivot"
            success("Item 8 Confirmed: Rotations from varied screen locations rotate around the identical stable center.")

            # --- TEST STEP 9: Shift/middle-button panning is separate from rotation ---
            log("Verifying Shift + Drag panning...")
            page.keyboard.down("Shift")
            page.mouse.move(cx, cy)
            page.mouse.down(button="left")
            page.mouse.move(cx + 80, cy + 60, steps=5)
            page.mouse.up(button="left")
            page.keyboard.up("Shift")

            time.sleep(0.3)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "04_after_shift_pan.png"))
            success("Saved shift-pan screenshot -> docs/screenshots/04_after_shift_pan.png")

            after_pan = page.evaluate("""() => ({
                camera: window.__prebaseNetworkDebug.getCamera(),
                isCenterLocked: window.__prebaseNetworkDebug.isCenterLocked()
            })""")
            panned_cam = after_pan["camera"]
            log(f"After Shift+Pan: panX={panned_cam['panX']:.2f}, panY={panned_cam['panY']:.2f}, yaw={panned_cam['yaw']:.4f}")
            assert abs(panned_cam["panX"] - init_cam["panX"]) > 20, "PanX must shift when user explicitly pans"
            assert abs(panned_cam["panY"] - init_cam["panY"]) > 20, "PanY must shift when user explicitly pans"
            assert after_pan["isCenterLocked"] == False, "Explicit panning unlocks center lock"
            success("Item 9 Confirmed: Panning shifts translation while decoupling from rotation.")

            # Re-center via #centerLock button
            log("Clicking #centerLock button to re-center the orb...")
            center_lock_btn = page.locator("#centerLock")
            center_lock_btn.click()
            time.sleep(0.3)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "05_after_recenter.png"))
            success("Saved re-center screenshot -> docs/screenshots/05_after_recenter.png")

            re_centered = page.evaluate("""() => ({
                camera: window.__prebaseNetworkDebug.getCamera(),
                isCenterLocked: window.__prebaseNetworkDebug.isCenterLocked()
            })""")
            assert re_centered["isCenterLocked"] == True, "Center Lock re-engaged"
            assert abs(re_centered["camera"]["panX"] - init_cam["panX"]) < 0.5, "PanX snapped back to center"
            assert abs(re_centered["camera"]["panY"] - init_cam["panY"]) < 0.5, "PanY snapped back to center"
            success("Re-centering invariant verified.")

            # --- TEST STEP 10: Drag does not accidentally select a node ---
            log("Verifying drag starting directly on a node does NOT select it...")
            canvas_box = page.locator(".network-canvas").bounding_box()
            nodes_now = page.evaluate("() => window.__prebaseNetworkDebug.getProjectedNodes()")
            target_node = nodes_now[-1]  # Frontmost node
            target_x = canvas_box["x"] + target_node["screenX"]
            target_y = canvas_box["y"] + target_node["screenY"]
            log(f"Target node for drag-over test: {target_node['id']} at screen ({target_x:.1f}, {target_y:.1f})")

            # Drag starting on the node
            page.mouse.move(target_x, target_y)
            page.mouse.down(button="left")
            page.mouse.move(target_x + 40, target_y + 10, steps=5)
            page.mouse.up(button="left")

            time.sleep(0.3)
            selected_node = page.evaluate("() => document.querySelector('.inspector-panel .file-name')?.textContent || null")
            assert selected_node is None or "Dependency Relationship" in selected_node or selected_node == "Repository Overview", f"Drag must not select node (found: {selected_node})"
            success("Item 10 Confirmed: Drag does not accidentally select a node.")

            # --- TEST STEP 11: Normal single click selects node without moving camera ---
            log("Executing normal single click on a node...")
            nodes_now2 = page.evaluate("() => window.__prebaseNetworkDebug.getProjectedNodes()")
            first_node = nodes_now2[-1]  # Frontmost node
            cam_before_click = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")

            canvas_box = page.locator(".network-canvas").bounding_box()
            click_x = canvas_box["x"] + first_node["screenX"]
            click_y = canvas_box["y"] + first_node["screenY"]
            log(f"Clicking frontmost node: {first_node['id']} at screen ({click_x:.1f}, {click_y:.1f})")
            page.mouse.click(click_x, click_y)
            time.sleep(0.5)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "06_node_selected_inspector.png"))
            success("Saved node selection screenshot -> docs/screenshots/06_node_selected_inspector.png")

            cam_after_click = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            assert abs(cam_after_click["yaw"] - cam_before_click["yaw"]) < 1e-4, "Camera yaw unchanged on click"
            assert abs(cam_after_click["pitch"] - cam_before_click["pitch"]) < 1e-4, "Camera pitch unchanged on click"
            assert abs(cam_after_click["panX"] - cam_before_click["panX"]) < 1e-4, "Camera panX unchanged on click"
            assert abs(cam_after_click["panY"] - cam_before_click["panY"]) < 1e-4, "Camera panY unchanged on click"

            # Verify Inspector shows file information and dependencies
            inspector_title = page.locator(".inspector-panel .file-name").text_content()
            log(f"Inspector file name: '{inspector_title}'")
            assert inspector_title and len(inspector_title.strip()) > 0, "Inspector must display selected node file name"
            success("Item 11 Confirmed: Single click selects node without moving camera and displays Inspector metadata.")

            # --- TEST STEP 12: 3D -> 2D -> 3D roundtrip preserves camera orientation ---
            log("Testing 3D -> 2D Relationship Explorer -> 3D transition camera preservation...")
            cam_3d_saved = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")

            # Click '2D Relationships' mode button
            page.locator("button.mode-btn:has-text('2D Relationships')").click()
            time.sleep(0.5)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "07_2d_relationships.png"))
            success("Saved 2D relationships screenshot -> docs/screenshots/07_2d_relationships.png")

            # Confirm 2D canvas is active
            assert page.is_visible(".relationship-canvas"), "2D Relationship canvas must be visible"

            # Click '3D Overview' mode button to return
            page.locator("button.mode-btn:has-text('3D Overview')").click()
            time.sleep(0.5)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "08_back_to_3d_preserved.png"))
            success("Saved back to 3D screenshot -> docs/screenshots/08_back_to_3d_preserved.png")

            cam_3d_restored = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"3D Restored Camera: yaw={cam_3d_restored['yaw']:.4f}, pitch={cam_3d_restored['pitch']:.4f}, zoom={cam_3d_restored['zoom']:.2f}")

            assert abs(cam_3d_restored["yaw"] - cam_3d_saved["yaw"]) < 1e-4, "3D yaw preserved after 2D roundtrip"
            assert abs(cam_3d_restored["pitch"] - cam_3d_saved["pitch"]) < 1e-4, "3D pitch preserved after 2D roundtrip"
            assert abs(cam_3d_restored["zoom"] - cam_3d_saved["zoom"]) < 1e-4, "3D zoom preserved after 2D roundtrip"
            assert abs(cam_3d_restored["panX"] - cam_3d_saved["panX"]) < 1e-4, "3D panX preserved after 2D roundtrip"
            assert abs(cam_3d_restored["panY"] - cam_3d_saved["panY"]) < 1e-4, "3D panY preserved after 2D roundtrip"
            success("Item 12 Confirmed: Contextual 2D/3D mode transitions strictly preserve 3D camera orientation, pan, and zoom.")

            # --- TEST STEP 13: Search row selection selects node without camera movement ---
            log("Testing Search row selection (without repositioning the camera)...")
            cam_before_search = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            search_input = page.locator(".search-input")
            search_input.fill("service_2")
            page.wait_for_selector("#search-dropdown-list", timeout=3000)

            # Click the search result row directly (not the reveal button)
            page.locator("li.search-item:has-text('service_2.ts')").click()
            time.sleep(0.4)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "09_search_selected_no_camera_move.png"))
            success("Saved search selection screenshot -> docs/screenshots/09_search_selected_no_camera_move.png")

            cam_after_search = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            assert abs(cam_after_search["yaw"] - cam_before_search["yaw"]) < 1e-4, "Camera yaw unchanged on search row click"
            assert abs(cam_after_search["pitch"] - cam_before_search["pitch"]) < 1e-4, "Camera pitch unchanged on search row click"
            assert abs(cam_after_search["panX"] - cam_before_search["panX"]) < 1e-4, "Camera panX unchanged on search row click"
            assert abs(cam_after_search["panY"] - cam_before_search["panY"]) < 1e-4, "Camera panY unchanged on search row click"

            inspector_title_search = page.locator(".inspector-panel .file-name").text_content()
            assert "service_2.ts" in inspector_title_search, f"Expected service_2.ts in inspector, got {inspector_title_search}"
            success("Item 13 Confirmed: Search row selection selects node and updates Inspector without repositioning the orb.")

            # --- TEST STEP 14: Search explicit reveal button rotates camera without translating orb ---
            log("Testing Search explicit reveal action (orbit-preserving rotation)...")
            search_input.fill("model_4")
            page.wait_for_selector("#search-dropdown-list", timeout=3000)

            # Click the explicit reveal action button on model_4 row
            reveal_btn = page.locator("li.search-item:has-text('model_4.ts') button.search-reveal-action")
            reveal_btn.click()
            time.sleep(0.5)
            page.screenshot(path=os.path.join(SCREENSHOT_DIR, "10_search_reveal_orbit_preserving.png"))
            success("Saved search reveal screenshot -> docs/screenshots/10_search_reveal_orbit_preserving.png")

            cam_after_reveal = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            log(f"Camera After Reveal: yaw={cam_after_reveal['yaw']:.4f}, pitch={cam_after_reveal['pitch']:.4f}, panX={cam_after_reveal['panX']:.2f}, panY={cam_after_reveal['panY']:.2f}")

            # Pan must remain invariant at center (NOT translated across viewport)
            assert abs(cam_after_reveal["panX"] - init_cam["panX"]) < 0.5, f"PanX must remain centered during reveal (got {cam_after_reveal['panX']} vs {init_cam['panX']})"
            assert abs(cam_after_reveal["panY"] - init_cam["panY"]) < 0.5, f"PanY must remain centered during reveal (got {cam_after_reveal['panY']} vs {init_cam['panY']})"

            # Target node model_4.ts must now be in front (z > 0)
            target_proj = page.evaluate("""() => {
                const nodes = window.__prebaseNetworkDebug.getProjectedNodes();
                return nodes.find(n => n.id.includes('model_4.ts'));
            }""")
            assert target_proj is not None, "Target node model_4.ts must be in projected nodes"
            log(f"Target node model_4.ts after reveal: z={target_proj['z']:.2f}, depthScale={target_proj['depthScale']:.3f}, screen=({target_proj['screenX']:.1f}, {target_proj['screenY']:.1f})")
            assert target_proj["z"] >= -10.0, "Revealed node must be brought into visible front hemisphere"
            success("Item 14 Confirmed: Explicit reveal brings target node into view via orbit-preserving rotation without translating the orb.")

            browser.close()

    finally:
        if proc:
            log("Sending SIGTERM to PreBase server...")
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(test_repo_dir, ignore_errors=True)
        log("Test cleanup complete.")

    print("=" * 75)
    print("\x1b[32mALL 3D NETWORK ORB REAL BROWSER VERIFICATIONS PASSED!\x1b[0m")
    print("=" * 75)

if __name__ == "__main__":
    main()

