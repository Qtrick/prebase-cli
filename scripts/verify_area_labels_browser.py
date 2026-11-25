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
    """CSP-safe polling loop that waits for all label motion transitions to settle."""
    start = time.monotonic()
    while time.monotonic() - start < timeout_sec:
        active_count = page.evaluate("() => window.__prebaseNetworkDebug?.getMotionTimeline?.()?.activeCount || 0")
        if active_count == 0:
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

            # Record initial positions and motion states
            prev_anchors = {a["areaId"]: a for a in page.evaluate("() => window.__prebaseNetworkDebug?.getProjectedAreaAnchors() || []")}
            prev_labels = {l["areaId"]: l for l in page.evaluate("() => window.__prebaseNetworkDebug?.getRenderedAreaLabels() || []")}
            prev_motions = {m["areaId"]: m for m in page.evaluate("() => window.__prebaseNetworkDebug?.getMotionStates() || []")}

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
            candidate_switch_count = 0
            relocation_start_count = 0
            switches_per_area = {}

            for step_x, step_y in micro_steps:
                page.mouse.move(step_x, step_y)
                time.sleep(0.04)

                curr_anchors = {a["areaId"]: a for a in page.evaluate("() => window.__prebaseNetworkDebug?.getProjectedAreaAnchors() || []")}
                curr_labels = {l["areaId"]: l for l in page.evaluate("() => window.__prebaseNetworkDebug?.getRenderedAreaLabels() || []")}
                curr_motions = {m["areaId"]: m for m in page.evaluate("() => window.__prebaseNetworkDebug?.getMotionStates() || []")}

                for area_id, curr_lbl in curr_labels.items():
                    if area_id in prev_labels and area_id in curr_anchors and area_id in prev_anchors and area_id in prev_motions:
                        prev_lbl = prev_labels[area_id]
                        prev_m = prev_motions[area_id]
                        curr_m = curr_motions.get(area_id, {})

                        if curr_m.get("candidateIndex") != prev_m.get("candidateIndex"):
                            candidate_switch_count += 1
                            switches_per_area.setdefault(area_id, []).append((prev_m.get("candidateIndex"), curr_m.get("candidateIndex")))
                            continue

                        if curr_m.get("isRelocating") or prev_m.get("isRelocating"):
                            relocation_start_count += 1
                            continue

                        # Assert 1:1 camera-coupled tracking for stable labels: displacement of label must equal anchor displacement
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
                prev_motions = curr_motions

            page.mouse.up()
            time.sleep(0.15)
            # Harmless micro-drags must maintain 1:1 tracking without ping-pong oscillation
            oscillating = {k: v for k, v in switches_per_area.items() if len(v) > 1}
            assert not oscillating, f"Candidate ping-pong oscillation detected during micro-drag: {oscillating}"
            assert candidate_switch_count <= 4, f"Unexpected excessive candidate switches across labels during micro-drag: {candidate_switch_count}"
            assert micro_tested_count >= 50, f"Expected at least 50 verified frame comparisons across all visible labels, got {micro_tested_count}"
            print(f"[PASS] Continuous micro-movement tracking verified ({micro_tested_count} frame comparisons, {candidate_switch_count} one-way boundary switches across {len(switches_per_area)} areas, zero oscillation/lag/teleportation).")

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
            drag_relocations_or_switches = 0
            drag_frame_samples = 0
            prev_drag_candidates = {
                m["areaId"]: m.get("candidateIndex")
                for m in page.evaluate("() => window.__prebaseNetworkDebug?.getMotionStates() || []")
            }

            for step_i in range(1, drag_steps + 1):
                tx = cx - (180.0 * step_i / drag_steps)
                ty = cy + (50.0 * step_i / drag_steps)
                page.mouse.move(tx, ty)
                time.sleep(0.035)

                sample = page.evaluate("""() => ({
                    labels: window.__prebaseNetworkDebug?.getRenderedAreaLabels() || [],
                    motions: window.__prebaseNetworkDebug?.getMotionStates() || []
                })""")
                drag_frame_samples += 1

                # Verify no two settled (non-relocating) visible area labels overlap each other mid-drag
                vis_labels = sample["labels"]
                motion_by_id = {m["areaId"]: m for m in sample["motions"]}
                for i in range(len(vis_labels)):
                    id1 = vis_labels[i]["areaId"]
                    if motion_by_id.get(id1, {}).get("isRelocating"):
                        continue
                    r1 = vis_labels[i]["rect"]
                    for j in range(i + 1, len(vis_labels)):
                        id2 = vis_labels[j]["areaId"]
                        if motion_by_id.get(id2, {}).get("isRelocating"):
                            continue
                        r2 = vis_labels[j]["rect"]
                        overlap_x = min(r1["x2"], r2["x2"]) - max(r1["x1"], r2["x1"])
                        overlap_y = min(r1["y2"], r2["y2"]) - max(r1["y1"], r2["y1"])
                        assert not (overlap_x > 2.0 and overlap_y > 2.0), (
                            f"Settled area labels overlapped mid-drag: {id1} and {id2}"
                        )

                for m in sample["motions"]:
                    aid = m["areaId"]
                    if m.get("isRelocating") or (aid in prev_drag_candidates and prev_drag_candidates[aid] != m.get("candidateIndex")):
                        drag_relocations_or_switches += 1
                    prev_drag_candidates[aid] = m.get("candidateIndex")

            page.mouse.up()
            assert drag_frame_samples == drag_steps
            assert drag_relocations_or_switches > 0, "Expected dynamic label relocations/switches DURING active drag (no interaction lock)"
            if not wait_for_motion_settled(page, timeout_sec=5.0):
                timeline_state = page.evaluate("() => window.__prebaseNetworkDebug?.getMotionTimeline?.()")
                raise AssertionError(f"Label motion failed to settle after active drag: {timeline_state}")

            rotated_labels = page.evaluate("() => window.__prebaseNetworkDebug?.getRenderedAreaLabels() || []")
            for i in range(len(rotated_labels)):
                r1 = rotated_labels[i]["rect"]
                for j in range(i + 1, len(rotated_labels)):
                    r2 = rotated_labels[j]["rect"]
                    overlap_x = min(r1["x2"], r2["x2"]) - max(r1["x1"], r2["x1"])
                    overlap_y = min(r1["y2"], r2["y2"]) - max(r1["y1"], r2["y1"])
                    assert not (overlap_x > 2.0 and overlap_y > 2.0), (
                        f"Settled area labels overlapped after drag: {rotated_labels[i]['areaId']} and {rotated_labels[j]['areaId']}"
                    )
            print(f"[PASS] Active drag continuous placement verified ({drag_frame_samples} mid-drag samples, {drag_relocations_or_switches} active-drag relocations/switches, zero settled overlaps, settled cleanly).")
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
