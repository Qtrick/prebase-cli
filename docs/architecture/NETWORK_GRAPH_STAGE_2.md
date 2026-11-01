# PreBase Architecture Specification: Network Graph Stage 2 of 2
**Contextual 2D Relationship Explorer, Multi-View Infrastructure, and Seamless 3D/2D Transitions**

---

## 1. Executive Summary

Stage 1 restored PreBase’s signature 3D dependency orb, centroid-based volumetric rotation, camera/selection decoupling, and live-update stability. 

Stage 2 completes the Network Graph feature by introducing the **Contextual 2D Relationship Explorer** — a deterministic, high-readability neighborhood analysis surface directly integrated with the 3D Overview. It resolves the cognitive overload of massive repositories by allowing developers to drill into any selected file and explore its directed dependencies, dependents, import evidence, and multi-hop relationships without spatial disorientation.

---

## 2. CLI Contract & URL Resolution

PreBase CLI supports dual-mode network graph launching via subcommands and options:

```bash
# Default: launches 3D Network Graph dependency orb
prebase map

# Explicit 3D launch
prebase map --view 3d

# Direct launch into 2D Relationship Explorer
prebase map --view 2d

# Direct launch into 2D Relationship Explorer focused on a specific file
prebase map --view 2d --focus src/components/Card.tsx

# Relative path with spaces or special characters
prebase map --view 2d --focus "src/my components/Button.tsx"
```

### URL Parameter Encoding & Single-Use Bootstrap
When launching the web browser, `crates/prebase-cli/src/main.rs` builds the launch URL:
```text
http://127.0.0.1:{PORT}/?bootstrap={TOKEN}&view={3d|2d}&focus={PERCENT_ENCODED_PATH}
```
- Query parameters strictly follow RFC 3986 percent-encoding via `percent_encode_query_param`.
- On initial load, `frontend/src/transport/api.ts` exchanges the `bootstrap` token for an authenticated session token (`prebase_token`) and strips `bootstrap` from the browser address bar via `window.history.replaceState`, preserving `view` and `focus` parameters without triggering page reloads.

---

## 3. Directional Contract & Graph Derivation

PreBase enforces a strict directional invariant:
$$\text{Module } A \text{ imports Module } B \iff \text{Edge } A \to B$$

### Columnar Allocation
For any active focus file $F$:
1. **Direct Dependents (Column -1):** Modules $D$ where $D \to F$ (incoming edges). Role: `'dependent-1'`, `isDirectNeighbor: true`, `hopDistance: 1`.
2. **Focus File (Column 0):** Module $F$. Role: `'focus'`, `hopDistance: 0`.
3. **Direct Dependencies (Column +1):** Modules $M$ where $F \to M$ (outgoing edges). Role: `'dependency-1'`, `isDirectNeighbor: true`, `hopDistance: 1`.
4. **Second-Hop Dependents (Column -2):** Upstream modules $U$ where $U \to D$ ($U \neq F, U \notin D$). Role: `'dependent-2'`, `hopDistance: 2`.
5. **Second-Hop Dependencies (Column +2):** Downstream modules $V$ where $M \to V$ ($V \neq F, V \notin M$). Role: `'dependency-2'`, `hopDistance: 2`.

```text
[ 2nd-Hop Dependents ] ---> [ Direct Dependents ] ---> [ Focus File ] ---> [ Direct Dependencies ] ---> [ 2nd-Hop Dependencies ]
     (Column -2)                  (Column -1)             (Column 0)             (Column +1)                 (Column +2)
```

### Safety Budgets & Truthful Omission
To prevent browser performance degradation on massive hub modules (e.g., `index.ts` or `utils.ts` importing 500 files):
- Traversal caps rendered entities at `MAX_NODES = 120` and `MAX_EDGES = 240`.
- Nodes are prioritized deterministically: Focus node (1) $\to$ Direct neighbors sorted alphabetically by `relative_path` (2) $\to$ Second-hop neighbors sorted alphabetically (3).
- Omission counts are accurately calculated and reported via `OmissionStats`:
  - `totalDirectDependents`, `omittedDirectDependents`
  - `totalDirectDependencies`, `omittedDirectDependencies`
  - `totalEdges`, `omittedEdges`
  - When capped, an interactive HUD badge displays: `Showing X files (+Y omitted for readability)`.

---

## 4. Deterministic 2D Layout & Bézier Routing

Implemented in `frontend/src/graphs/relationship/relationshipLayout.ts`:

### Horizontal Multi-Column Layout (Default)
- **Column Spacing:** $270\text{px}$ gap between column centers.
- **Card Geometry:** Focus card ($230\text{px} \times 56\text{px}$), Neighbor cards ($196\text{px} \times 44\text{px}$).
- **Monotonic $X$ Coordinates:**
  $$X_{-2} = -540\text{px} < X_{-1} = -270\text{px} < X_0 = 0\text{px} < X_1 = 270\text{px} < X_2 = 540\text{px}$$
- **Vertical Centering:** Cards within each column are centered around $Y = 0$:
  $$Y_i = -\frac{H_{\text{total}}}{2} + i \cdot (H_{\text{card}} + \text{gap}) + \frac{H_{\text{card}}}{2}$$

### Responsive Fallback (< 640px)
When viewport width is under $640\text{px}$, the layout automatically switches to vertical mode (`isVertical: true`):
- Dependents are positioned at top ($Y = -180\text{px}$).
- Focus file at center ($Y = 0\text{px}$).
- Dependencies at bottom ($Y = 180\text{px}$).

### Bézier Edge Routing
- **Forward Edges ($A \to B$ where $X_A < X_B$):** Cubic Bézier curve connecting source `outPort` (right center) to target `inPort` (left center). Tangent vectors ensure arrows point precisely along $+X$.
- **Mutual Dependency Cycles ($A \leftrightarrow B$):** Offsets Bézier control points vertically ($\pm 16\text{px}$) to prevent overlapping splines.
- **Reverse Cycle Edges ($B \to A$ where $X_B > X_A$):** Routes an overhead arc with elevated control points above the cards (`arcY = min(startY, endY) - 50`).
- **Self-Loops ($A \to A$):** Overhead loop starting at $(x - 24, y_{\text{top}})$ and ending at $(x + 24, y_{\text{top}})$ pointing downward into the card.

---

## 5. Seamless Dual-Mode Integration & Viewport Independence

### State Architecture
- Top-level `networkViewMode: '3d' | '2d'` managed in `App.tsx`.
- Persistent Header Switcher: Segmented button `[ 3D Overview | 2D Relationships ]`.
- Keyboard Shortcut: Pressing `V` or `v` (outside text inputs) immediately toggles between 3D and 2D.
- **Selection Preservation:** Selecting a node in 3D preserves the node when switching to 2D; selecting a node in 2D preserves the node when switching to 3D.
- **Decoupled Viewport Caches:**
  - 3D orbit camera preserves `yaw`, `pitch`, `distance`, `panX`, `panY`.
  - 2D viewport preserves independent `panX`, `panY`, `zoom`.
  - Switching modes never mutates or resets the other view's camera.

### Selection vs. Refocusing Interaction Model
- **Single Click on Card:** Selects the file for inspection in the Inspector panel. **Does NOT rebuild or jump the 2D layout.**
- **Double Click or Enter on Card:** Explicitly refocuses the 2D Relationship Explorer around that module.
- **Focus History Navigation:** Pushes previous focus onto `focusHistory: string[]`. An in-canvas `← Back` button allows stepping backwards through the exploration trail.

### Inspector Integration
- **Explore Relationships in 2D:** When viewing a node in 3D, opens the 2D relationship neighborhood centered on that file.
- **Focus Relationships Here:** When inspecting a neighbor node in 2D, recenters the 2D neighborhood on that neighbor.
- **View in 3D Overview:** Returns directly to the 3D orbit view while maintaining node selection.
- **Import Evidence Details:** Selecting any edge displays line/column numbers, specifiers, and type-only tags.

---

## 6. Performance & Accessibility Hardening

1. **Demand-Driven Rendering:** Replaced infinite RAF loops with an on-demand scheduler (`requestRender`), achieving **0% idle CPU utilization**.
2. **Pointer Capture Architecture:** Migrated to Pointer Events (`setPointerCapture` / `releasePointerCapture`) with window `blur` listeners, preventing stuck drags when dragging outside window bounds.
3. **WCAG 2.1 Compliance:**
   - No keyboard trap: native `Tab` navigation preserved across HUD, header, and sidebar.
   - Arrow keys (`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`) navigate cards.
   - Visible `:focus-visible` outline rings on active elements.
   - Screen reader announcements sent to polite live region on mode change, selection, and refocus.
   - Motion sensitivity: respects `@media (prefers-reduced-motion: reduce)`.
4. **Theme Adaptability:** Full contrast support across dark theme (`--bg-primary: #0a0d14`) and light theme (`--bg-primary: #f8fafc`).

---

## 7. Verification Matrix

| Component | Test Suite | Tests | Result |
|---|---|---|---|
| CLI Flags & Encoding | `crates/prebase-cli/src/main.rs` | 7 | **PASS** |
| Rust Core / Git / Server | Cargo Workspace Tests | 30 | **PASS** |
| Directional Derivation | `deriveRelationshipGraph.test.ts` | 16 | **PASS** |
| Multi-Column Layout | `relationshipLayout.test.ts` | 9 | **PASS** |
| History & Live Updates | `relationshipStateAndLiveReconciliation.test.ts` | 10 | **PASS** |
| 3D Camera Math & Orbit | `networkCameraMath.test.ts` | 27 | **PASS** |
| Interaction & Hit-Testing | `networkInteraction.test.ts` | 11 | **PASS** |
| Live SSE Stability | `networkLiveStability.test.ts` | 14 | **PASS** |
| Temporal DAG Layout | `temporalLayout.test.ts` | 7 | **PASS** |
| Stage 2 E2E Pipeline | `scripts/e2e_stage2_verification.py` | 8 assertions | **PASS** |
| Stage 1 Full Regression | `scripts/e2e_full_verification.py` | 13 subsystems | **PASS** |
| **Total** | | **137 Tests** | **100% Green** |
