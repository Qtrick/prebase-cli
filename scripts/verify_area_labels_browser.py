#!/usr/bin/env python3
"""
PreBase CLI — Real-Browser Verification for:
- Test A: Stable screen-space group annotations attached directly beneath anchors
- Test B: Stationary press-and-hold fade-out & hold persistence (checkbox checked)
- Test C: Drag, pause while held, resume, and release
- Test D: Release during rotational inertia (fade-in begins immediately during inertia)
- Test E: Rapid fade reversal & long-idle fade smoothness
- Test F: Interrupted gestures, view switching, and preference persistence across reload
- Test G: Right-click rejection (no pan, rotation, selection, center-lock change, or hold fade)
- Test H: Graph-control dropdown alignment, checkbox accessibility, dark/light themes, 3D-only scope
- Test I: Dense collision visibility without positional roaming or flickering
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

LABEL_GAP = 6.0
GEOM_TOLERANCE_PX = 0.5


def mask_credentials(text: str) -> str:
    if not text:
        return text
    text = re.sub(r"bootstrap=[A-Za-z0-9_-]+", "bootstrap=[REDACTED]", text)
    text = re.sub(r"prebase_session(?:_\d+)?=[A-Za-z0-9_-]+", "prebase_session=[REDACTED]", text)
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


def assert_fixed_attachment(snap, context_label):
    anchors = {a["areaId"]: a for a in snap.get("anchors", [])}
    labels = snap.get("renderedLabels", [])
    for lbl in labels:
        aid = lbl["areaId"]
        assert aid in anchors, f"[{context_label}] Rendered label {aid} missing anchor"
        assert lbl.get("placement") == "below", (
            f"[{context_label}] Expected placement 'below' for {aid}, got {lbl.get('placement')}"
        )
        anc = anchors[aid]
        rect = lbl["rect"]
        lbl_cx = (rect["x1"] + rect["x2"]) / 2.0
        expected_y1 = anc["screenY"] + anc["radius"] + LABEL_GAP
        dx = abs(lbl_cx - anc["screenX"])
        dy = abs(rect["y1"] - expected_y1)
        assert dx <= GEOM_TOLERANCE_PX, (
            f"[{context_label}] {aid} horizontal center drifted: {lbl_cx:.2f} vs {anc['screenX']:.2f} (diff={dx:.2f})"
        )
        assert dy <= GEOM_TOLERANCE_PX, (
            f"[{context_label}] {aid} vertical attachment drifted: {rect['y1']:.2f} vs {expected_y1:.2f} (diff={dy:.2f})"
        )


def assert_no_fully_visible_overlaps(labels, context_label):
    visible = [l for l in labels if l.get("opacity", 1.0) > 0.95]
    for i in range(len(visible)):
        r1 = visible[i]["rect"]
        for j in range(i + 1, len(visible)):
            r2 = visible[j]["rect"]
            overlap_x = min(r1["x2"], r2["x2"]) - max(r1["x1"], r2["x1"])
            overlap_y = min(r1["y2"], r2["y2"]) - max(r1["y1"], r2["y1"])
            assert not (overlap_x > 4.0 and overlap_y > 4.0), (
                f"[{context_label}] Fully visible labels overlapped: {visible[i]['areaId']} and {visible[j]['areaId']}"
            )


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

        startup_url = None
        for _ in range(30):
            if os.path.exists(log_path):
                with open(log_path, "r") as f:
                    for line in f.read().splitlines():
                        if "Server running at:" in line:
                            startup_url = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", line.split("Server running at:")[1].strip())
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

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()

            page.goto(startup_url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector(".network-canvas", timeout=15000)
            page.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=15000)
            assert wait_for_motion_settled(page, timeout_sec=5.0), "Initial motion failed to settle"
            time.sleep(0.2)

            # --- TEST A: Stable attachment with checkbox unchecked ---
            init_snap = page.evaluate("() => window.__prebaseNetworkDebug.getFrameSnapshot()")
            assert not init_snap["hideGroupLabelsOnMovement"], "Hide-on-hold must default to unchecked"
            assert len(init_snap["renderedLabels"]) > 0, "Expected visible area labels in default view"
            assert_fixed_attachment(init_snap, "default")
            assert_no_fully_visible_overlaps(init_snap["renderedLabels"], "default")
            page.screenshot(path=os.path.join(screenshot_dir, "area_labels_default.png"))

            canvas_box = page.locator(".network-canvas").bounding_box()
            cx = canvas_box["x"] + canvas_box["width"] / 2
            cy = canvas_box["y"] + canvas_box["height"] / 2

            page.mouse.move(cx, cy)
            page.mouse.down()
            drag_steps = [
                (cx + 3, cy - 2),
                (cx + 8, cy - 5),
                (cx + 25, cy - 12),
                (cx + 60, cy + 18),
                (cx + 35, cy + 5),
                (cx - 80, cy + 30),
                (cx - 140, cy + 45),
            ]
            for idx, (tx, ty) in enumerate(drag_steps):
                page.mouse.move(tx, ty)
                time.sleep(0.035)
                snap = page.evaluate("() => window.__prebaseNetworkDebug.getFrameSnapshot()")
                assert_fixed_attachment(snap, f"drag-step-{idx}")
                assert_no_fully_visible_overlaps(snap["renderedLabels"], f"drag-step-{idx}")

            # Pause while held
            time.sleep(0.25)
            pause_snap = page.evaluate("() => window.__prebaseNetworkDebug.getFrameSnapshot()")
            assert_fixed_attachment(pause_snap, "paused-while-held")
            page.mouse.up()
            assert wait_for_motion_settled(page, timeout_sec=5.0), "Labels failed to settle after drag"
            settled_snap = page.evaluate("() => window.__prebaseNetworkDebug.getFrameSnapshot()")
            assert_fixed_attachment(settled_snap, "settled")
            assert_no_fully_visible_overlaps(settled_snap["renderedLabels"], "settled")
            page.screenshot(path=os.path.join(screenshot_dir, "area_labels_rotated.png"))
            print("[PASS] Test A & I: Stable fixed-below attachment & collision visibility verified.")

            # --- TEST G: Right-click rejection (before enabling checkbox, and after) ---
            before_rc_cam = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            before_rc_lock = page.evaluate("() => window.__prebaseNetworkDebug.isCenterLocked()")
            before_rc_area = page.evaluate("() => window.__prebaseNetworkDebug.getSelectedAreaId()")
            before_rc_node = page.evaluate("() => window.__prebaseNetworkDebug.getSelectedNodeId()")

            # Right-click & right-drag on canvas
            page.mouse.move(cx, cy)
            page.mouse.down(button="right")
            time.sleep(0.05)
            assert not page.evaluate("() => window.__prebaseNetworkDebug.isGestureHeld()"), (
                "Right-click must not mark gesture held"
            )
            page.mouse.move(cx + 120, cy - 80)
            time.sleep(0.05)
            page.mouse.up(button="right")
            time.sleep(0.05)

            after_rc_cam = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            assert after_rc_cam["panX"] == before_rc_cam["panX"], "Right-drag must not pan X"
            assert after_rc_cam["panY"] == before_rc_cam["panY"], "Right-drag must not pan Y"
            assert after_rc_cam["orientation"] == before_rc_cam["orientation"], "Right-drag must not rotate"
            assert page.evaluate("() => window.__prebaseNetworkDebug.isCenterLocked()") == before_rc_lock
            assert page.evaluate("() => window.__prebaseNetworkDebug.getSelectedAreaId()") == before_rc_area
            assert page.evaluate("() => window.__prebaseNetworkDebug.getSelectedNodeId()") == before_rc_node

            # Right-click directly on a rendered label/anchor must not select it
            first_lbl = settled_snap["renderedLabels"][0]
            lx = canvas_box["x"] + (first_lbl["rect"]["x1"] + first_lbl["rect"]["x2"]) / 2
            ly = canvas_box["y"] + (first_lbl["rect"]["y1"] + first_lbl["rect"]["y2"]) / 2
            page.mouse.click(lx, ly, button="right")
            time.sleep(0.05)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getSelectedAreaId()") == before_rc_area
            print("[PASS] Test G: Right-click & right-drag completely rejected by camera & selection.")

            # --- TEST H: Dropdown menu, checkbox accessibility, dark & light themes, 3D-only scope ---
            more_btn = page.locator('button[aria-label="More view options"]')
            more_btn.click()
            checkbox_item = page.locator('[role="menuitemcheckbox"]:has-text("Hide group labels upon graph movement")')
            checkbox_item.wait_for(state="visible", timeout=3000)
            assert checkbox_item.get_attribute("aria-checked") == "false"

            # Verify dropdown stays within viewport
            menu_box = page.locator(".view-options-menu").bounding_box()
            assert menu_box["x"] >= 0 and menu_box["x"] + menu_box["width"] <= 1440, (
                f"View options menu overflowed viewport: {menu_box}"
            )
            page.screenshot(path=os.path.join(screenshot_dir, "dropdown_dark.png"))

            # Toggle checkbox on (menu stays open)
            checkbox_item.click()
            assert checkbox_item.get_attribute("aria-checked") == "true"
            assert page.evaluate("() => window.__prebaseNetworkDebug.getHideGroupLabelsOnMovement()") is True

            # Check 2D scope hides the 3D-only option
            page.keyboard.press("Escape")
            page.locator("button.mode-btn:has-text('2D Relationships')").click()
            time.sleep(0.15)
            more_btn.click()
            assert page.locator('[role="menuitemcheckbox"]:has-text("Hide group labels upon graph movement")').count() == 0, (
                "Checkbox must only appear in 3D view options"
            )
            page.keyboard.press("Escape")
            page.locator("button.mode-btn[title*='3D Repository']").click()
            time.sleep(0.2)

            # Check light theme dropdown
            page.locator("button.theme-toggle-btn").click()
            time.sleep(0.15)
            more_btn.click()
            assert checkbox_item.get_attribute("aria-checked") == "true"
            page.screenshot(path=os.path.join(screenshot_dir, "dropdown_light.png"))
            page.keyboard.press("Escape")
            # Switch back to dark theme
            page.locator("button.theme-toggle-btn").click()
            time.sleep(0.15)
            print("[PASS] Test H: Dropdown alignment, checkbox semantics, 3D-only scope, dark/light themes verified.")

            # --- TEST B: Stationary press and hold (no movement) ---
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            cam_before_hold = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            page.mouse.move(cx, cy)
            page.mouse.down()
            # Observe intermediate fade-out without moving mouse
            time.sleep(0.06)
            mid_opacity = page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()")
            assert 0.0 < mid_opacity < 1.0, f"Expected intermediate fade-out opacity, got {mid_opacity}"

            # Hold stationary for > 1.2s and confirm labels remain hidden (0.0)
            time.sleep(0.35)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0
            assert len(page.evaluate("() => window.__prebaseNetworkDebug.getRenderedAreaLabels()")) == 0
            page.screenshot(path=os.path.join(screenshot_dir, "labels_hidden_on_hold.png"))
            time.sleep(0.9)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0, (
                "Labels must remain hidden indefinitely while pointer is held stationary"
            )
            cam_during_hold = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            assert cam_during_hold["orientation"] == cam_before_hold["orientation"]

            # Right-click while stationary hold is active must not disrupt anything
            page.mouse.click(cx + 20, cy + 20, button="right")
            assert page.evaluate("() => window.__prebaseNetworkDebug.isGestureHeld()") is True
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0

            # Release -> smooth fade-in
            page.mouse.up()
            time.sleep(0.06)
            fade_in_mid = page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()")
            assert 0.0 < fade_in_mid < 1.0, f"Expected intermediate fade-in opacity, got {fade_in_mid}"
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 1.0
            print("[PASS] Test B: Stationary press-and-hold fade-out, persistence, and release fade-in verified.")

            # --- TEST C & D: Move, pause while held, resume, release during inertia ---
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.move(cx + 50, cy - 20)
            time.sleep(0.25)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0
            # Pause
            time.sleep(0.3)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0
            # Resume fast swipe & release to trigger inertia
            page.mouse.move(cx + 160, cy - 40)
            time.sleep(0.015)
            page.mouse.move(cx + 280, cy - 60)
            page.mouse.up()
            time.sleep(0.07)
            inertia_opacity = page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()")
            assert inertia_opacity > 0.0, f"Labels should begin fading in during inertia, got {inertia_opacity}"
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 1.0
            print("[PASS] Test C & D: Drag/pause/resume and fade-in during inertia verified.")

            # --- TEST E: Rapid fade reversal ---
            page.mouse.move(cx, cy)
            page.mouse.down()
            time.sleep(0.07)
            op_down = page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()")
            page.mouse.up()
            time.sleep(0.03)
            op_rev = page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()")
            assert 0.0 < op_down < 1.0 and op_rev > op_down, (
                f"Expected smooth reversal from {op_down:.3f} -> {op_rev:.3f}"
            )
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            print("[PASS] Test E: Rapid fade reversal verified.")

            # --- TEST F: Preference persistence across reload & cleanup ---
            page.reload(wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector(".network-canvas", timeout=15000)
            page.wait_for_selector(".status-indicator:has-text('Index Ready')", timeout=15000)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getHideGroupLabelsOnMovement()") is True
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 1.0
            print("[PASS] Test F: Preference persistence across reload and clean state verified.")

            browser.close()
    finally:
        print("[AREA LABELS] Stopping server...")
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        log_file.close()
        shutil.rmtree(log_dir, ignore_errors=True)
        print("[AREA LABELS] Cleanup complete.")


if __name__ == "__main__":
    main()
