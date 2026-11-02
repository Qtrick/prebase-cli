# PreBase CLI — 3D Network Orb Verification Report

**Suite**: `scripts/verify_orb_browser.py`  
**Target**: Release Binary (`target/release/prebase`)  
**Execution Environment**: Headless Chromium (Playwright) + macOS native loopback  
**Verification Date**: 2026-11-01  
**Status**: **ALL 14 VERIFICATIONS PASSED**

---

## 1. Executive Summary

This suite executes against a freshly built release executable of PreBase CLI mapping a deterministic synthetic multi-layer TypeScript repository (24 files across models, utils, core engines, services, and UI components). It verifies the true volumetric 3D orb experience, camera center-lock anchoring, perspective projection, decoupling of selection from camera motion, orbit-preserving reveal navigation, and bidirectional 2D/3D state transitions.

```text
===========================================================================
ALL 3D NETWORK ORB REAL BROWSER VERIFICATIONS PASSED!
===========================================================================
```

---

## 2. Invariant Verification Matrix

| # | Item Description | Verification Methodology | Observed Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **1** | Server Initialization & CLI URL Format | Launch executable with `--port 19998 --no-open map {dir}`. Assert bootstrap token exchange and HTTP 200 health. | Server listening, bootstrap credentials verified, token exchanged cleanly. | **PASS** |
| **2** | Canvas Rendering & Initial State | Evaluate `document.querySelector('.network-canvas')` and `window.__prebaseNetworkDebug.getCamera()`. | Canvas mounted, repository status `Ready`, initial camera metrics loaded. | **PASS** |
| **3** | Centered Orb Metric & Initial Camera | Verify initial camera parameters (`yaw: 0.55`, `pitch: 0.28`, `panX: 347.40`, `panY: 421.14`, `zoom: 2.41`) and projected node count (23 nodes). | Canonical orientation loaded, Fibonacci sphere projected centered in viewport. | **PASS** |
| **4** | Horizontal Drag Rotation & Center Lock | Mouse drag from $(640, 400)$ to $(540, 400)$ ($dx = -100\text{px}$). Verify yaw updates while visual bounds center remains anchored. | `yaw: 0.5500 -> 1.0500`, `panX: 347.40 -> 348.01` (sub-pixel deadzone adjustment $\le 0.61\text{px}$), visual midpoint drift $< 0.1\text{px}$. | **PASS** |
| **5** | Nonuniform Movement (True 3D Perspective) | Track front node (`engine_1.ts`, $z = +92.42$, `depthScale: 0.922`) vs back node (`index.ts`, $z = -94.30$, `depthScale: 1.094`). | Front node screen $dx = +94.43\text{px}$, back node screen $dx = -113.45\text{px}$. Velocity difference $> 200\text{px}$ confirms spherical 3D rotation, not flat 2D translation. | **PASS** |
| **6** | Stationary Projected Rotation Pivot | Evaluate projected centroid $(panX, panY)$ under Center Lock during continuous rotation. | Projected pivot coordinates remain strictly within center-lock bounds, anchoring the orb to the viewport center. | **PASS** |
| **7** | Vertical Drag Rotation & Pitch Bounds | Mouse drag $dy = -80\text{px}$. Verify pitch updates while bounds midpoint remains vertically centered. | `pitch: 0.2800 -> -0.1200`, `panY` dynamically adjusted by $9.79\text{px}$ to compensate for bounds shift, keeping visual screen midpoint invariant. | **PASS** |
| **8** | Arbitrary Starting Locations | Execute drags starting from top-left $(350, 250)$ and bottom-right $(900, 550)$. | Rotations from varied screen locations rotate about the identical volumetric center. | **PASS** |
| **9** | Shift + Drag Panning Decoupling | Hold `Shift` and drag from $(640, 400)$ to $(720, 460)$ ($+80\text{px}, +60\text{px}$). | `panX` shifted to $430.53$, `panY` to $470.28$; `yaw` remained invariant at $1.0500$. `isCenterLocked` transitioned to `false`. Click `#centerLock` successfully re-anchored orb. | **PASS** |
| **10** | Drag Over Node Isolation | Initiate drag starting directly on node `engine_4.ts` $(564.6, 455.7)$ and move $40\text{px}$. | Drag recognized as camera rotation gesture; no accidental node selection occurred in Inspector. | **PASS** |
| **11** | Click Node Selection Invariance | Normal single click on frontmost node `model_4.ts` $(652.4, 368.6)$. | Node selected, Inspector opened with file details. Camera `yaw`, `pitch`, `panX`, `panY` remained 100% invariant ($0.0000$ drift). | **PASS** |
| **12** | 3D -> 2D -> 3D Roundtrip Preservation | Switch to `2D Relationships`, verify `.relationship-canvas`, then switch back to `3D Overview`. | `3D Restored Camera: yaw=0.8500, pitch=-0.0700, zoom=2.41`. Exact camera orientation, zoom, and translation preserved across mode switches. | **PASS** |
| **13** | Search Selection Decoupling | Search for `service_2.ts` and click the search result row directly. | Node selected in Inspector. Camera `yaw`, `pitch`, `panX`, `panY` remained 100% stationary. | **PASS** |
| **14** | Explicit Search Reveal (Orbit to Node) | Search for `model_4.ts` and click the explicit reveal target icon. | Camera rotated `yaw` and `pitch` around stationary pivot to face node forward ($z = +94.64$, front hemisphere). `panX` and `panY` remained centered; orb did not translate across viewport. | **PASS** |

---

## 3. Evidence Artifacts

The verification suite captured 10 high-resolution visual evidence screenshots in `docs/screenshots/`:

1. `01_initial_orb.png`: Initial centered 3D Fibonacci sphere formation at $(yaw: 0.55, pitch: 0.28)$.
2. `02_after_horizontal_drag.png`: Visual formation rotated $0.50\text{ rad}$ around stable pivot.
3. `03_after_vertical_drag.png`: Volumetric pitch tilting with visual bounds anchored at viewport center.
4. `04_after_shift_pan.png`: Panning translation decoupled from orientation.
5. `05_after_recenter.png`: Re-engagement of `#centerLock` smoothly returning orb to usable center.
6. `06_node_selected_inspector.png`: Frontmost node selected with zero camera jitter, populating Inspector.
7. `07_2d_relationships.png`: Contextual 2D Relationship Explorer rendering directed dependencies.
8. `08_back_to_3d_preserved.png`: 3D Overview restored with exact pre-switch orientation.
9. `09_search_selected_no_camera_move.png`: Search item selected without moving camera.
10. `10_search_reveal_orbit_preserving.png`: Explicit Reveal rotating camera to bring target node front-and-center.

