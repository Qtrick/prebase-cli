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

def wait_for_motion_settled(page, timeout_sec=5.0):
    """CSP-safe polling loop that waits for all label fade/rAF transitions to settle."""
    start = time.monotonic()
    while time.monotonic() - start < timeout_sec:
        snap = page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.() || null")
        if snap is not None and not snap.get("isAnyFadeActive", False):
            return True
        time.sleep(0.03)
    return False

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

            # Ensure initial layout and entry relocations settle completely (CSP-safe)
            assert wait_for_motion_settled(page, timeout_sec=5.0), "Initial label motion failed to settle"
            time.sleep(0.1)

            # Start dragging at center
            page.mouse.move(cx, cy)
            page.mouse.down()
            time.sleep(0.05)

            # Wait for gesture start stabilization if any hover change occurred (CSP-safe)
            wait_for_motion_settled(page, timeout_sec=2.0)

            # Record initial positions atomically via getFrameSnapshot()
            init_snap = page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.() || { anchors: [], renderedLabels: [] }")
            prev_anchors = {a["areaId"]: a for a in init_snap.get("anchors", [])}
            prev_labels = {l["areaId"]: l for l in init_snap.get("renderedLabels", [])}

            # Perform 10 sequential micro-drags of 2-3px each (including directional reversals)
            micro_steps = [
                (cx + 2, cy - 1),
                (cx + 4, cy - 2),
                (cx + 7, cy - 4),
                (cx + 10, cy - 6),
                (cx + 12, cy - 8),
                # Reversal / small back-and-forth
                (cx + 10, cy - 7),
                (cx + 8, cy - 5),
                (cx + 11, cy - 6),
                (cx + 14, cy - 8),
                (cx + 16, cy - 9),
            ]

            micro_tested_count = 0

            for step_x, step_y in micro_steps:
                page.mouse.move(step_x, step_y)
                time.sleep(0.04)

                snap = page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.() || { anchors: [], renderedLabels: [] }")
                curr_anchors = {a["areaId"]: a for a in snap.get("anchors", [])}
                curr_labels = {l["areaId"]: l for l in snap.get("renderedLabels", [])}

                for area_id, curr_lbl in curr_labels.items():
                    if area_id in prev_labels and area_id in curr_anchors and area_id in prev_anchors:
                        prev_lbl = prev_labels[area_id]

                        # NO MOVING LABEL MAY BE EXCLUDED: verify EVERY visible label's positional continuity
                        anc_curr = curr_anchors[area_id]
                        anc_prev = prev_anchors[area_id]
                        anc_dx = anc_curr["screenX"] - anc_prev["screenX"]
                        anc_dy = anc_curr["screenY"] - anc_prev["screenY"]

                        lbl_dx = curr_lbl["rect"]["x1"] - prev_lbl["rect"]["x1"]
                        lbl_dy = curr_lbl["rect"]["y1"] - prev_lbl["rect"]["y1"]

                        rel_jump = ((lbl_dx - anc_dx) ** 2 + (lbl_dy - anc_dy) ** 2) ** 0.5
                        assert rel_jump <= 6.0, (
                            f"Micro-movement disproportion for {area_id}: "
                            f"anchor delta=({anc_dx:.2f},{anc_dy:.2f}), label delta=({lbl_dx:.2f},{lbl_dy:.2f}), "
                            f"relative jump={rel_jump:.2f}px > 6.0px"
                        )
                        micro_tested_count += 1

                prev_anchors = curr_anchors
                prev_labels = curr_labels

            # Test B (Real Browser): Hold pointer stationary while mouse is down -> zero autonomous drift
            hold_baseline = {
                l["areaId"]: l["rect"]
                for l in (page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.()?.renderedLabels || []"))
            }
            for hold_ms in [50, 50, 120, 130, 150]:  # cumulative: 50, 100, 220, 350, 500ms
                time.sleep(hold_ms / 1000.0)
                hold_now = {
                    l["areaId"]: l["rect"]
                    for l in (page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.()?.renderedLabels || []"))
                }
                for aid, r_now in hold_now.items():
                    if aid in hold_baseline:
                        r0 = hold_baseline[aid]
                        drift = ((r_now["x1"] - r0["x1"]) ** 2 + (r_now["y1"] - r0["y1"]) ** 2) ** 0.5
                        assert drift <= 0.5, (
                            f"Autonomous label drift while pointer held stationary for {aid}: {drift:.2f}px > 0.5px"
                        )

            page.mouse.up()
            time.sleep(0.15)
            assert micro_tested_count >= 50, f"Expected at least 50 verified frame comparisons across all visible labels, got {micro_tested_count}"
            print(f"[PASS] Continuous micro-movement + stationary-hold tracking verified ({micro_tested_count} frame comparisons, 0 autonomous drift).")

            shot_micro = os.path.join(screenshot_dir, "area_labels_micromovement.png")
            page.screenshot(path=shot_micro)
            print(f"[PASS] Micro-movement screenshot saved -> {shot_micro}")

            # --- PHASE: Active Drag & Continuous Dynamic Placement Verification ---
            print("[AREA LABELS] Verifying continuous dynamic placement DURING active drag (no interaction lock)...")
            assert wait_for_motion_settled(page, timeout_sec=5.0), "Motion failed to settle before active drag test"
            page.mouse.move(cx, cy)
            page.mouse.down()
            time.sleep(0.03)

            drag_steps = 12
            drag_offset_adaptations = 0
            drag_frame_samples = 0
            start_snap = page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.() || { anchors: [], renderedLabels: [] }")
            start_anchors = {a["areaId"]: a for a in start_snap.get("anchors", [])}
            prev_offsets = {
                l["areaId"]: (l["rect"]["x1"] - start_anchors[l["areaId"]]["screenX"], l["rect"]["y1"] - start_anchors[l["areaId"]]["screenY"])
                for l in start_snap.get("renderedLabels", [])
                if l["areaId"] in start_anchors
            }

            for step_i in range(1, drag_steps + 1):
                tx = cx - (180.0 * step_i / drag_steps)
                ty = cy + (50.0 * step_i / drag_steps)
                page.mouse.move(tx, ty)
                time.sleep(0.035)

                snap = page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.() || { anchors: [], renderedLabels: [] }")
                drag_frame_samples += 1

                # Verify no two visible area labels overlap each other mid-drag
                vis_labels = snap.get("renderedLabels", [])
                snap_anchors = {a["areaId"]: a for a in snap.get("anchors", [])}
                for i in range(len(vis_labels)):
                    r1 = vis_labels[i]["rect"]
                    for j in range(i + 1, len(vis_labels)):
                        r2 = vis_labels[j]["rect"]
                        overlap_x = min(r1["x2"], r2["x2"]) - max(r1["x1"], r2["x1"])
                        overlap_y = min(r1["y2"], r2["y2"]) - max(r1["y1"], r2["y1"])
                        assert not (overlap_x > 2.0 and overlap_y > 2.0), (
                            f"Area labels overlapped mid-drag: {vis_labels[i]['areaId']} and {vis_labels[j]['areaId']}"
                        )

                curr_offsets = {}
                for lbl in vis_labels:
                    aid = lbl["areaId"]
                    if aid in snap_anchors:
                        anc = snap_anchors[aid]
                        off = (lbl["rect"]["x1"] - anc["screenX"], lbl["rect"]["y1"] - anc["screenY"])
                        curr_offsets[aid] = off
                        if aid in prev_offsets:
                            step_off_delta = ((off[0] - prev_offsets[aid][0]) ** 2 + (off[1] - prev_offsets[aid][1]) ** 2) ** 0.5
                            if step_off_delta > 0.5:
                                drag_offset_adaptations += 1
                            assert step_off_delta <= 25.0, (
                                f"Disproportionate relative offset jump during active drag for {aid}: {step_off_delta:.2f}px"
                            )
                prev_offsets = curr_offsets

            page.mouse.up()
            assert drag_frame_samples == drag_steps
            assert drag_offset_adaptations > 0, "Expected continuous relative offset adaptation DURING active drag"
            if not wait_for_motion_settled(page, timeout_sec=5.0):
                raise AssertionError("Label fade/rAF failed to settle after active drag")

            rotated_labels = page.evaluate("() => window.__prebaseNetworkDebug?.getFrameSnapshot?.()?.renderedLabels || []")
            for i in range(len(rotated_labels)):
                r1 = rotated_labels[i]["rect"]
                for j in range(i + 1, len(rotated_labels)):
                    r2 = rotated_labels[j]["rect"]
                    overlap_x = min(r1["x2"], r2["x2"]) - max(r1["x1"], r2["x1"])
                    overlap_y = min(r1["y2"], r2["y2"]) - max(r1["y1"], r2["y1"])
                    assert not (overlap_x > 2.0 and overlap_y > 2.0), (
                        f"Settled area labels overlapped after drag: {rotated_labels[i]['areaId']} and {rotated_labels[j]['areaId']}"
                    )
            print(f"[PASS] Active drag continuous placement verified ({drag_frame_samples} mid-drag samples, {drag_offset_adaptations} smooth offset adaptations, zero overlaps, settled cleanly).")
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
