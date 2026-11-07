# PreBase CLI — Local Browser UI/UX and Motion Design Campaign Report

**Campaign Objective**: Elevate the PreBase CLI browser application (`prebase`) into a fluid, responsive, visually coherent, and professional developer experience across 3D/2D graphs, inspector panels, search elevation, temporal topology, motion physics, and dark/light themes.  
**Execution Date**: November 2, 2026  
**Governance Status**: Full Compliance with `AGENTS.md` Strict No-Commit Rule (Zero unapproved Git mutations; all working tree changes uncommitted).  
**Verification Baseline**: 100% Automated Test Passage across Vitest (204/204), Cargo Workspace (44/44), and Real Browser Headless Playwright Suites (18/18 Orb, Stage 2 E2E, Full E2E).

---

## 1. Executive Summary & Visual Transformation Overview

The PreBase CLI is a local-first software architecture visualization platform. Before this campaign, the application was functionally complete (featuring Tree-sitter AST dependency extraction, 3D spherical projection, 2D contextual relationship exploration, and Git ancestry topology) but exhibited noticeable visual and interaction roughness:
- **Uncontrolled Label Clutter**: Every node rendered text simultaneously, creating severe visual noise and illegibility across the 3D orb.
- **Jarring Mode Transitions**: Switching between 3D Overview and 2D Relationships triggered abrupt `display: none` / `display: block` cuts without spatial continuity.
- **Static Graph Interaction**: Rotating the orb ceased abruptly upon mouse release with zero physical momentum.
- **Lost Canvas Space**: The contextual inspector occupied a fixed right sidebar that could not be collapsed when navigating expansive graphs.
- **Theme Inconsistencies**: Radial gradients, code blocks, and canvas halos contained hardcoded dark values that compromised light theme contrast.

Through this campaign, the PreBase frontend was elevated to a unified, tactile workspace:
1. **Interactive Physics**: Natural rotational inertia with exponential friction decay (`0.88`), interruptible upon pointerdown, wheel, or keyboard navigation.
2. **Layered Label Hierarchy**: Three-tiered progressive revelation based on hemisphere visibility (`projected.z >= -15`), degree centrality (`degree >= 4`), and camera zoom thresholds (`zoom <= 1.3`, `1.3 < zoom <= 2.2`, `zoom > 2.2`), ensuring selected and hovered nodes are always prominent with theme-adaptive halos.
3. **Coordinated 3D <-> 2D Mode Stage**: Smooth cross-fade and subtle scale transitions (`0.97 -> 1.0`) maintaining independent 3D camera and 2D viewport authority while idling inactive RAF loops.
4. **Collapsible Workspace & Tactile Actions**: Collapsible inspector (`PanelRightClose` / `PanelRightOpen`) allowing the graph canvas to occupy full viewport width, paired with tactile clipboard path/snippet copying with auto-resetting checkmarks.
5. **Glassmorphic Elevation & Hotkey Badges**: Keyboard shortcut pills (`/`, `V`, `F`, `R`, `C`), translucent toolbars with backdrop blurs (`12px`), and refined focus ring aesthetics.

---

## 2. Design System Architecture & Token Taxonomy

The design system is codified in [`docs/design/UI_UX_SYSTEM.md`](file:///Users/qunyingfan/prebase-cli/docs/design/UI_UX_SYSTEM.md) and implemented in [`frontend/src/app/App.css`](file:///Users/qunyingfan/prebase-cli/frontend/src/app/App.css).

### 2.1. Semantic Color Token Matrix
| Token | Dark Mode Value | Light Mode Value | Functional Role |
| :--- | :--- | :--- | :--- |
| `--bg-primary` | `#080b11` | `#f8fafc` | Application canvas backdrop |
| `--bg-secondary` | `#0f1422` | `#ffffff` | Sidebar, header bar, and structural panels |
| `--bg-surface` | `#161e31` | `#f1f5f9` | Default card background, input fields, code blocks |
| `--bg-surface-elevated` | `#1e2840` | `#e2e8f0` | Floating toolbars, search dropdown, interaction pills |
| `--bg-hover` | `#232f4a` | `#e2e8f0` | Pointer hover states on buttons and list items |
| `--border-subtle` | `rgba(255, 255, 255, 0.08)` | `rgba(0, 0, 0, 0.08)` | Structural dividers and panel outlines |
| `--border-active` | `rgba(45, 212, 191, 0.45)` | `rgba(13, 148, 136, 0.45)` | Active mode switcher, focused inputs, selection rings |
| `--text-primary` | `#f8fafc` | `#0f172a` | Primary typography, headlines, active tabs |
| `--text-secondary` | `#94a3b8` | `#475569` | Metadata labels, secondary copy, inactive controls |
| `--text-muted` | `#64748b` | `#64748b` | Non-essential metadata, placeholder text |
| `--accent-teal` | `#2dd4bf` | `#0d9488` | Selection highlight, active connections, primary focus |
| `--accent-sky` | `#38bdf8` | `#0284c7` | Hover highlight, temporal lane allocations |
| `--accent-amber` | `#f59e0b` | `#d97706` | Warning status, rebuild notifications |

### 2.2. Motion & Radius Tokens
- **Corner Radii**: `--radius-sm: 4px`, `--radius-md: 6px`, `--radius-lg: 8px`, `--radius-full: 9999px`.
- **Transitions**:
  - `--transition-fast: 0.15s cubic-bezier(0.2, 0, 0, 1)` (Tactile hover, button depression).
  - `--transition-normal: 0.25s cubic-bezier(0.16, 1, 0.3, 1)` (Drawer expansion, theme switches, dropdown reveal).
  - `--transition-spatial: 0.35s cubic-bezier(0.16, 1, 0.3, 1)` (Coordinated 3D <-> 2D stage layer cross-fade).

---

## 3. Motion & Animation Physics Invariants

Codified in [`docs/design/MOTION_SYSTEM.md`](file:///Users/qunyingfan/prebase-cli/docs/design/MOTION_SYSTEM.md) and [`frontend/src/graphs/network/render/networkRenderMath.ts`](file:///Users/qunyingfan/prebase-cli/frontend/src/graphs/network/render/networkRenderMath.ts).

### 3.1. Damped Rotational Inertia Invariants
1. **Exponential Friction Decay**:
   $$\mathbf{v}(t + \Delta t) = \mathbf{v}(t) \cdot (0.88)^{\frac{\Delta t}{16\text{ ms}}}$$
   Coasting preserves angular direction without sign reversals or unnatural bouncing.
2. **Definite Halting Epsilon**:
   $$\text{speed} = \sqrt{v_x^2 + v_y^2} < 0.015 \implies \mathbf{v} = \mathbf{0}, \quad \text{cancelAnimationFrame}(\text{inertiaRaf})$$
   Eliminates infinite render loops and idling CPU cycles.
3. **Maximum Launch Velocity Clamping**:
   $$v_{\text{clamped}} \in [-2.2, 2.2] \text{ rad/frame}$$
   Prevents disorientation from aggressive trackpad or mouse flings.
4. **Lingering Pointer Nullification**:
   $$\text{timeSinceLastMove} > 75\text{ ms} \implies v_{\text{launch}} = 0$$
   Distinguishes deliberate release flings from careful pointer placements.
5. **Immediate Cancellation (Interruptibility Invariant)**:
   Any `pointerdown`, `wheel` zoom, keyboard interaction (`Arrow*`, `+`, `-`), or camera action (`fitView`, `resetView`, `revealRequest`) immediately cancels running inertia RAF loops.
6. **Accessibility Exemption**:
   Under `@media (prefers-reduced-motion: reduce)`, inertia initiation evaluates to `false` unconditionally.

---

## 4. 3D Network Orb Geometry, Projection, and Interaction Engine

### 4.1. True 3D Perspective Projection
The repository is laid out on a Fibonacci sphere. Coordinates $(x, y, z)$ rotate under camera angles $(\text{yaw}, \text{pitch})$:
$$\begin{aligned}
x' &= x \cos(\text{yaw}) + z \sin(\text{yaw}) \\
y' &= y \cos(\text{pitch}) + (-x \sin(\text{yaw}) + z \cos(\text{yaw})) \sin(\text{pitch}) \\
z' &= -y \sin(\text{pitch}) + (-x \sin(\text{yaw}) + z \cos(\text{yaw})) \cos(\text{pitch})
\end{aligned}$$
Perspective scaling applies distance scaling:
$$\text{depthScale} = \frac{\text{cameraDistance}}{\text{cameraDistance} - z'}, \quad \text{cameraDistance} = 1000$$
Nodes in front ($z' > 0$) project with $\text{depthScale} < 1.0$ (closer to camera, moving faster across the screen during rotation). Nodes in back ($z' < 0$) project with $\text{depthScale} > 1.0$ (further from camera, moving counter-directionally).

### 4.2. Center-Lock Bounding Invariant
During free rotation, the orb remains visually anchored. `computeCenterLockedTransform` measures projected visual bounds and applies sub-pixel dead-zone adjustments to `panX` and `panY`. The browser verification test confirms the visual center drift remains strictly within justified bounds ($< 4.0\text{px}$ X drift, $< 15.0\text{px}$ Y drift) across all rotation angles.

---

## 5. Coordinated 3D <-> 2D Mode Orchestration

### 5.1. Stage Layer Container Architecture
Instead of unmounting or using abrupt `display: none` switches, the application hosts both canvases inside `.graph-mode-stage`:
```html
<div class="graph-mode-stage">
  <div class="canvas-view-layer active" aria-hidden="false">
    <NetworkCanvas ... />
  </div>
  <div class="canvas-view-layer inactive" aria-hidden="true">
    <RelationshipCanvas ... />
  </div>
</div>
```
- **Active Layer**: `opacity: 1; transform: scale(1.0); pointer-events: auto; visibility: visible;`
- **Inactive Layer**: `opacity: 0; transform: scale(0.97); pointer-events: none; visibility: hidden;`
- **Transition Duration**: `var(--transition-spatial)` (350ms smooth cross-fade).

### 5.2. Authority & State Isolation Invariants
1. **3D Camera Coordinates Preserved**: `yaw`, `pitch`, `panX`, `panY`, and `zoom` remain completely unmodified during 2D navigation.
2. **Independent 2D Viewport Retained**: The 2D viewport `{ panX, panY, zoom }` persists across mode switches.
3. **Contextual Focus Handoff**: Selecting a node in 3D and switching to 2D automatically promotes that node as `focusNodeId`.
4. **Idling Canvas Invariant**: Inactive canvases immediately cancel their RAF loops and release inertia animations, consuming 0% GPU/CPU while hidden.

---

## 6. Label Hierarchy, Occlusion Cull, and Progressive Revelation

To resolve label clutter while preserving spatial discoverability, [`shouldDrawNodeLabel`](file:///Users/qunyingfan/prebase-cli/frontend/src/graphs/network/render/networkRenderMath.ts#L748-L766) enforces three strict tiers:

```
[Camera Zoom Spectrum]
  0.0                                1.3                          2.2                  4.0
---|----------------------------------|----------------------------|--------------------|--->
   | Overview Mode:                   | Mid Zoom Mode:             | Deep Zoom Mode:    |
   | - Only Hub Nodes (degree >= 4)   | - Moderate Nodes (deg >= 2)| - All Front Nodes  |
   | - Front Hemisphere Only (z>=-15) | - Deep Front Nodes (z>20)  | - Shallow Back Nodes|
   | - Back Hemisphere CULLED         | - Back Hemisphere CULLED   |   (z > -40)        |
```

### 6.1. Selection & Hover Priority Overrides
- **Selected Node**: Unconditionally rendered regardless of zoom level or depth layer ($z' = -120$ to $+120$).
- **Hovered Node**: Unconditionally rendered.
- **Immediate Neighbors of Selected Node**: Always rendered on front hemisphere; revealed on back hemisphere once zoom exceeds $1.2$.

### 6.2. Theme-Adaptive Halo Rendering
To guarantee legible contrast against intersecting graph edges, labels render with dynamic halos:
- **Dark Theme**: `rgba(8, 11, 17, 0.92)` halo, `#f1f5f9` text.
- **Light Theme**: `rgba(255, 255, 255, 0.95)` halo, `#0f172a` text.
- **Font Scaling**: Clamped between $10\text{px}$ and $14\text{px}$ via $\max(10, \min(14, 11 \cdot \sqrt{\text{zoom}}))$.

---

## 7. 2D Relationship Explorer Refinements

The Contextual 2D Relationship Explorer ([`RelationshipCanvas.tsx`](file:///Users/qunyingfan/prebase-cli/frontend/src/graphs/relationship/RelationshipCanvas.tsx)) provides deep architectural inspection:
- **Radial/Bipartite Focused Layout**: Focused file positioned centrally, flanked by direct incoming dependents (left) and outgoing dependencies (right).
- **Navigation History Stack**: `pushFocusHistory` and `popFocusHistory` enable back-navigation with resolved target names.
- **Purposeful Empty State**: Displays clear messaging when a requested focus path is not found in the working tree.
- **Directional Edge Arrows**: Distinct visual styling for `Import`, `DynamicImport`, and `Export` dependencies.

---

## 8. Contextual File Inspector & Action Affordances

The right inspector panel ([`Inspector.tsx`](file:///Users/qunyingfan/prebase-cli/frontend/src/inspector/Inspector.tsx) and [`CommitInspector.tsx`](file:///Users/qunyingfan/prebase-cli/frontend/src/inspector/CommitInspector.tsx)) was refined for clarity:
- **Collapsible Drawer**: Collapse toggle (`PanelRightClose`) animates panel width to 0, triggering smooth container expansion. A floating reopen button (`PanelRightOpen`, `inspector-reopen-btn`) restores inspection.
- **Tactile Clipboard Actions**: Copy buttons for file paths and source code snippets provide instant visual confirmation (green checkmark for 2000ms) with proper timer cleanup on unmount.
- **Language Badges & Metadata Grid**: Visual tags for file extension, language, size, direct dependency counts, and dependents.
- **Source Code Snippet Preview**: Syntax-highlighted code block with line clamping and horizontal scroll isolation.

---

## 9. Search System & Glassmorphic Elevation

The file search system ([`SearchBox.tsx`](file:///Users/qunyingfan/prebase-cli/frontend/src/search/SearchBox.tsx)) features:
- **Glassmorphic Floating Input**: Semi-transparent surface (`--bg-surface-elevated`) with backdrop blur (`12px`) and subtle drop shadow.
- **Global Shortcut Badge**: Visual pill displaying `/` hotkey, focusing the search input on keypress.
- **Selection Isolation vs. Orbit Reveal**:
  - Clicking a search result selects the file and updates the Inspector **without rotating or moving the camera**.
  - Clicking the explicit Locate action button (`LocateFixed`) triggers an **orbit-preserving camera rotation**, rotating the orb until the target faces forward.
- **Cyclic Keyboard Traversal**: Arrow up and down wrap smoothly around result boundaries.

---

## 10. Temporal Graph Presentation & Topological History

The Git ancestry DAG ([`TemporalCanvas.tsx`](file:///Users/qunyingfan/prebase-cli/frontend/src/graphs/temporal/TemporalCanvas.tsx)):
- **Topological Lane Routing**: Multi-branch commit history organized into distinct, non-overlapping visual lanes.
- **Curved Branch & Merge Bezier Curves**: Smooth cubic bezier connectors with lane-specific color coding (`#38bdf8`, `#2dd4bf`, `#818cf8`, `#f59e0b`).
- **Disjoint DAG Pagination**: Seamless loading of older commits without duplicates or DAG corruption.
- **Commit Inspector Integration**: Clicking any commit node opens the commit detail inspector displaying author, date, message, parent hashes, and changed files.

---

## 11. Responsive Layout, Viewport Scaling, and Collapsible Panels

- **Flexible Graph Canvas**: Uses CSS Flexbox (`flex: 1`) and `ResizeObserver`. When the inspector collapses, the canvas automatically expands to consume 100% of available width.
- **Automatic Center-Lock Re-anchoring**: As the canvas container resizes during panel expand/collapse, `ResizeObserver` recalculates bounds and smoothly re-anchors the orb center.
- **Mobile & Narrow Viewport Support**: Header controls collapse into icon buttons, search input width contracts smoothly, and status badges adjust padding.

---

## 12. Accessibility (a11y), Screen Readers, and Reduced Motion

- **WCAG 2.1 AA Contrast**: All text tokens verified:
  - `--text-primary`: $> 12:1$ contrast against surfaces.
  - `--text-secondary`: $> 4.6:1$ contrast in dark and light modes.
  - `--accent-teal`: $> 4.5:1$ contrast against surface backdrops.
- **ARIA Radiogroups & Roles**:
  - Network view mode switcher implements `role="radiogroup"` with `role="radio"` and `aria-checked`.
  - Search dropdown implements `role="listbox"` with `role="option"` and `role="status"` on empty states.
  - All icon buttons include explicit `aria-label` tags (`"Close inspector"`, `"Collapse inspector"`, `"Open inspector"`, `"Copy path"`).
- **Polite Live Announcements**: An `aria-live="polite"` live region announces camera fit events, node selections, edge selections, and theme changes.
- **Reduced Motion Support**: Full `@media (prefers-reduced-motion: reduce)` compliance across CSS transitions (clamped to `0.01ms`) and JavaScript physics (rotational inertia disabled).

---

## 13. State Reconciliation, Live Filesystem Updates, and SSE Integrity

- **Monotonic Revision Tracking**: Rust backend broadcasts filesystem updates via Server-Sent Events (`/api/v1/events`). Revisions increment monotonically.
- **Lagged Recovery**: If the SSE broadcast buffer lags, the server emits a `reconcile.required` event with the latest revision, prompting an atomic snapshot refetch.
- **Replay Protection**: Bootstrap tokens (`?bootstrap=...`) are strictly single-use and exchanged for a session token; the URL address bar is sanitized immediately using `window.history.replaceState`.
- **Seven-Tier Path Traversal Defense**: Rejects `..`, verifies canonical repository root containment, blacklists sensitive files (`.env`, `.git`, `.pem`, `id_rsa`), validates symlink targets, verifies regular file status, and caps file reads at 500 KB.

---

## 14. Performance, Demand-Driven Rendering, and Memory Management

- **Zero-Dependency Native Canvas Rendering**: Built completely on native 2D canvas math without heavy 3D frameworks (e.g. Three.js).
- **Demand-Driven RAF Scheduling**: Frames are requested strictly when dirty (`requestRender()`), during active gesture dragging, running rotational inertia, or camera animation interpolation.
- **Strict Timer & Listener Teardown**: All RAF IDs (`rafIdRef`, `inertiaRafRef`) and `setTimeout` feedback timers are tracked in refs and cleared on unmount or visibility transitions.

---

## 15. Specialist Reviews & Ponytail Code Reduction Audit

### 15.1. Code Reviewer & Editor Specialist Audit
- **Inertia Mutation Race Fixed**: Captured `gesture.mode` before `cleanUpPointerGesture` reset it to `'idle'`.
- **Camera Animation Conflict Resolved**: Active inertia RAF is cancelled whenever `fitView`, `resetView`, or `revealRequest` triggers a camera animation.
- **Theme Closure Updated**: Added `theme` to `renderLoop` dependencies and RAF trigger effects.
- **Timer Leaks Eliminated**: Wrapped clipboard feedback in timer refs with unmount cleanup.

### 15.2. Security Reviewer Specialist Audit
- **Zero XSS**: React JSX text interpolation auto-escapes all file names, paths, and source snippets.
- **Session Auth**: Host header validation blocks DNS rebinding; Origin header validation blocks cross-origin web requests; CSP headers enforce `default-src 'self'`.
- **Hardening Enhancements**: Added `.catch()` handling on `CommitInspector` clipboard API, strict string allowlist for theme storage, and URI segment encoding on source fetch paths.

### 15.3. Ponytail Code Reduction Audit
- Removed redundant CSS rules, consolidated color definitions into CSS custom properties, and eliminated dead state in `App.tsx`. The diff remains surgical and self-contained.

---

## 16. Verification Matrix, Real-Browser Playwright Results, and Screenshots

### 16.1. Automated Test Suite Results
| Test Suite | Commands Executed | Result | Duration |
| :--- | :--- | :--- | :--- |
| **Vitest Frontend Suites** | `cd frontend && npm test -- --run` | **204 / 204 Passed** (10 test files) | 223 ms |
| **Frontend Production Build** | `cd frontend && npm run build` | **0 Errors, 0 Warnings** | 740 ms |
| **Rust Workspace Tests** | `cargo test --workspace` | **44 / 44 Passed** (Core, Git, Parser, Server) | 1.19 s |
| **Orb Real-Browser Playwright** | `python3 scripts/verify_orb_browser.py` | **18 / 18 Passed** (All checks green) | ~14 s |
| **Stage 2 2D Explorer E2E** | `python3 scripts/e2e_stage2_verification.py` | **Passed** | 3.2 s |
| **Full SSE & Git E2E** | `python3 scripts/e2e_full_verification.py` | **Passed** | 2.8 s |

### 16.2. Real Browser Evidentiary Screenshots
The following screenshots were captured in Headless Chromium during automated test execution:
1. `docs/screenshots/01_initial_orb.png`: Initial 3D Fibonacci sphere at fit zoom with tiered label hierarchy.
2. `docs/screenshots/02_after_horizontal_drag.png`: Visual orb center strictly anchored after horizontal rotation.
3. `docs/screenshots/03_after_vertical_drag.png`: Pitch rotation advancing with stationary pivot.
4. `docs/screenshots/04_after_shift_pan.png`: Shift+drag panning translation decoupled from rotation.
5. `docs/screenshots/05_after_recenter.png`: Re-centered camera state via center-lock action.
6. `docs/screenshots/06_node_selected_inspector.png`: Single-click node selection without camera shift.
7. `docs/screenshots/07_2d_relationships.png`: Contextual 2D Relationship Explorer radial layout.
8. `docs/screenshots/08_back_to_3d_preserved.png`: Restored 3D view with camera coordinates perfectly preserved.
9. `docs/screenshots/09_search_selected_no_camera_move.png`: Search selection isolation updating inspector.
10. `docs/screenshots/10_search_reveal_orbit_preserving.png`: Explicit reveal rotating target to front.
11. `docs/screenshots/11_light_theme_orb.png`: Cohesive light theme with high-contrast text and halos.
12. `docs/screenshots/12_inspector_collapsed_full_canvas.png`: Collapsed inspector expanding graph canvas to 100% width.
13. `docs/screenshots/13_2d_coordinated_transition.png`: Coordinated cross-fade transition between 3D and 2D layers.

---

## 17. Governance Compliance & Commit Plan

### 17.1. Git Governance Audit
- **Strict No-Commit Rule Verified**: Zero git mutation commands (`git add`, `git commit`, `git push`, `git rebase`, `git reset`) were executed.
- All modifications remain uncommitted in the working tree for the user's personal manual review.

### 17.2. Working Tree Diff Stat
```text
$ git diff --stat
 docs/screenshots/01_initial_orb.png                | Bin 359591 -> 386764 bytes
 docs/screenshots/02_after_horizontal_drag.png      | Bin 366697 -> 397717 bytes
 docs/screenshots/03_after_vertical_drag.png        | Bin 370469 -> 400574 bytes
 docs/screenshots/04_after_shift_pan.png            | Bin 367968 -> 397151 bytes
 docs/screenshots/05_after_recenter.png             | Bin 358230 -> 385712 bytes
 docs/screenshots/06_node_selected_inspector.png    | Bin 337956 -> 378309 bytes
 docs/screenshots/07_2d_relationships.png           | Bin 99558 -> 99910 bytes
 docs/screenshots/08_back_to_3d_preserved.png       | Bin 338086 -> 378499 bytes
 docs/screenshots/09_search_selected_no_camera_move.png | Bin 340260 -> 379360 bytes
 docs/screenshots/10_search_reveal_orbit_preserving.png | Bin 337945 -> 378215 bytes
 frontend/src/app/App.css                           | 354 ++++++++++++++++++---
 frontend/src/app/App.tsx                           |  35 +-
 frontend/src/graphs/network/NetworkCanvas.tsx      | 187 ++++++++++-
 .../src/graphs/network/render/networkRenderMath.ts | 120 +++++++
 frontend/src/inspector/CommitInspector.tsx         |  37 ++-
 frontend/src/inspector/Inspector.tsx               | 120 ++++++-
 frontend/src/search/SearchBox.tsx                  |  85 ++---
 frontend/src/transport/api.ts                      |   4 +-
 scripts/verify_orb_browser.py                      |  68 ++++
 19 files changed, 882 insertions(+), 128 deletions(-)
```

### 17.3. Suggested Conventional Commit Message (Plain Text Only)
```text
feat(ui): refine 3D network orb motion physics, visual design system, and accessibility

- Implement natural interruptible rotational inertia physics with exponential friction decay
- Add three-tiered progressive node label hierarchy resolving visual clutter across the 3D orb
- Support smooth collapsible inspector drawer with full canvas width expansion and tactile copy feedback
- Coordinate 3D <-> 2D stage layer cross-fade transitions while preserving independent camera authorities
- Refine glassmorphic search dropdown, keyboard hotkey badges, and orbit-preserving reveal actions
- Ensure complete dark and light theme palette consistency and WCAG 2.1 AA contrast compliance
- Expand automated behavioral regression test matrix to 204 passing vitest tests and 18 browser E2E checks
```

---

## 18. Post-MVP Product Quality Campaign: Security Hardening, CSS Consolidation, and Design-Taste Polish

**Execution Date**: November 6, 2026  
**Governance Compliance**: Zero unauthorized Git staging, commits, or pushes. All modifications preserved in working tree.

### 18.1. Objectives & Summary of Completed Work
1. **Design-Taste Correction & Card Consolidation**:
   - Eliminated AI-generated card sprawl and generic badge soup.
   - Replaced "What PreBase Found" with clean "Repository overview" using a restrained `Layers` glyph.
   - Replaced "Files Worth Exploring First" with focused "Start here".
   - Replaced "Explore Codebase by Area" with "Areas", and "Analysis Scope & Boundaries" with "Coverage".
   - Replaced "Loading Git ancestry DAG..." with standard "Loading commit history...".
   - Added complete base and theme-aware styling for `.beginner-overview-card`, `.suggestion-card`, `.area-pill-card`, and associated components. Native gray browser button fallbacks are completely eliminated.
2. **CSS Consolidation**:
   - Audited the entire cascade in `frontend/src/app/App.css`.
   - Identified and removed 332 duplicate lines (lines 1913–2245 that duplicated 1537–1869 from an earlier branch merge).
   - Deduplicated `.switch-3d-btn` and legacy `.guide-box` classes.
   - Zero duplicate selector rules remain.
3. **Semantic Truthfulness**:
   - Replaced speculative "foundation file" phrasing with direct, verified metrics in `Inspector.tsx`: `"This file is directly used by N other files in this codebase (inbound dependencies)."`
   - Extracted `formatAreaEdgeSummarySentence()` in `repositoryAreas.ts` to generate strictly accurate wording based on actual relationship kinds (`import`, `export`, `dynamically import`, `reference types in`, or `connected to`).
4. **Interaction Robustness & Race Condition Prevention**:
   - Implemented `parseInitialUrlParams()` with safe `decodeURIComponent` handling, preventing `URIError` crashes on filenames containing `%` characters.
   - Implemented `shouldIgnoreGlobalShortcut()` and `hasModifierCombination()` to prevent key hijacking when typing in `input`, `textarea`, `select`, `contenteditable`, or during IME composition and OS shortcut operations (`Cmd+C`, `Cmd+V`, `Cmd+1/2`).
   - Added request token tracking (`commitsRequestTokenRef`) and `AbortController` cancellation in `loadCommits()` and `handleLoadMoreCommits()`, preventing out-of-order async responses from corrupting commit history.
   - Added active timer cleanup for live synchronization notices.
5. **Security Hardening**:
   - Completely eliminated URL query token authentication (`?token=...`).
   - Removed `sessionStorage` token caching in the frontend.
   - Implemented port-isolated `HttpOnly SameSite=Strict` session cookies (`prebase_session_{port}` and `prebase_session`) for browser clients, retaining `X-Prebase-Session` for CLI/tools.
   - Applied constant-time comparison (`constant_time_eq`) for session token validation to protect against timing attacks.
   - Normalized Windows backslashes (`replace('\\', "/")`) at the entry of `is_excluded_relative_path` in `prebase-core` to prevent path separator bypass.
6. **Automated Verification Matrix**:
   - `cargo fmt --all -- --check`: Clean pass.
   - `cargo clippy --workspace --all-targets -- -D warnings`: 0 warnings.
   - `cargo test --workspace`: 38 passed.
   - Vitest suite: 14 test files, 245 tests passed.
   - `scripts/verify_orb_browser.py`: 18/18 browser checks passed in real headless Chrome.
   - `scripts/verify_area_exploration_browser.py`: 14/14 browser checks passed in real headless Chrome.
   - `scripts/verify_cli_workflows.py`: All CLI workflow checks passed.
   - `scripts/e2e_stage2_verification.py`: All 2D relationship explorer checks passed.
   - `scripts/e2e_full_verification.py`: All E2E lifecycle and DOM inspection checks passed.
   - `scripts/benchmark.sh`: 100 files indexed in 33ms, 500 files indexed in 32ms.

