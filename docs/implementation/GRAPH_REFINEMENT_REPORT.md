# PreBase CLI — Graph Intelligibility, Product Quality & Engineering Refinement Campaign Report

**Campaign Date**: November 2026  
**Status**: Complete & Verified  
**Git Governance Status**: Strictly Non-Destructive — Zero Unauthorized Commits, Merges, or History Mutations  

---

## 1. Executive Summary & Problem Analysis

PreBase CLI was conceived to give developers immediate, local, privacy-first spatial comprehension of their software repositories. While prior engineering phases achieved 60fps canvas performance, 3D perspective projections, and unified server-sent event (SSE) updates, the visual presentation remained an abstract, intimidating point cloud for non-expert users.

### The Underlying Cognitive Challenge
A user running `prebase` was presented with dozens or hundreds of glowing dots arranged in a 3D sphere. While technically impressive, this representation failed to communicate architectural meaning:
- Which files are foundational engines vs application components?
- Why are files placed where they are on the orb?
- What is the entry point of this program?
- What direction does code depend upon?
- What can PreBase verify statically versus what is outside its analysis scope?

The **Graph Intelligibility & Engineering Refinement Campaign** systematically remediated these foundational issues. By introducing grounded entry point detection, area-aware spherical clustering, plain-English directional terminology, screen-space label collision avoidance, and progressive disclosure inspectors, PreBase transforms abstract graph topology into an intuitive, actionable codebase mental model.

---

## 2. Primary Audiences & User Personas

PreBase addresses three overlapping developer archetypes:

### Audience A: The Beginner / AI-Assisted Developer
- **Profile**: Building full-stack applications with AI coding tools, limited formal knowledge of compilers, ASTs, or graph theory.
- **Needs**: High-level mental models, plain-English summaries ("Files this file uses"), and guided recommendations on where to start exploring without being overwhelmed by technical jargon.

### Audience B: The Everyday Developer
- **Profile**: Experienced programmer joining a new team or auditing an unfamiliar open-source codebase.
- **Needs**: Rapid spatial orientation, deterministic search, direct module jumps, and clear separation between frontend components and backend logic.

### Audience C: The Systems / Lead Engineer
- **Profile**: Lead architect auditing dependency cycles, monorepo boundaries, external library boundaries, and Git ancestry.
- **Needs**: Exact line/column import evidence, AST parse confidence, strict type-only import differentiation, and low idle resource footprint.

---

## 3. Graph Intelligibility & Visual Cognitive Model

The refined interface maps repository structure through four cognitive levels:

```
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. Whole Repository Overview                                │
  │    - "What PreBase Found" Plain-English Summary             │
  │    - 3D Orb with Sector-Clustered Architecture              │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 2. Architectural Area Exploration                           │
  │    - Directory-based functional modules (e.g. src/components)│
  │    - Inter-area dependency counts & out-of-area dimming     │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 3. File Context & Directional Relationships                 │
  │    - Plain-English relationship sentence                    │
  │    - "Files this file uses" vs "Files that use this file"   │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 4. Verified Import Evidence & Code Snippet Inspection       │
  │    - Exact import specifiers, line & column coordinates     │
  │    - Type-only annotations & source preview                 │
  └─────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Resolution of the 7 Foundational Defects

### 4.1 Neighbor Map Adjacency Correctness
- **Defect**: In `NetworkCanvas.tsx`, `isConnectedToSelected` evaluated `selectedNodeId ? neighborMap.has(pNode.id) : false`. Because `neighborMap.has(id)` merely tests whether a node has *any* edges in the graph, selecting node $A$ caused every connected node in the entire repository to light up as an adjacent neighbor.
- **Resolution**: Updated the check to strictly verify adjacency:
  ```ts
  const isConnectedToSelected =
    selectedNodeId !== null && (neighborMap.get(selectedNodeId)?.has(pNode.id) ?? false);
  ```
- **Verification**: Verified in `graphReadabilityAndSemantics.test.ts` where disjoint node pairs $(A \to B)$ and $(C \to D)$ confirmed that selecting $A$ marks $B$ as connected, while $C$ and $D$ remain strictly disconnected.

### 4.2 Arbitrary Entry-Node Highlighting
- **Defect**: `snapshot.nodes[0]?.id` was blindly styled in gold (`ENTRY_NODE_COLOR`) with 10x semantic weight, misinforming users that whichever file was scanned first was the application's root entry point.
- **Resolution**: Created `src/utils/entryPointDetection.ts` with `findEntryPointCandidate`. It evaluates standard entry conventions (`src/main.rs`, `src/index.ts`, `src/App.tsx`), checks incoming/outgoing degree ratios, and returns `null` if no recognized entry candidate exists. If `null`, no node receives misleading entry styling.

### 4.3 Area-Aware Fibonacci Spherical Distribution
- **Defect**: Standard Fibonacci allocation distributed spiral indices $0 \dots N-1$ across the sphere in arbitrary discovery order, scattering files from the same directory across random poles and breaking spatial memory.
- **Resolution**: In `snapshotRevision.ts`, nodes are sorted by their canonical area ID (`getAreaIdForPath`) and relative path prior to spherical allocation. Because adjacent spiral indices lie next to each other on the sphere, files from the same folder naturally cluster into contiguous spherical sectors, preserving the $(0, 0, 0)$ centroid balance and 3D spherical silhouette.

### 4.4 Beginner-Friendly Repository Overview
- **Defect**: The default inspector view displayed raw repository IDs, unformatted counts, and technical terms with no context.
- **Resolution**: Replaced with an approachable overview:
  - "What PreBase Found" plain-English summary.
  - "Explore by Area" clickable pills.
  - "Files Worth Exploring First" (entry candidates, core dependencies, area hubs).
  - Honest "Analysis Scope & Boundaries" box explaining that third-party packages and dynamic reflection are excluded from internal dependency lines.

### 4.5 Intuitive Directional Relationship Terminology
- **Defect**: Labels such as `IN`, `OUT`, `Dependents`, and `Dependencies` confused non-specialists regarding which file imports which.
- **Resolution**: Replaced across the application with:
  - *"Files that use this file"* (Direct dependents · Incoming consumers).
  - *"Files this file uses"* (Direct dependencies · Outgoing imports).
  - Relationship summary sentence: *"This file uses X internal files and is used by Y other files."*

### 4.6 Graph Label Collisions & Filename Disambiguation
- **Defect**: Overlapping text labels created illegible visual noise; identical filenames across directories (e.g. `components/Card.tsx` vs `widgets/Card.tsx`) caused ambiguity.
- **Resolution**:
  - Implemented duplicate filename detection: identical filenames automatically prepend their immediate parent folder.
  - Implemented screen-space bounding box suppression: selected and hovered nodes are guaranteed label rendering; overlapping lower-priority labels are suppressed from rendering.

### 4.7 Search Shortcut Hijacking Prevention
- **Defect**: Pressing `/` anywhere stole keyboard focus from other text inputs or textareas.
- **Resolution**: Introduced `isEditableElement` in `SearchBox.tsx`, checking for `<input>`, `<textarea>`, `<select>`, and `contenteditable` attributes. `/` is ignored when active focus is within an editable container.

---

## 5. Visual Semantics, Node Palettes, and Edge Grammar

### Node Color Palette
| Category | File Extensions | Color | Visual Meaning |
| :--- | :--- | :--- | :--- |
| **TypeScript / JavaScript** | `.ts`, `.tsx`, `.js`, `.jsx` | `#38bdf8` | UI components, application logic |
| **Rust / Systems** | `.rs`, `.go`, `.c`, `.cpp` | `#f97316` | Backend services, parsers, engines |
| **Stylesheets** | `.css`, `.scss`, `.less` | `#a855f7` | Presentation, visual themes |
| **Config & Data** | `.json`, `.toml`, `.yaml`, `.md` | `#eab308` | Manifests, build configs, docs |
| **Entry Point Candidate** | Confirmed entry candidate | `#e8b84a` | Root bootstrap or main entry |

### Edge Grammar
- **Direction**: Arrows point strictly from the importer file to the imported dependency.
- **Solid Line (`#38bdf8`)**: Verified static direct import statement.
- **Dashed Line (`#94a3b8`)**: Dynamic import (`import(...)`) or TypeScript type-only import (`import type`).

---

## 6. Architectural Area Grouping & Inter-Area Relationships

The `repositoryAreas.ts` module parses relative paths into canonical namespace areas:
- `src/components/Card.tsx` $\to$ `src/components`
- `crates/prebase-core/src/model.rs` $\to$ `crates/prebase-core`
- `package.json` $\to$ `(root)`

Inter-area relationships are aggregated from file-level edges:
- `totalDependencies`: outgoing code imports to other areas.
- `totalDependents`: incoming code imports from other areas.
- `internalConnections`: couplings between files within the same area.

Selecting an area dims all outside files and edges to $18\%$ opacity, allowing instant visual isolation of subsystems.

---

## 7. Screen-Space Label Hierarchy & Collision Avoidance

To eliminate text overlapping:
1. Placed labels record their axis-aligned screen bounding box $[x_1, y_1, x_2, y_2]$ with a 4px padding margin.
2. Selected and hovered nodes are treated as Priority 1 and bypass collision checks.
3. Candidate labels intersecting any already-placed bounding box are omitted.
4. Duplicate filenames prepend their immediate parent directory, ensuring instant clarity.

---

## 8. Beginner Progressive Disclosure & Contextual Guidance

The inspector transitions seamlessly across four modes:
1. **Repository Overview**: Overall discovery metrics, architectural area cards, and suggested starting points.
2. **Area Inspector**: Focused directory metrics, file list, and inter-area dependency breakdown.
3. **File Inspector**: Plain-English relationship sentence, directional dependency lists, verified AST import evidence, and source code preview snippet.
4. **Relationship Edge Inspector**: Importer and target file cards with line numbers and type-only tags.

---

## 9. Floating Codebase Orb Guide & Dynamic Legend

A responsive floating pill (`💡 Graph Guide`) is permanently available in the canvas bottom-left:
- Expandable with one click or keyboard activation.
- Explains file category color codes.
- Explains connection styles (solid vs dashed, arrow direction).
- Summarizes gesture controls (drag to rotate, Shift+drag to pan, scroll to zoom).
- Fully dismissible to preserve maximum canvas area for advanced users.

---

## 10. Two-Dimensional Relationship Explorer Refinements

The 2D Relationship Explorer (`?view=2d`) arranges dependencies into three clear columns:
- **Left Column**: *"Files that use this file"* (Direct dependents · Incoming).
- **Center Column**: *"Selected File"* (Focus target).
- **Right Column**: *"Files this file uses"* (Direct dependencies · Outgoing).
- Replaced ambiguous `IN:` and `OUT:` chips on the focus card with explicit `Used by: ${count}` and `Uses: ${count}` indicators.

---

## 11. Search Ranking & Input-Safe Keyboard Interaction

The `SearchBox.tsx` component implements a 4-tier deterministic ranking algorithm:
1. **Tier 1**: Exact filename match (`Card.tsx`).
2. **Tier 2**: Filename prefix match (`cardItem.ts`).
3. **Tier 3**: Filename substring match (`wildcard.ts`).
4. **Tier 4**: Path substring match (`src/card/index.ts`).

Keyboard shortcut `/` is guarded by `isEditableElement`, preventing accidental focus theft while typing in forms or editors.

---

## 12. Temporal Graph & Git Ancestry Presentation

The Temporal Graph (`?view=temporal`) provides full Git commit topology exploration:
- Chronological and topological DAG lane routing.
- Dashed edges indicate ancestry across omitted intermediate commits.
- File-filtered view highlights only commits touching a specific file.
- Anchor-based pagination supports repositories with thousands of commits without client-side lag.

---

## 13. Inspector Hierarchy, Metadata Presentation & Source Inspection

The right-hand Inspector (`Inspector.tsx`) incorporates:
- **Path Copy Button**: One-click clipboard copy with tactile confirmation icon.
- **Source Code Snippet**: Direct file preview (up to 1,200 characters) with syntax formatting and copy button.
- **Area Badges**: Clickable tags allowing immediate navigation to parent area.
- **Collapsible Layout**: Can be collapsed via `PanelRightClose` to grant the 3D orb maximum screen real estate.

---

## 14. Layout Math, Fibonacci Sector Clustering & Centroid Invariants

The 3D layout math guarantees strict geometric stability:
- **Mathematical Centroid**: Always strictly $(0, 0, 0)$ across all rotation yaw and pitch angles.
- **Center Lock**: Automatically calculates projected 2D bounding boxes and re-anchors the canvas camera without user intervention.
- **Nonuniform Layer Movement**: Front-facing nodes ($z > 0$) move in the direction of the drag while back-facing nodes ($z < 0$) move in reverse, delivering authentic 3D spatial parallax.

---

## 15. Motion Design, Damped Rotational Physics & Reduced Motion

- **Damped Rotational Inertia**: Physics-based coasting with friction coefficient $0.94$, clamping release velocities to prevent disorientation.
- **Cubic Ease-Out Transitions**: Mode switches and focal reveals animate smoothly over 300–350ms.
- **Reduced Motion Support**: Automatically detects `(prefers-reduced-motion: reduce)` and disables inertia and animated camera interpolations, snapping directly to target transforms.

---

## 16. Code Quality, Abstraction Minimization & Ponytail Invariants

In accordance with the **Ponytail Code Reduction** standard:
- Zero heavy external dependencies were introduced (no Three.js, Cytoscape, or Sigma.js).
- All graph projections, rotations, and collision algorithms operate via lightweight, native 2D canvas trigonometry and pure TypeScript utilities.
- Existing shared data structures (`FileNode`, `DependencyEdge`, `GraphSnapshot`) are reused without schema fragmentation.

---

## 17. Performance Optimization & Idle Resource Efficiency

- **RAF On-Demand Scheduling**: Rendering runs only when camera transforms, gestures, or hover states change.
- **Idle Efficiency**: Zero CPU/GPU usage when the mouse is idle and inertia has settled.
- **Projection Caching**: Bounding boxes and projected node coordinates are cached per frame, preventing redundant trigonometric evaluations during hit testing.

---

## 18. Security Hardening & Trust Boundary Audits

- **Path Traversal Guards**: `getAreaIdForPath` normalizes path separators and discards empty segments, operating purely on sanitized relative paths.
- **Local Client Isolation**: All area aggregations, label formatting, and search filtering run entirely client-side on local memory.
- **Clipboard Safety**: Clipboard write operations catch rejected promises without unhandled rejections.

---

## 19. Verification Methodology & Full Test Suite Results

### Automated Test Matrix
- **Vitest Unit & Behavioral Tests**: 11 test files, **214/214 passed** (100% pass rate).
- **Cargo Workspace Tests**: 5 crates, **44/44 passed** (100% pass rate).
- **Playwright 3D Orb Real Browser Verification**: `scripts/verify_orb_browser.py`, **18/18 passed**.
- **Stage 2 E2E Verification**: `scripts/e2e_stage2_verification.py`, **passed**.
- **Full E2E Verification Pipeline**: `scripts/e2e_full_verification.py`, **passed**.

---

## 20. Defect Traceability Matrix

| Section 4 Defect | Description | Status | Evidence / Test |
| :--- | :--- | :--- | :--- |
| **4.1** | Incorrect neighbor map check | **RESOLVED** | `graphReadabilityAndSemantics.test.ts` (Case 1) |
| **4.2** | Arbitrary `nodes[0]` entry styling | **RESOLVED** | `entryPointDetection.ts` & test Case 2 |
| **4.3** | Random Fibonacci node distribution | **RESOLVED** | `snapshotRevision.ts` area-sorted allocation |
| **4.4** | Technical repository overview | **RESOLVED** | `Inspector.tsx` beginner cards & limitations |
| **4.5** | Ambiguous connection direction | **RESOLVED** | `deriveRelationshipGraph.ts` plain labels |
| **4.6** | Label collisions & duplicate names | **RESOLVED** | Bounding box suppression & prefixing |
| **4.7** | Search shortcut focus hijacking | **RESOLVED** | `isEditableElement` in `SearchBox.tsx` |

---

## 21. Remaining Opportunities & Next Steps

1. **Multi-Area Composite Filtering**: Support selecting multiple areas simultaneously via Shift+click.
2. **Exportable High-Resolution Diagrams**: Allow exporting vector SVG or PNG snapshots of the 3D orb or 2D DAG for documentation.
3. **Workspace Language Extensions**: Extend Tree-sitter import resolution to Python, Go, and Ruby backend modules.

