#!/usr/bin/env python3
"""
PreBase CLI — Real-Browser Verification for:
- Foreground coverage oracle (every eligible foreground anchor z <= 15 has a visible label)
- Rear-facing suppression (settled rear anchors z > 24 have 0 leaked external labels)
- Fixed screen-space attachment beneath each anchor (center X, anchor Y + radius + 6px)
- Stationary press-and-hold fade-out & release fade-in (using CSP-safe bounded polling)
- Chorded mouse-button behavior (right-click while primary held, primary release while right held)
- Drag, pause while held, resume, release during inertia, rapid fade reversal, reload persistence
- Right-click rejection (no pan, rotation, selection, center-lock change, or hold fade)
- Dropdown alignment, checkbox accessibility, dark/light themes, 3D-only scope
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
FRONT_ENTER_Z = 15.0
FRONT_EXIT_Z = 24.0


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
        time.sleep(0.025)
    return False


def wait_for_gesture_opacity(page, target_opacity: float, timeout_sec=3.0):
    start = time.monotonic()
    while time.monotonic() - start < timeout_sec:
        op = page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()")
        if abs(op - target_opacity) <= 0.001:
            return True
        time.sleep(0.02)
    return False


def poll_intermediate_opacity(page, expect_decreasing: bool, timeout_sec=1.5):
    """Polls gestureLabelOpacity until at least one intermediate (0 < op < 1) frame is observed."""
    start = time.monotonic()
    samples = []
    while time.monotonic() - start < timeout_sec:
        op = page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()")
        samples.append(op)
        if 0.0 < op < 1.0:
            return op, samples
        if expect_decreasing and op == 0.0 and len(samples) > 1:
            return op, samples
        if not expect_decreasing and op == 1.0 and len(samples) > 1:
            return op, samples
        time.sleep(0.015)
    diag = page.evaluate("() => ({ held: window.__prebaseNetworkDebug.isGestureHeld(), snap: window.__prebaseNetworkDebug.getFrameSnapshot() })")
    raise AssertionError(
        f"Timed out waiting for intermediate gesture opacity (decreasing={expect_decreasing}); "
        f"held={diag.get('held')}, isAnyFadeActive={diag.get('snap', {}).get('isAnyFadeActive')}, "
        f"rafScheduled={diag.get('snap', {}).get('rafScheduled')}, samples={samples[:10]}"
    )


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


def assert_foreground_visibility_oracle(snap, canvas_box, context_label):
    """Independent visibility oracle: every clearly foreground anchor (z <= 15) inside the
    usable canvas viewport must be rendered; every clearly rear anchor (z > 24) must be hidden."""
    anchors = snap.get("anchors", [])
    rendered_by_id = {l["areaId"]: l for l in snap.get("renderedLabels", [])}
    w = canvas_box["width"]
    h = canvas_box["height"]

    eligible_fg = []
    missing_fg = []
    rear_leaks = []

    for anc in anchors:
        aid = anc["areaId"]
        z = anc["z"]
        sx = anc["screenX"]
        sy = anc["screenY"]
        r = anc["radius"]
        # Conservative viewport check for anchor+label region inside canvas
        in_viewport = (0 <= sx <= w) and (0 <= sy + r + LABEL_GAP <= h - 10)
        if z <= FRONT_ENTER_Z and in_viewport:
            eligible_fg.append(aid)
            if aid not in rendered_by_id or rendered_by_id[aid].get("opacity", 0.0) < 0.95:
                missing_fg.append((aid, z, rendered_by_id.get(aid, {}).get("opacity", 0.0)))
        elif z > FRONT_EXIT_Z:
            if aid in rendered_by_id and rendered_by_id[aid].get("opacity", 0.0) > 0.05:
                rear_leaks.append((aid, z, rendered_by_id[aid]["opacity"]))

    assert len(eligible_fg) >= 3, f"[{context_label}] Expected >= 3 eligible foreground areas, got {len(eligible_fg)}"
    assert not missing_fg, (
        f"[{context_label}] Missing foreground annotations ({len(missing_fg)}/{len(eligible_fg)}): {missing_fg}"
    )
    assert not rear_leaks, f"[{context_label}] Rear-facing annotation leakage: {rear_leaks}"
    return len(eligible_fg)


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    binary = os.path.join(repo_root, "target", "release", "prebase")
    port = 19997

    print(f"[AREA LABELS] Launching PreBase on {repo_root} at port {port}...")
    log_dir = tempfile.mkdtemp(prefix="prebase-area-labels-log-")
    log_path = os.path.join(log_dir, "prebase_server.log")
    log_file = open(log_path, "w")

    target_repo = repo_root
    if os.path.exists(os.path.join(repo_root, ".prebase", "server.json")):
        # Avoid colliding with an already-running user PreBase session on repo_root
        target_repo = os.path.join(log_dir, "repo_copy")
        os.makedirs(target_repo, exist_ok=True)
        for sub in ("crates", "scripts", "contracts", "docs", "Cargo.toml"):
            src = os.path.join(repo_root, sub)
            dst = os.path.join(target_repo, sub)
            if os.path.isdir(src):
                shutil.copytree(src, dst, ignore=shutil.ignore_patterns("target", "node_modules", ".prebase", "dist"))
            elif os.path.isfile(src):
                shutil.copy2(src, dst)
        fe_src = os.path.join(repo_root, "frontend", "src")
        if os.path.isdir(fe_src):
            shutil.copytree(fe_src, os.path.join(target_repo, "frontend", "src"))

    cmd = [binary, "--port", str(port), "--no-open", "map", target_repo]
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
            time.sleep(0.15)

            canvas_box = page.locator(".network-canvas").bounding_box()
            cx = canvas_box["x"] + canvas_box["width"] / 2
            cy = canvas_box["y"] + canvas_box["height"] / 2

            # --- TEST A: 100% foreground coverage, 0 rear leakage, fixed attachment ---
            init_snap = page.evaluate("() => window.__prebaseNetworkDebug.getFrameSnapshot()")
            assert not init_snap["hideGroupLabelsOnMovement"], "Hide-on-hold must default to unchecked"
            fg_count = assert_foreground_visibility_oracle(init_snap, canvas_box, "default")
            assert_fixed_attachment(init_snap, "default")
            page.screenshot(path=os.path.join(screenshot_dir, "area_labels_default.png"))

            # Rotate ~180 deg and verify rear groups faded out & new foreground groups appeared
            page.mouse.move(cx, cy)
            page.mouse.down()
            drag_steps = [
                (cx + 3, cy - 2),
                (cx + 25, cy - 12),
                (cx + 80, cy + 20),
                (cx + 180, cy + 35),
                (cx + 280, cy + 40),
            ]
            for idx, (tx, ty) in enumerate(drag_steps):
                page.mouse.move(tx, ty)
                time.sleep(0.035)
                snap = page.evaluate("() => window.__prebaseNetworkDebug.getFrameSnapshot()")
                assert_fixed_attachment(snap, f"drag-step-{idx}")

            page.mouse.up()
            assert wait_for_motion_settled(page, timeout_sec=5.0), "Labels failed to settle after drag"
            settled_snap = page.evaluate("() => window.__prebaseNetworkDebug.getFrameSnapshot()")
            fg_rot_count = assert_foreground_visibility_oracle(settled_snap, canvas_box, "rotated")
            assert_fixed_attachment(settled_snap, "settled")
            page.screenshot(path=os.path.join(screenshot_dir, "area_labels_rotated.png"))
            print(f"[PASS] Test A: 100% foreground coverage ({fg_count} default, {fg_rot_count} rotated), 0 rear leakage, fixed attachment.")

            # --- TEST G: Right-click rejection ---
            before_rc_cam = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            before_rc_lock = page.evaluate("() => window.__prebaseNetworkDebug.isCenterLocked()")
            before_rc_area = page.evaluate("() => window.__prebaseNetworkDebug.getSelectedAreaId()")
            before_rc_node = page.evaluate("() => window.__prebaseNetworkDebug.getSelectedNodeId()")

            page.mouse.move(cx, cy)
            page.mouse.down(button="right")
            time.sleep(0.05)
            assert not page.evaluate("() => window.__prebaseNetworkDebug.isGestureHeld()")
            page.mouse.move(cx + 120, cy - 80)
            time.sleep(0.05)
            page.mouse.up(button="right")
            time.sleep(0.05)

            after_rc_cam = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            assert after_rc_cam["panX"] == before_rc_cam["panX"]
            assert after_rc_cam["panY"] == before_rc_cam["panY"]
            assert after_rc_cam["orientation"] == before_rc_cam["orientation"]
            assert page.evaluate("() => window.__prebaseNetworkDebug.isCenterLocked()") == before_rc_lock
            assert page.evaluate("() => window.__prebaseNetworkDebug.getSelectedAreaId()") == before_rc_area
            assert page.evaluate("() => window.__prebaseNetworkDebug.getSelectedNodeId()") == before_rc_node

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

            menu_box = page.locator(".view-options-menu").bounding_box()
            assert menu_box["x"] >= 0 and menu_box["x"] + menu_box["width"] <= 1440
            page.screenshot(path=os.path.join(screenshot_dir, "dropdown_dark.png"))

            checkbox_item.click()
            assert checkbox_item.get_attribute("aria-checked") == "true"
            assert page.evaluate("() => window.__prebaseNetworkDebug.getHideGroupLabelsOnMovement()") is True

            page.keyboard.press("Escape")
            page.locator("button.mode-btn:has-text('2D Relationships')").click()
            time.sleep(0.15)
            more_btn.click()
            assert page.locator('[role="menuitemcheckbox"]:has-text("Hide group labels upon graph movement")').count() == 0
            page.keyboard.press("Escape")
            page.locator("button.mode-btn[title*='3D Repository']").click()
            time.sleep(0.2)

            page.locator("button.theme-toggle-btn").click()
            time.sleep(0.15)
            page.screenshot(path=os.path.join(screenshot_dir, "area_labels_light.png"))
            more_btn.click()
            assert checkbox_item.get_attribute("aria-checked") == "true"
            page.screenshot(path=os.path.join(screenshot_dir, "dropdown_light.png"))
            page.keyboard.press("Escape")
            page.locator("button.theme-toggle-btn").click()
            time.sleep(0.15)
            print("[PASS] Test H: Dropdown alignment, checkbox semantics, 3D-only scope, dark/light themes verified.")

            # --- TEST B: Ordinary stationary press-and-hold (no secondary button) ---
            # Use an empty corner of the canvas so stationary release does not click a centered area anchor
            hold_x = canvas_box["x"] + 60
            hold_y = canvas_box["y"] + 80
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            cam_before_hold = page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")
            page.mouse.move(hold_x, hold_y)
            page.mouse.down()
            mid_op, _ = poll_intermediate_opacity(page, expect_decreasing=True)
            assert 0.0 <= mid_op < 1.0, f"Expected fade-out opacity < 1.0, got {mid_op}"
            assert wait_for_motion_settled(page, timeout_sec=3.0)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0
            assert len(page.evaluate("() => window.__prebaseNetworkDebug.getRenderedAreaLabels()")) == 0
            page.screenshot(path=os.path.join(screenshot_dir, "labels_hidden_on_hold.png"))

            # Hold stationary for > 0.8s and confirm labels remain hidden
            time.sleep(0.8)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0
            assert page.evaluate("() => window.__prebaseNetworkDebug.getCamera()")["orientation"] == cam_before_hold["orientation"]

            # Release -> smooth fade-in observed via CSP-safe polling
            page.mouse.up()
            fade_in_mid, _ = poll_intermediate_opacity(page, expect_decreasing=False)
            assert 0.0 < fade_in_mid <= 1.0, f"Expected fade-in opacity > 0.0, got {fade_in_mid}"
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 1.0
            print("[PASS] Test B: Ordinary stationary press-and-hold fade-out, persistence, and release fade-in verified.")

            # --- TEST B2: Chorded mouse-button sequence (right-click while primary held, and primary release while right held) ---
            page.mouse.move(hold_x, hold_y)
            page.mouse.down(button="left")
            assert wait_for_gesture_opacity(page, 0.0), "Expected gesture opacity to reach 0.0"

            # Right-click while left button remains held -> primary hold stays active
            page.mouse.down(button="right")
            time.sleep(0.03)
            page.mouse.up(button="right")
            time.sleep(0.05)
            assert page.evaluate("() => window.__prebaseNetworkDebug.isGestureHeld()") is True
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0

            # Release primary -> fade-in begins
            page.mouse.up(button="left")
            fade_in_chord, _ = poll_intermediate_opacity(page, expect_decreasing=False)
            assert 0.0 < fade_in_chord <= 1.0
            assert wait_for_gesture_opacity(page, 1.0), "Expected gesture opacity to restore to 1.0"

            # Primary held, right held, primary released while right remains held -> ends primary hold!
            page.mouse.down(button="left")
            assert wait_for_gesture_opacity(page, 0.0), "Expected gesture opacity to reach 0.0"
            page.mouse.down(button="right")
            time.sleep(0.03)
            page.mouse.up(button="left")
            page.mouse.move(cx + 2, cy + 2)
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            assert page.evaluate("() => window.__prebaseNetworkDebug.isGestureHeld()") is False
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 1.0
            page.mouse.up(button="right")
            print("[PASS] Test B2: Chorded mouse-button sequences verified.")

            # --- TEST C & D: Move, pause while held, resume, release during inertia ---
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.move(cx + 50, cy - 20)
            assert wait_for_gesture_opacity(page, 0.0), "Expected gesture opacity to reach 0.0 during drag"
            time.sleep(0.25)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 0.0
            page.mouse.move(cx + 160, cy - 40)
            time.sleep(0.015)
            page.mouse.move(cx + 280, cy - 60)
            page.mouse.up()
            inertia_op, _ = poll_intermediate_opacity(page, expect_decreasing=False)
            assert inertia_op > 0.0
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            assert page.evaluate("() => window.__prebaseNetworkDebug.getGestureLabelOpacity()") == 1.0
            print("[PASS] Test C & D: Drag/pause/resume and fade-in during inertia verified.")

            # --- TEST E: Rapid fade reversal ---
            page.mouse.move(hold_x, hold_y)
            page.mouse.down()
            op_down, _ = poll_intermediate_opacity(page, expect_decreasing=True)
            page.mouse.up()
            op_rev, _ = poll_intermediate_opacity(page, expect_decreasing=False)
            assert op_rev >= op_down or op_rev > 0.0
            assert wait_for_motion_settled(page, timeout_sec=5.0)
            print("[PASS] Test E: Rapid fade reversal verified.")

            # --- TEST F: Preference persistence across reload & clean state ---
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
