# Temporal Architecture & Git Engine Specification

## 1. Overview

The **Temporal Graph** is the second core visual intelligence modality of PreBase CLI. While the Network Graph provides a spatial structural view of module relationships at the current working tree state, the Temporal Graph visualizes the historical lineage, commit ancestry DAG, branch topologies, and file mutations across repository history.

Rather than relying on Node.js runtimes, Code - OSS bindings, or Electron infrastructure, PreBase employs a high-performance, standalone Rust Git engine (`crates/prebase-git`) coupled with an Axum HTTP + SSE server and a React HTML5 Canvas renderer.

```
┌────────────────────────────────────────────────────────┐
│                      PreBase CLI                       │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
            ▼                                ▼
┌───────────────────────┐        ┌───────────────────────┐
│     prebase-parser    │        │      prebase-git      │
│  Tree-sitter CST / TS │        │   Native Git Engine   │
└───────────┬───────────┘        └───────────┬───────────┘
            │                                │
            └───────────────┬────────────────┘
                            ▼
                ┌───────────────────────┐
                │     prebase-server    │
                │  Axum REST + SSE API  │
                └───────────┬───────────┘
                            │ HTTP & SSE (127.0.0.1)
                            ▼
                ┌───────────────────────┐
                │    React Frontend     │
                │ Network / Temporal UI │
                └───────────────────────┘
```

---

## 2. Rust Git Engine (`crates/prebase-git`)

### 2.1 Design Principles

1. **Zero-Overhead Read-Only Execution**: Executes native Git operations directly with localized `LANG=C` and `LC_ALL=C` environment boundaries, ensuring predictable parsing regardless of user locale.
2. **Defensive Status & Repository Fallbacks**: Handles non-git folders, empty repositories (0 commits), detached HEAD states, and unborn branch references gracefully without crashing or panicking.
3. **Format Immunity**: Employs non-printable ASCII control delimiters:
   - Record Separator: `\x1e`
   - Unit Separator: `\x1f`
   - Null Byte: `\0` (`-z` mode)
   This eliminates escaping bugs, space corruption, and newline truncation in commit messages, author names, or file paths containing Unicode (e.g., `tests/fixtures/sample-monorepo/src/features/unicode_🌟.ts`).

### 2.2 Ancestry Traversal & Topological Lane Allocation

Commit history is queried via `git log --topo-order --format="%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e"`.

To render the commit ancestry DAG without line collisions in the browser, `prebase-git::topology::assign_topological_lanes` implements a deterministic lane allocation algorithm:
- Commits are processed in topological order (newest to oldest).
- An `active_lanes` vector tracks active branch lines waiting for their parent commits.
- When commit $C$ is processed, it claims its designated lane (or allocates the lowest free lane index).
- Primary parents (`p_idx == 0`) inherit the child's lane when available; secondary parents (branch merges) allocate or merge into parallel lanes.
- Trailing vacant lanes are pruned, keeping column indices compact.

### 2.3 Commit Details & Rename-Aware Diffing

When inspecting a specific commit:
1. **Metadata & Shortstat**: Author, committer, timestamps, and insert/delete line metrics are extracted.
2. **Rename Detection**: `git diff-tree -r -M --name-status -z` executes with similarity scoring (`-M`).
   - For root commits (0 parents), `--root` is supplied, diffing against the empty tree object (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`).
   - For merge commits, diffs against the primary parent or parents.
   - Null-delimited tokens are parsed into strongly typed `FileChange` structs:
     - `A`: Added
     - `M`: Modified
     - `D`: Deleted
     - `R<score>`: Renamed (with `old_path` and `path`)
     - `C<score>`: Copied

### 2.4 File History Lineage

When a user requests the history of a specific file (e.g., via the "View File History" action in Network Inspector):
- The engine executes `git log --follow --topo-order --format=... -- <file_path>`.
- The `--follow` flag continues tracking history beyond historical renames, allowing complete chronological lineage inspection.

---

## 3. API Contract

| Route | Method | Description |
|---|---|---|
| `/api/v1/git/status` | GET | Current branch, HEAD commit hash, dirty working tree status, dirty file list |
| `/api/v1/history?limit=N&cursor=C` | GET | Paginated topological commits with allocated lane indices |
| `/api/v1/commits/:hash` | GET | Commit metadata, full message, diff stats, and changed files with rename info |
| `/api/v1/file-history?path=P&limit=N` | GET | Commits touching specified file path (with `--follow`) |

---

## 4. Frontend Rendering & Cross-Graph Synchronization

### 4.1 Temporal Canvas Renderer (`TemporalCanvas.tsx`)

- **Rendering**: Implements 60fps HTML5 Canvas rendering supporting pan and smooth cursor-centered wheel zoom.
- **Topology Visuals**:
  - Lane guides with dedicated distinct palette (`#2dd4bf` teal for trunk, `#818cf8` indigo, `#fbbf24` amber, etc.).
  - Smooth cubic Bézier curves for branch branches and merge reconciliations.
  - Interactive commit dots with selection glow and hover highlighting.
  - Short SHA badges and formatted commit message summaries with author/time metadata.
- **Bounding Box Fit View**: Calculates exact bounding box across all commit nodes and adjusts transform camera matrix accordingly.

### 4.2 Cross-Graph Synchronization

1. **Network -> Temporal Navigation**:
   - In the Network File Inspector, clicking **View File History** switches the active view to Temporal.
   - Activates a filter banner (`Showing commit history for: <relative_path>`).
   - Filters the displayed DAG to commits that modified that file.
2. **Temporal -> Network Navigation**:
   - In the Temporal Commit Inspector, clicking any changed file:
     - Checks if the file currently exists in the active Network graph snapshot.
     - If present: switches view to Network, selects the node, and centers the camera on it.
     - If absent (historical file deleted or renamed in older revisions): displays a non-destructive contextual toast banner: `"Historical file not present in current working tree"`.
