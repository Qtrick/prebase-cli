# Beginner Exploration UX & Progressive Disclosure Architecture

## 1. Executive Summary & Design Principles

PreBase CLI is built for developers exploring unfamiliar repositories. Traditional graph tools overwhelm non-experts with academic graph theory: *in-degree, out-degree, topological sorts, incident adjacency, DAG lattices*.

The **Beginner Exploration UX** replaces jargon with plain-English mental models, progressive disclosure, and contextual navigation while preserving the deep technical accuracy required by senior engineers.

---

## 2. Multi-Audience Spectrum

| Dimension | Audience A: Beginner / AI Developer | Audience B: Everyday Developer | Audience C: Systems / Lead Engineer |
| :--- | :--- | :--- | :--- |
| **Primary Need** | "What is this repo and where do I start?" | "Where is the component I need to touch?" | "What are the dependency boundaries and leak risks?" |
| **Mental Model** | Plain-English summaries and area groupings | Fast search, file jumps, and history | Exact import specifiers, line numbers, AST confidence |
| **Terminology** | "Files that use this file" | Dependents / Dependencies | Call-graph edges, monorepo boundaries, DAG lanes |
| **Action Pathway** | "Files worth exploring first" cards | 2D Relationship Explorer, `/` search | Direct source inspection, commit diffs, live SSE updates |

---

## 3. Progressive Disclosure Architecture

```
 Level 0: Global Overview
 ┌─────────────────────────────────────────────────────────────┐
 │ What PreBase Found · Explore by Area · Files to Explore First│
 └──────────────────────────────┬──────────────────────────────┘
                                │ click area
                                ▼
 Level 1: Architectural Area View
 ┌─────────────────────────────────────────────────────────────┐
 │ Area: src/components · 8 Files · Inter-Area Dependency Counts│
 └──────────────────────────────┬──────────────────────────────┘
                                │ click file
                                ▼
 Level 2: Selected File Inspection
 ┌─────────────────────────────────────────────────────────────┐
 │ Plain English Summary · Uses X · Used by Y · Actions         │
 └──────────────────────────────┬──────────────────────────────┘
                                │ Explore in 2D
                                ▼
 Level 3: Focused 2D Relationship Neighborhood
 ┌─────────────────────────────────────────────────────────────┐
 │ Files that use this file ──▶ Selected File ──▶ Files it uses│
 └─────────────────────────────────────────────────────────────┘
```

### Level 0: Repository Overview
When no node or edge is selected, the inspector presents:
1. **"What PreBase Found" Summary**:
   *"PreBase discovered 24 files across 4 architectural areas. Analyzed 20 supported files for internal dependencies and confirmed 38 direct code connections. (4 files are unsupported formats excluded from AST dependency analysis.)"*
   Provides honest, truthful accounting of discovered vs. analyzed files.
2. **"Files Worth Exploring First"**:
   Surfaces 2–4 grounded recommendations with truthful confidence:
   - **Main Entry Point**: Where execution bootstraps (`src/index.ts`, `src/main.rs`).
   - **Frequently Imported File**: Core foundational utilities heavily imported across the project (with exact consumer count).
   - **Area Hub**: Files that bridge multiple directories.
3. **"Explore by Area" Cards**:
   Lists adaptively derived areas (e.g. `frontend/src/components`, `backend/src/api`, `crates/core`) with analyzed file counts and connection counts.
4. **"Analysis Scope & Boundaries"**:
   An honest explanation: *"PreBase maps direct static code imports within this repository. Non-code files (Markdown, TOML, JSON) are discovered but excluded from AST analysis. External packages and runtime reflection are not connected as internal nodes."*

### Level 1: Area Inspector & Inter-Area Connection View
Clicking an area card (or area badge on a node) opens the comprehensive area exploration view:
- Nodes outside the area are dimmed to $18\%$ opacity.
- The inspector displays:
  - Canonical area ID and analyzed vs. unsupported file counts.
  - **Outgoing Connections**: Other codebase areas this area depends on, with contributing connection counts.
  - **Incoming Connections**: Codebase areas that depend on this area.
  - **Area Files**: Complete list of files within the area, each with separate **"Inspect"** (updates metadata without moving the 3D camera) and **"Reveal in 3D"** (rotates the orb smoothly to center the file) actions.
  - `← Back to all areas` button.

#### Level 1.5: Inter-Area Connection Drilldown
Clicking any inter-area relationship card opens the detailed aggregate connection view:
- Explains the relationship in plain English: *"3 files in components import 2 files in utils across 3 connections."*
- Lists every contributing source and target file pair.
- Allows one-click inspection of any contributing file directly from the connection list.
- Back button returns directly to the parent area view.

### Level 2: Selected File Inspection
Selecting any file node displays:
- **Plain-English Relationship Sentence**:
  - *"This file uses 3 internal files and is used by 7 other files."*
  - *"This file is a foundation file used by 5 other files and imports no other indexed files."*
  - *"This file has no direct internal dependencies or dependents in this repository."*
- **Truthful Status Badge**:
  - `Analyzed`: Full AST dependency extraction succeeded.
  - `Unsupported`: Non-code format (e.g. Markdown, YAML, TOML) clearly stated with explanation.
  - `Failed`: File could not be parsed, with exact syntax error details provided.
- **Area Badge**: Displays parent area and enables one-click focus.
- **Directional Sections**:
  - **Files this file uses** (Direct dependencies, outgoing imports).
  - **Files that use this file** (Direct dependents, incoming consumers).
- **Import Evidence & Source Preview**: Exact import lines, specifiers, line/column coordinates, and formatted source code.

### Level 3: 2D Relationship Explorer
Clicking **Explore Relationships in 2D** transitions the viewport to the focused 3-column DAG:
- Left Column: **Files that use this file** (Direct dependents · Incoming)
- Center Column: **Selected File**
- Right Column: **Files this file uses** (Direct dependencies · Outgoing)
- Arrow connectors point strictly left-to-right from importer to dependency.
- Layout automatically scales with `fitToGraph` (up to $1.6\times$ zoom) to maximize screen canvas utilization.

---

## 4. Search and Navigation Safety

### 4.1 Input-Safe Keyboard Shortcuts
Previously, pressing `/` anywhere hijacked keyboard focus, even when typing in other input fields or textareas.
The `isEditableElement` guard checks:
- Target is `<input>`, `<textarea>`, `<select>`, or has `contenteditable="true"`.
- If true, `/` produces literal text inside the active element.
- If false, `/` opens and focuses the search box.

### 4.2 4-Tier Deterministic Search Ranking
Search queries rank results deterministically:
1. **Tier 1 (Exact Filename Match)**: Filename matches query exactly (ignoring extension).
2. **Tier 2 (Filename Prefix Match)**: Filename starts with query.
3. **Tier 3 (Filename Substring Match)**: Filename contains query anywhere.
4. **Tier 4 (Path Substring Match)**: Parent directory path contains query.

