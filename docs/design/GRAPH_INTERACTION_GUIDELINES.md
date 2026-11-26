# PreBase Graph Interaction & Usability Guidelines

## 1. 3D Network Graph (The Repository Orb)

### 1.1 Dimensional Identity & Rotation Invariants
- **Screen-Relative Quaternion Camera Model**: The camera orientation is maintained as a normalized 4D quaternion `[x, y, z, w]`. Rotation deltas are applied along screen-horizontal and screen-vertical axes via quaternion multiplication:
  $$q_{\text{new}} = \Delta q_{\text{screen}} \otimes q_{\text{current}}$$
- **Unrestricted Continuous 360° Rotation**: The camera rotates continuously across vertical poles ($+90^\circ$ and $-90^\circ$) and upside-down inverted orientations without artificial pitch clamping, gimbal lock, or abrupt flips.
- **Center-Lock Anchor**: By default, the 3D orb remains centered inside the active viewport, adjusting for panel insets (header, sidebar, inspector). Center-lock can be toggled via the floating HUD button (`#centerLock`) or `L` key.
- **Rotation Gestures**:
  - Primary Drag (Left Mouse / Single Touch): Rotates smoothly along screen-relative X and Y axes around the 3D centroid.
  - Shift + Drag (or Middle Mouse): Shifts Pan coordinates freely, automatically toggling Center-Lock to off.
  - Right-Click: Reserved for future functionality; does not pan, rotate, select, or alter Center-Lock.
  - Mouse Wheel / Trackpad Pinch: Zooms continuously toward the cursor (when unlocked) or toward the center (when center-locked).
  - Rotational Inertia: Fast drag release imparts smooth exponential decay velocity; stationary pause prior to release cancels inertia cleanly.

### 1.2 Native Non-Passive Graph Zoom
- **Prevention of Browser Page Zoom**: Mouse wheel and trackpad pinch gestures are intercepted directly at the HTML5 Canvas DOM level via a non-passive `{ passive: false }` event listener.
- **Synchronous Prevention**: Calling `e.preventDefault()` inside the canvas wheel handler stops browser-level page scaling (`window.visualViewport.scale` remains locked at `1.0`), smoothly mapping zoom deltas into the graph camera's exponential zoom scale within `[0.15, 4.0]`.
- **Keyboard Zoom & HUD Buttons**: The floating controls HUD provides explicit Zoom In (`#zoomIn`, `+`) and Zoom Out (`#zoomOut`, `-`) buttons with 1.25x scaling steps.

### 1.3 Hierarchical Spherical Layout Algorithm
- **Fibonacci Golden-Spiral Area Anchors**: Architectural areas are assigned anchor positions on the sphere shell using deterministic spherical Fibonacci point distribution:
  $$y_i = 1 - \frac{2i}{K - 1}, \quad \theta_i = \pi (3 - \sqrt{5}) \cdot i, \quad x_i = \sqrt{1 - y_i^2} \cos(\theta_i), \quad z_i = \sqrt{1 - y_i^2} \sin(\theta_i)$$
  This guarantees maximal pairwise angular separation between repository areas across the sphere surface.
- **Orthonormal Polar Tangent Bases**: For each area anchor $\mathbf{C}_k$, an orthonormal tangent plane basis $(\hat{\mathbf{t}}_1, \hat{\mathbf{t}}_2)$ is derived perpendicular to the normal vector $\hat{\mathbf{n}}_k = \mathbf{C}_k / \|\mathbf{C}_k\|$. Member files are distributed in compact spherical geodesic caps scaled by $\sqrt{N_k / N_{\text{total}}}$ using Vogel polar spiral offsets.
- **Centroid Preservation & Incremental Stability**: All node positions are projected back onto the true spherical shell radius ($R_{\text{shell}}$), guaranteeing uniform radius and zero center-lock pan drift ($< 1.5\text{px}$). Live changes pin existing node coordinates to prevent disorienting layout thrashing.

### 1.4 Three-Level Progressive Disclosure & Label Collision Grid
- **Overview Scope (Level 1)**:
  - Macro-architecture mode.
  - Displays prominent Area Anchor Badges with monogram symbols and stable screen-space group annotations attached directly beneath each projected anchor.
  - Collisions and depth affect annotation visibility via smooth opacity fades, never label position.
  - Optional **Hide group labels upon graph movement** preference in the view-options menu smoothly fades out group annotations while a graph gesture is held and fades them back in on release.
  - Suppresses individual file-to-file edges and raw file labels. Only high-level aggregated inter-area dependency bundles are rendered with directional flow arrows.
  - Uses `LabelCollisionGrid` to perform deterministic priority-ordered visibility filtering, preventing label overlap without positional roaming.
  - Small repository fallback: Repositories with $\le 12$ files or $\le 1$ area directly render all files and edges.
- **Area Scope (Level 2)**:
  - Focused area mode.
  - Displays member file nodes at full luminance and renders internal file dependencies and external boundary connections.
  - Other architectural areas smoothly dim to unobtrusive depth alpha (0.12).
  - Breadcrumb at top-left (`Overview > Area: <name>`) allows instant 1-click return to Overview.
- **File Scope (Level 3)**:
  - Isolated dependency neighborhood.
  - Outgoing dependencies illuminate in Electric Cyan (`#2dd4bf`), incoming dependents illuminate in Soft Violet (`#a78bfa`).
  - Irrelevant nodes and edges fade out.
  - Breadcrumb: `Overview > Area: <name> > <filename> [x]`.

### 1.5 Selection, Hit-Testing & Relationship Highlighting
- Single click on an Area Anchor transitions smoothly into Area Scope.
- Single click on an aggregated Area Edge opens the detailed Inter-Area Relationship View in the Inspector, displaying all contributing file pairs.
- Single click on a file node selects it into File Scope without altering camera angles.
- Clicking empty canvas clears selection and restores parent scope.
- Selecting nodes from search or inspector preserves camera angles with 0ms jump; explicit "Reveal in 3D" smoothly orbits the camera to bring offscreen targets into view.

---

## 2. 2D Contextual Relationship Explorer

### 2.1 Mental Model
- The central focus node represents the target under analysis.
- **Left Tier (Dependencies)**: Upstream modules imported by the focus node.
- **Right Tier (Dependents)**: Downstream modules that depend on the focus node.
- **Directional Semantics**: Curved Bézier splines consistently point from source to target (caller -> callee or import -> module).

### 2.2 Refocusing & Breadcrumb Navigation
- Clicking any connected file node in 2D refocuses the explorer around that file.
- The previous focus node is pushed onto a lightweight history stack.
- A "Back" action with target file badge allows instant return to previous inspection steps.

---

## 3. Temporal Graph (Git Ancestry DAG)

### 3.1 Lane Allocation & Ancestry
- Commit nodes are arranged in topological order with distinct lane tracks for branches and merges.
- Selected commit glows with accent ring and highlights parent and child edges.
- Native vertical scrolling navigates smoothly through history.
- Anchor-based cursor pagination ("Load older commits") appends commits without jumping the scroll viewport.
