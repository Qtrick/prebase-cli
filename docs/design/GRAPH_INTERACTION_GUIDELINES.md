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
  - Mouse Wheel / Trackpad Pinch: Zooms continuously toward the cursor (when unlocked) or toward the center (when center-locked).
  - Rotational Inertia: Fast drag release imparts smooth exponential decay velocity; stationary pause prior to release cancels inertia cleanly.

### 1.2 Native Non-Passive Graph Zoom
- **Prevention of Browser Page Zoom**: Mouse wheel and trackpad pinch gestures are intercepted directly at the HTML5 Canvas DOM level via a non-passive `{ passive: false }` event listener.
- **Synchronous Prevention**: Calling `e.preventDefault()` inside the canvas wheel handler stops browser-level page scaling (`window.visualViewport.scale` remains locked at `1.0`), smoothly mapping zoom deltas into the graph camera's exponential zoom scale within `[0.15, 4.0]`.
- **Keyboard Zoom & HUD Buttons**: The floating controls HUD provides explicit Zoom In (`#zoomIn`, `+`) and Zoom Out (`#zoomOut`, `-`) buttons with 1.25x scaling steps.

### 1.3 Label Hierarchy & Visual Clarity
- **Overview State**: Avoid displaying every label at once. Prioritize:
  1. Selected node (always visible, highlighted).
  2. Hovered node (immediate high-contrast label).
  3. Structural hubs (nodes with high connectivity degree >= 4).
- **Zoomed State**: Lower-degree nodes progressively reveal labels as zoom increases (> 1.2).
- **Legibility Halo**: All labels render a crisp halo stroke (`#080b12` in dark mode, `#ffffff` in light mode) ensuring text is legible over intersecting edges and nodes.

### 1.4 Selection & Relationship Highlighting
- Single click on a node selects it without altering camera angles.
- Direct dependencies (outgoing imports) and dependents (incoming callers) remain illuminated with clear directional distinction.
- Unrelated nodes and edges fade to an unobtrusive depth alpha (0.15–0.25).
- Clicking empty canvas clears selection and restores full repository brightness.
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
