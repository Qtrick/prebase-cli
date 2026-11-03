# PreBase Graph Interaction & Usability Guidelines

## 1. 3D Network Graph (The Repository Orb)

### 1.1 Dimensional Identity & Rotation Invariants
- **True 3D Spatial Spherical Projection**: Nodes are positioned in XYZ space. Projection produces genuine non-uniform screen motion where foreground nodes travel faster than background nodes.
- **Center-Lock Anchor**: By default, the 3D orb remains centered inside the active viewport, adjusting for panel insets (header, sidebar, inspector).
- **Rotation Gestures**:
  - Primary Drag (Left Mouse / Single Touch): Rotates Yaw and Pitch smoothly around the 3D centroid.
  - Shift + Drag (or Middle Mouse): Shifts Pan coordinates freely, automatically toggling Center-Lock to off and announcing the change.
  - Mouse Wheel / Trackpad Pinch: Zooms continuously toward the cursor (when unlocked) or toward the center (when center-locked).

### 1.2 Label Hierarchy & Visual Clarity
- **Overview State**: Avoid displaying every label at once. Prioritize:
  1. Selected node (always visible, highlighted).
  2. Hovered node (immediate high-contrast label).
  3. Structural hubs (nodes with high connectivity degree >= 4).
- **Zoomed State**: Lower-degree nodes progressively reveal labels as zoom increases (> 1.2).
- **Legibility Halo**: All labels render a crisp halo stroke (`#080b11` in dark mode, `#ffffff` in light mode) ensuring text is legible over intersecting edges and nodes.

### 1.3 Selection & Relationship Highlighting
- Single click on a node selects it without altering camera angles.
- Direct dependencies (outgoing imports) and dependents (incoming callers) remain illuminated with clear directional distinction.
- Unrelated nodes and edges fade to an unobtrusive depth alpha (0.15–0.25).
- Clicking empty canvas clears selection and restores full repository brightness.

---

## 2. 2D Contextual Relationship Explorer

### 2.1 Mental Model
- The central focus node represents the target under analysis.
- **Left Tier (Dependencies)**: Upstream modules imported by the focus node.
- **Right Tier (Dependents)**: Downstream modules that depend on the focus node.
- **Directional Semantics**: Arrows consistently point from source to target (caller -> callee or import -> module).

### 2.2 Refocusing & Breadcrumb Navigation
- Clicking any connected file node in 2D refocuses the explorer around that file.
- The previous focus node is pushed onto a lightweight history stack.
- A "Back" action with target file badge allows instant return to previous inspection steps.

---

## 3. Temporal Graph (Git Ancestry DAG)

### 3.1 Lane Allocation & Ancestry
- Commit nodes are arranged in topological order with distinct lane tracks for branches and merges.
- Selected commit glows with accent ring and highlights parent and child edges.
- Pagination ("Load older commits") appends commits without jumping the scroll viewport.

