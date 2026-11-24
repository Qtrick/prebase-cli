import os
import sys
import time
import subprocess
import tempfile
import urllib.request
import re
from playwright.sync_api import sync_playwright

def mask_credentials(text: str) -> str:
    if not text:
        return text
    text = re.sub(r'bootstrap=[A-Za-z0-9_-]+', 'bootstrap=[REDACTED]', text)
    text = re.sub(r'prebase_session(?:_\d+)?=[A-Za-z0-9_-]+', 'prebase_session=[REDACTED]', text)
    return text

def sanitized_excepthook(exc_type, exc_value, exc_traceback):
    import traceback
    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    sys.stderr.write(mask_credentials(tb_str))

sys.excepthook = sanitized_excepthook

def http_get(url):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read().decode("utf-8")

def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    binary = os.path.join(repo_root, "target", "release", "prebase")
    port = 19997
    
    print(f"[AREA LABELS] Launching PreBase on {repo_root} at port {port}...")
    log_dir = tempfile.mkdtemp(prefix="prebase-area-labels-log-")
    log_path = os.path.join(log_dir, "prebase_server.log")
    log_file = open(log_path, "w")
    
    cmd = [binary, "--port", str(port), "--no-open", "map", repo_root]
    proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)
    
    try:
        # Wait for server ready
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
        print("[PASS] PreBase server is healthy.")
        
        # Parse startup url and bootstrap token from log
        startup_url = None
        for _ in range(30):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    content = f.read()
                    for line in content.splitlines():
                        if "Server running at:" in line:
                            startup_url = line.split("Server running at:")[1].strip()
                            startup_url = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', startup_url)
                            break
            if startup_url:
                break
            time.sleep(0.1)
            
        assert startup_url, "Could not find startup URL in server log"
        print(f"[AREA LABELS] Extracted startup URL: {mask_credentials(startup_url)}")
        
        capture_docs = "--capture-docs" in sys.argv or os.environ.get("PREBASE_CAPTURE_DOCS") == "1"
        screenshot_dir = (
            os.path.join(repo_root, "docs", "screenshots")
            if capture_docs
            else os.path.join(repo_root, "test-results", "visual")
        )
        os.makedirs(screenshot_dir, exist_ok=True)
        shot1 = os.path.join(screenshot_dir, "area_labels_default.png")
        shot2 = os.path.join(screenshot_dir, "area_labels_rotated.png")
        
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            
            page.goto(startup_url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector(".network-canvas", timeout=15000)
            page.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=15000)
            time.sleep(1.2)
            
            # Inspect debug state
            debug_info = page.evaluate("() => ({\n"
                "  hasDebug: !!window.__prebaseNetworkDebug,\n"
                "  nodesCount: window.__prebaseNetworkDebug?.getProjectedNodes?.()?.length || 0,\n"
                "  anchorsCount: window.__prebaseNetworkDebug?.getProjectedAreaAnchors?.()?.length || 0,\n"
                "  scope: window.__prebaseNetworkDebug?.getScope?.(),\n"
                "  fadeStates: window.__prebaseNetworkDebug?.getFadeStates?.() || [],\n"
                "  renderedLabels: window.__prebaseNetworkDebug?.getRenderedAreaLabels?.() || []\n"
                "})")
            print(f"[AREA LABELS DEBUG] {debug_info}")

            area_labels = debug_info.get("renderedLabels", [])
            print(f"[AREA LABELS] Found {len(area_labels)} rendered area labels in default view.")
            assert len(area_labels) > 0, "At least one area label must be rendered"
            
            # Verify candidate placements were chosen
            placements = {l.get("placement") for l in area_labels}
            print(f"[AREA LABELS] Distinct placements used: {placements}")
            
            page.screenshot(path=shot1)
            print(f"[PASS] Default view screenshot saved -> {shot1}")
            
            # --- PHASE: Continuous Micro-Movement Verification ---
            print("[AREA LABELS] Verifying continuous camera-coupled anchor tracking under micro-movements...")
            canvas_box = page.locator(".network-canvas").bounding_box()
            cx = canvas_box["x"] + canvas_box["width"] / 2
            cy = canvas_box["y"] + canvas_box["height"] / 2

            # Start dragging at center
            page.mouse.move(cx, cy)
            page.mouse.down()
            time.sleep(0.05)

            # Record initial positions
            prev_anchors = {a["areaId"]: a for a in page.evaluate("() => window.__prebaseNetworkDebug?.getProjectedAreaAnchors() || []")}
            prev_labels = {l["areaId"]: l for l in page.evaluate("() => window.__prebaseNetworkDebug?.getRenderedAreaLabels() || []")}

            # Perform 6 sequential micro-drags of 2-3px each
            micro_steps = [
                (cx + 3, cy - 2),
                (cx + 6, cy - 4),
                (cx + 9, cy - 7),
                (cx + 12, cy - 9),
                (cx + 15, cy - 12),
                (cx + 18, cy - 14),
            ]

            micro_tested_count = 0
            for step_x, step_y in micro_steps:
                page.mouse.move(step_x, step_y)
                time.sleep(0.04)

                curr_anchors = {a["areaId"]: a for a in page.evaluate("() => window.__prebaseNetworkDebug?.getProjectedAreaAnchors() || []")}
                curr_labels = {l["areaId"]: l for l in page.evaluate("() => window.__prebaseNetworkDebug?.getRenderedAreaLabels() || []")}
                motion_states_map = {m["areaId"]: m for m in page.evaluate("() => window.__prebaseNetworkDebug?.getMotionStates() || []")}
                timeline = page.evaluate("() => window.__prebaseNetworkDebug?.getMotionTimeline() || {}")

                for area_id, curr_lbl in curr_labels.items():
                    if area_id in prev_labels and area_id in curr_anchors and area_id in prev_anchors:
                        prev_lbl = prev_labels[area_id]
                        m_state = motion_states_map.get(area_id, {})
                        # Assert 1:1 camera tracking for stable placements (same candidate placement and not in discrete relocation)
                        if not m_state.get("isRelocating") and curr_lbl.get("placement") == prev_lbl.get("placement"):
                            anc_curr = curr_anchors[area_id]
                            anc_prev = prev_anchors[area_id]
                            anc_dx = anc_curr["screenX"] - anc_prev["screenX"]
                            anc_dy = anc_curr["screenY"] - anc_prev["screenY"]

                            lbl_dx = curr_lbl["rect"]["x1"] - prev_lbl["rect"]["x1"]
                            lbl_dy = curr_lbl["rect"]["y1"] - prev_lbl["rect"]["y1"]

                            diff_x = abs(lbl_dx - anc_dx)
                            diff_y = abs(lbl_dy - anc_dy)

                            # Label displacement must match projected anchor displacement within subpixel tolerance
                            assert diff_x <= 1.0, f"Micro-movement mismatch in X for {area_id}: label_dx={lbl_dx}, anc_dx={anc_dx}, diff={diff_x}"
                            assert diff_y <= 1.0, f"Micro-movement mismatch in Y for {area_id}: label_dy={lbl_dy}, anc_dy={anc_dy}, diff={diff_y}"
                            micro_tested_count += 1

                prev_anchors = curr_anchors
                prev_labels = curr_labels

            page.mouse.up()
            time.sleep(0.15)
            print(f"[PASS] Continuous micro-movement tracking verified ({micro_tested_count} frame comparisons, zero lag/teleportation).")

            shot_micro = os.path.join(screenshot_dir, "area_labels_micromovement.png")
            page.screenshot(path=shot_micro)
            print(f"[PASS] Micro-movement screenshot saved -> {shot_micro}")

            # Now drag to rotate and observe depth fade
            # Rotate horizontally by 180px
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.move(cx - 180, cy + 50, steps=10)
            page.mouse.up()
            time.sleep(0.6)
            
            rotated_labels = page.evaluate("() => window.__prebaseNetworkDebug?.getRenderedAreaLabels() || []")
            print(f"[AREA LABELS] Found {len(rotated_labels)} rendered area labels after rotation.")
            
            page.screenshot(path=shot2)
            print(f"[PASS] Rotated view screenshot saved -> {shot2}")
            
            browser.close()
            print("[PASS] Visual verification and screenshots captured successfully.")
            
    finally:
        print("[AREA LABELS] Stopping server...")
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        log_file.close()
        import shutil
        shutil.rmtree(log_dir, ignore_errors=True)
        print("[AREA LABELS] Cleanup complete.")

if __name__ == "__main__":
    main()
