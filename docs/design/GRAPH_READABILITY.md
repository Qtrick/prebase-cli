# Graph Readability and Information Design Architecture

## 1. Overview and Problem Statement

Previous iterations of PreBase CLI successfully implemented high-performance 3D canvas rendering, Fibonacci sphere layouts, and damped rotational physics. However, when an unfamiliar developer opened a repository, the visual representation was an impenetrable orb of colored dots and crisscrossing lines.

The graph answered: *"Which files have edges between them?"*
It failed to answer:
- What parts of this codebase exist, and where do they live?
- What is the primary entry point of this application?
- Which files are foundational utilities used by everyone, and which are leaf components?
- Why are files placed where they are on the orb?
- What direction do dependencies flow?

The **Graph Readability Architecture** transforms the 3D Network Graph from an abstract point cloud into an interpretable codebase mental model suitable for beginners and experienced engineers alike.

---

## 2. Visual Semantic Grammar

### 2.1 File Node Palette & Category Hierarchy
File glyphs are rendered with a strict, accessible color hierarchy rather than arbitrary hashes:

| Category | Primary Extensions | Hex Color | Role Description |
| :--- | :--- | :--- | :--- |
| **TypeScript / JavaScript** | `.ts`, `.tsx`, `.js`, `.jsx` | `#38bdf8` | Application logic and UI components |
| **Rust / Systems** | `.rs`, `.go`, `.c`, `.cpp` | `#f97316` | Backend engines, parsers, and system libraries |
| **Stylesheets** | `.css`, `.scss`, `.less` | `#a855f7` | Visual styling and component themes |
| **Config & Data** | `.json`, `.toml`, `.yaml`, `.md` | `#eab308` | Configuration files, manifests, and documentation |
| **Primary Entry Candidate** | `src/index.ts`, `src/main.rs`, etc. | `#e8b84a` | Application entry points with confirmed high confidence |

### 2.2 Entry Point Candidate Detection
Previously, the graph rendered `snapshot.nodes[0]` as the primary entry point in gold with 10x semantic weight, misinforming users whenever an arbitrary utility was indexed first.
The new architecture uses grounded heuristics in `src/utils/entryPointDetection.ts`:
1. **Convention Matching**: Identifies recognized entry paths (`src/main.rs`, `src/index.ts`, `src/App.tsx`, `src/main.tsx`, `crates/*/src/lib.rs`, `packages/*/src/index.ts`).
2. **Topological Metrics**: Prioritizes nodes with high outgoing dependencies and zero/low incoming dependents.
3. **Qualified Multiple Candidates**: Distinguishes application startup entry points, library crate roots, and nested app roots. If multiple candidates exist, each receives qualified confidence metrics.
4. **Conservative Null Fallback**: If no recognized pattern matches with high confidence, no entry styling is rendered. PreBase never fabricates certainty.

---

## 3. Directional Connection Semantics

Connections between files represent concrete, verified code imports:

```
[ Importer (Source) ] ───────▶ [ Imported Dependency (Target) ]
```

- **Arrow Direction**: The directional arrowhead sits at the 62% midpoint and points directly toward the file being imported (the dependency).
- **Solid Lines (`#38bdf8`)**: Represent direct, static `import ... from '...'` or `require(...)` statements.
- **Dashed Lines (`#94a3b8`)**: Represent dynamic imports (`import(...)`) or TypeScript type-only imports (`import type { ... }`).
- **Dimming & Incident Isolation**:
  - When a file is selected or hovered, all unrelated nodes are dimmed to $18\%$ opacity.
  - Neighbor adjacency is strictly verified via `neighborMap.get(selectedNodeId)?.has(targetNodeId)`, correcting the previous defect where any node with edges was falsely lit up.

---

## 4. Architectural Fibonacci Sector Clustering

A critical architectural flaw in pure Fibonacci spherical distribution is that spiral indices $0 \dots N-1$ were assigned in random alphabetical or discovery order. A component in `src/components/Card.tsx` might sit at the north pole while `src/components/Button.tsx` sat at the south pole.

### The Area-Sector Solution
In `snapshotRevision.ts`, nodes are grouped by their canonical architectural area (`getAreaIdForPath`) and sorted before spherical allocation:

$$\text{Sort Key} = \langle \text{Area ID}, \text{Relative Path} \rangle$$

Because adjacent indices along a Fibonacci spiral are spatially contiguous on the spherical surface:
1. Files in `src/components` cluster into a contiguous spherical sector.
2. Files in `crates/core` cluster into a neighboring sector.
3. The geometric spherical envelope and $(0, 0, 0)$ centroid balance are strictly preserved with zero jitter or drift.

---

## 5. Screen-Space Label Hierarchy & Spatial Hash Collision Avoidance

To eliminate illegible text overlapping when dozens of nodes cluster together on the 3D canvas:

### 5.1 Decoupling Glyph Depth from Label Priority
While 3D spheres require back-to-front painter's order ($z \le 0$ first, $z > 0$ last) so forward glyphs occlude background glyphs, **text labels require priority-first rendering**. If labels are drawn in painter's order, a background node evaluated first can consume screen space and falsely suppress the label of a foreground or focused node.

PreBase decouples label drawing:
1. All node glyphs are sorted by depth and rendered in painter's order.
2. Label candidates are assigned a deterministic priority score via `computeLabelPriorityScore()`:
   - **Selected node**: $+100{,}000$ points (guaranteed visible)
   - **Hovered node**: $+50{,}000$ points
   - **Direct neighbors of selected node**: $+20{,}000$ points
   - **Nodes within currently focused area**: $+10{,}000$ points
   - **Foreground bias**: $+z \times 10$ points
   - **Topology weight**: $+(\text{degree} \times 2)$ points

### 5.2 O(1) Spatial Hash Collision Grid
Candidate labels are placed in priority order using a 2D spatial hash grid (`LabelCollisionGrid`) with a cell size of $90\text{px}$:
- Label candidate screen-space rectangle:
  $$R = \left[ x - \frac{W}{2} - 6, \; y - 3, \; x + \frac{W}{2} + 6, \; y + H + 3 \right]$$
- Bounded neighborhood check tests only the small set of cells intersecting $R$ in $O(1)$ time rather than an $O(N^2)$ pairwise loop.
- If $R$ collides with any higher-priority accepted label, the candidate is cleanly suppressed.

### 5.3 Minimal Unique Path Suffix Disambiguation
When multiple files share the same filename (e.g., `web/src/components/Card.tsx` and `mobile/src/components/Card.tsx`, or `api/index.ts` and `db/index.ts`), PreBase applies `computeDisambiguatedLabels()`:
- Instead of displaying overly long full paths that clutter the canvas, PreBase finds the **shortest unique path suffix** that distinguishes the file from all other matching filenames.
- For example, `web/.../Card.tsx` vs `mobile/.../Card.tsx`.
- Truly unique filenames throughout the repository remain clean, concise basenames (e.g. `App.tsx`).

---

## 6. On-Canvas Visual Guide & Legend

A floating, toggleable **Graph Guide** pill (`💡 Graph Guide`) is anchored in the canvas bottom-left:
- Displays node color swatches and explains their meanings.
- Illustrates solid vs dashed connection styles and directional arrow orientation.
- Details mouse and trackpad interaction controls (Drag to rotate, Shift+drag to pan, Scroll to zoom, Click to inspect).
- Can be opened by beginners at any time and minimized by advanced users.

