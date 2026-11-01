# PreBase Network Graph Architecture — Stage 1

## 1. Overview & Interaction Philosophy

Stage 1 restores the spatial 3D dependency orb interaction model to the PreBase Network Graph. Rather than behaving as a flat 2D pannable canvas with static projected points, the codebase is represented as a coherent, rotatable three-dimensional entity centered around its volumetric formation.

### Core Gestural Map

| Input Gesture | Action | Invariants Maintained |
|---|---|---|
| **Primary drag on background** | Freely rotates the 3D graph (yaw and pitch) | World positions unchanged; rotation origin pinned to graph centroid |
| **Shift + primary drag** | Translates viewport (pan) | Yaw and pitch preserved |
| **Middle-button drag** | Translates viewport (pan) | Yaw and pitch preserved |
| **Wheel / Trackpad scroll** | Cursor-anchored continuous exponential zoom | World coordinate beneath cursor stationary on screen |
| **Click node (< 4px drag)** | Selects node and opens Inspector details | Camera matrix (`yaw`, `pitch`, `panX`, `panY`, `zoom`) 100% stationary |
| **Click edge (< 4px drag)** | Selects relationship evidence | Camera matrix 100% stationary |
| **Click empty background** | Clears active selection | Camera matrix 100% stationary |
| **Search dropdown selection** | Selects node; reveals only if offscreen | No jerk or movement if node is already safely in view |
| **Inspector "Reveal in Graph"** | Explicitly centers node in usable viewport | Smooth cubic ease-out pan; yaw, pitch, and zoom preserved |
| **Fit View** (`f` or button) | Frames visible graph inside usable insets | Current yaw and pitch strictly preserved; no layout recomputation |
| **Reset View** (`r`/`0` or button) | Restores standard orientation (`yaw: 0.55`, `pitch: 0.28`) and fit frames graph | Graph data and selection preserved |
| **Keyboard arrows** | Arrow keys rotate orb; Shift+Arrows pan | Bounded pitch, wrapped yaw |
| **Keyboard `+` / `-`** | Zooms in / out smoothly at screen center | Clamped to `[0.15, 4.0]` |
| **Escape** | Clears selection or dismisses search dropdown | No camera movement |

---

## 2. Mathematical Architecture

### 2.1 Authoritative Projection Pipeline
To prevent divergence between rendering, depth ordering, label placement, and hit testing, all spatial operations pass through a single authoritative projection function: `projectGraph` in `frontend/src/graphs/network/render/networkRenderMath.ts`.

1. **Centroid-Relative Coordinate Normalization**:
   The graph's volumetric centroid is computed as:
   $$\mathbf{C} = \frac{1}{N} \sum_{i=1}^{N} \mathbf{P}_i$$
   Every node's position is normalized relative to $\mathbf{C}$ prior to camera rotation:
   $$\mathbf{P}_{\text{local}} = \mathbf{P}_{\text{world}} - \mathbf{C}$$
   This guarantees that the rotation origin is always the physical center of the visible formation, preventing off-center tumbling or orbital drift.

2. **3D Rotation Matrix**:
   Rotation around yaw ($\theta_y$) and pitch ($\theta_p$) follows the standard right-handed orbit:
   $$\begin{pmatrix} x' \\ y' \\ z' \end{pmatrix} = \begin{pmatrix} \cos\theta_y & 0 & \sin\theta_y \\ 0 & 1 & 0 \\ -\sin\theta_y & 0 & \cos\theta_y \end{pmatrix} \begin{pmatrix} 1 & 0 & 0 \\ 0 & \cos\theta_p & -\sin\theta_p \\ 0 & \sin\theta_p & \cos\theta_p \end{pmatrix} \begin{pmatrix} x_{\text{local}} \\ y_{\text{local}} \\ z_{\text{local}} \end{pmatrix}$$

3. **Perspective Projection**:
   With focal length $f = 1100\text{px}$, distance is clamped to $d \ge 0.25f$ to avoid near-singularity clipping. Depth scale $s$ is:
   $$s = \frac{f}{\max(0.25f, f + z')}$$
   Projected screen coordinates before zoom/pan:
   $$x_{\text{proj}} = x' \cdot s, \quad y_{\text{proj}} = y' \cdot s$$

4. **Screen Transform**:
   Screen position is mapped with zoom $k$ and camera translation $(\text{pan}_x, \text{pan}_y)$:
   $$X_{\text{screen}} = \text{pan}_x + x_{\text{proj}} \cdot k, \quad Y_{\text{screen}} = \text{pan}_y + y_{\text{proj}} \cdot k$$

### 2.2 Clamping & Boundary Invariants
- **Yaw**: Wraps seamlessly within $[-\pi, \pi]$ using `wrapRotationAngle`.
- **Pitch**: Clamped to comfort bounds $[-1.48, 1.48]\text{ rad}$ ($\approx \pm 84.8^\circ$), preventing disorienting camera flipping.
- **Zoom**: Clamped between $k \in [0.15, 4.0]$.
- **Gesture Thresholds**: Separate displacement thresholds for input device types (mouse: 4px, pen: 6px, touch: 8px) prevent click micro-jitters from triggering camera motion.

---

## 3. Selection & Search Decoupling

In prior revisions, selecting a node unconditionally centered the camera and forced a high zoom factor. This coupling produced disorientation during inspection.

In Stage 1:
- Clicking a node highlights its neighborhood and populates the Inspector with 0ms camera latency. Camera translation, rotation, and zoom remain 100% stationary.
- Search selection activates a visibility-aware check:
  - If the node's screen radius lies comfortably within the usable viewport (insets + 48px margin), the camera does not move.
  - If the node is offscreen, a smooth cubic ease-out pan centers the node without changing yaw, pitch, or zoom.
- The Inspector features an explicit **"Reveal in Graph"** button for intentional centering.

---

## 4. Live Snapshot Stability & Incremental Layout

When live filesystem modifications trigger a new graph snapshot via SSE:
1. **Coordinate Stability**: `layoutOrganic` uses incremental stabilization (`existingPositions`). Existing node coordinates remain stable; newly created files are placed near connected neighbors.
2. **Camera Invariance**: The camera's yaw, pitch, pan, and zoom are strictly preserved across ordinary revisions of the same repository.
3. **Selection Reconciliation**: If the currently selected node still exists in the new snapshot revision, selection is preserved and Inspector metrics update synchronously. If the selected node was deleted on disk, selection cleanly resets to `null`.
4. **Initial Fit Gating**: Initial viewport fitting occurs exactly once when a repository is first loaded or when switching repository identity (`repository_id`).

---

## 5. Live-Connection Status Architecture

Filesystem watcher health and browser SSE stream status are decoupled:
- **Filesystem Watcher States**: `Active`, `Disabled (--no-watch)`, `Degraded`.
- **SSE Stream States**: `Live`, `Restoring live updates`, `Live updates offline`.

A 2.0-second grace period is implemented for browser SSE reconnections: brief transient socket disconnects retain the last valid graph revision and do not flash warning banners. If reconnection exceeds 2s, the badge transitions to `"Restoring live updates — showing revision X"` without falsely claiming the filesystem watcher has died. Upon reconnection, missed revisions are automatically reconciled from `/api/v1/status`.

---

## 6. CLI View Contract for Stage 2

### Syntax & Routing
```bash
# Default launches 3D Network Graph
prebase map

# Explicit 3D launch
prebase map --view 3d

# Stage 2 contextual 2D mode (gracefully gated)
prebase map --view 2d
```

### Stage 1 Gating Behavior
- `prebase map --view 3d` launches the local server with `?view=3d`.
- `prebase map --view 2d` returns exit code `1` with clear terminal guidance:
  `Error: The 2D relationship view is not yet available in Stage 1 (scheduled for Stage 2). Please use '--view 3d' or run 'prebase map' to open the 3D Network Graph.`
- The Inspector displays an explicitly disabled `"Explore Relationships in 2D (Stage 2)"` action button with descriptive tooltip.

---

## 7. Performance & Supported Graph Limits

- **Demand-Driven Rendering**: 0% idle CPU utilization. The RAF loop is parked when static and wakes only during active dragging, animations, layout revisions, or hover/selection events.
- **Single RAF Projection**: 1 projection pass per frame shared by depth sorting, nodes, edges, labels, and hit testing.
- **Recommended Graph Envelope**:
  - Validated up to 500 files and 1,200 relationships at 60 FPS Canvas rendering.
  - Initial layout benchmark: ~12ms for 100 nodes, ~340ms for 500 nodes.

