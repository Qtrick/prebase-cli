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
   *"PreBase analyzed 24 files across 4 codebase areas and detected 38 direct internal code connections."*
2. **"Files Worth Exploring First"**:
   Surfaces 2–4 grounded recommendations:
   - **Main Entry Point**: Where execution or rendering bootstraps (`src/index.ts`, `src/main.rs`).
   - **Core Dependency**: Foundational utility files heavily imported across the project.
   - **Area Hub**: Files that bridge multiple directories.
3. **"Explore by Area" Cards**:
   Lists derived areas (e.g. `src/components`, `src/utils`, `crates/core`) with file counts.
4. **"Analysis Scope & Boundaries"**:
   An honest explanation: *"PreBase maps direct static code imports within this repository. External packages and runtime dynamic reflection are not connected as internal nodes."*

### Level 1: Area Inspector View
Clicking an area card (or area badge on a node) filters the workspace:
- Nodes outside the area are dimmed to $18\%$ opacity.
- Edges crossing outside the area are suppressed.
- The inspector displays:
  - Canonical path prefix.
  - Total files in area.
  - External dependencies (code this area imports from other areas).
  - External dependents (code other areas import from here).
  - List of files in the area for one-click inspection.
  - `← Back to all areas` button.

### Level 2: Selected File Inspection
Selecting any file node displays:
- **Plain-English Relationship Sentence**:
  - *"This file uses 3 internal files and is used by 7 other files."*
  - *"This file is a foundation file used by 5 other files and imports no other indexed files."*
  - *"This file has no direct internal dependencies or dependents in this repository."*
- **Area Badge**: Displays the parent area and enables one-click focus.
- **Entry Candidate Badge**: Highlighted if this file is a confirmed entry point.
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

