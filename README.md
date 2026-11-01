# PreBase CLI

> **Local-first codebase intelligence application featuring interactive Network and Temporal graphs, powered by a standalone Rust engine.**

[![Rust 1.75+](https://img.shields.io/badge/rust-1.75%2B-orange.svg)](https://www.rust-lang.org)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE-MIT)
[![Status: MVP Complete / Release Ready](https://img.shields.io/badge/status-MVP%20Complete%20%2F%20Release%20Ready-2dd4bf.svg)](#development-status)
[![CI](https://github.com/Qtrick/prebase-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Qtrick/prebase-cli/actions/workflows/ci.yml)

---

## Overview

PreBase is a developer tool for understanding codebase architecture, dependency topologies, and historical Git evolution.

Launched directly from your terminal, PreBase discovers your repository, analyzes source relationships with a Rust-native Tree-sitter engine, extracts Git commit lineage, and serves an interactive web interface in your default browser.

**Key Design Principles:**
- **Zero Runtime Dependencies**: Does not require Node.js, Electron, or Code - OSS at runtime. The compiled `prebase` binary is fully standalone and embeds the frontend.
- **Strictly Local-First & 100% Offline**: Runs entirely on `127.0.0.1`. No code leaves your machine. No accounts, telemetry, external fonts, or cloud dependencies.
- **Bi-Directional Visual Intelligence**: Seamlessly switch between the **Network Graph** (spatial dependency structure) and the **Temporal Graph** (Git ancestry DAG).
- **Demand-Driven Rendering**: 0% idle CPU utilization. Canvases render only on user interaction or state change.
- **Live Incremental Monitoring**: Watches source files for changes, reanalyzes code incrementally, and updates browser views in real time via authenticated Server-Sent Events (SSE) while preserving your camera viewport.

---

## Features

### 1. Interactive Network Graphs (3D Overview & Contextual 2D Relationships)
- **Rotatable 3D Dependency Orb**: Freely rotates in three dimensions around the volumetric center of the graph formation via primary background dragging.
- **Contextual 2D Relationship Explorer**: Focused 3-to-5 column deterministic neighborhood analysis oriented strictly by dependency direction (`Dependents (Left) -> Focus File (Center) -> Dependencies (Right)`).
- **Depth & Direction Controls**: Toggle between 1-hop direct neighbors and 2-hop extended context; filter by Dependents-only, Dependencies-only, or Both.
- **Direction-Aware Bézier Routing**: Curved spline paths with explicit directional arrowheads, visual encoding of relationship kinds (solid = runtime import, dashed = type-only, dotted = dynamic import, violet = export), and vertical clearance for mutual dependency cycles.
- **Seamless Dual-Mode Switching**: Instant transitions via header switcher (`3D Overview | 2D Relationships`) or non-conflicting `V` key shortcut, preserving active selection and independent viewport cameras.
- **Focus History Navigation**: Double-click or press Enter on any neighbor card to refocus the 2D neighborhood; navigate back through your exploration trail with the in-canvas `← Back` button.
- **Safety Caps & Omission Stats**: Caps visible nodes (120) and edges (240) deterministically to ensure fast compute times on huge repositories, displaying truthful omission counts.
- **Intuitive Camera Navigation**: Shift-drag or middle-click pans; wheel or trackpad delivers smooth, continuous cursor-anchored zoom.
- **Decoupled Selection & Inspection**: Selecting a node or clicking search results updates selection, highlights incident relationships, and inspects metadata with 0ms camera jump.
- **Visibility-Aware Reveal**: Explicit "Reveal in 3D" action in the Inspector smoothly centers offscreen nodes while strictly preserving camera orientation.
- **Tree-sitter Parser**: Extracts ES imports, CommonJS requires, dynamic imports, re-exports, and TypeScript type-only imports across `.js`, `.jsx`, `.ts`, and `.tsx`.
- **Module Resolution**: Resolves relative paths, extensionless imports, directory indexes (`index.ts`), and `tsconfig.json` path mappings / baseUrl aliases.
- **Organic 3D Visual Layout**: Bounded, deterministic 3D force-directed layout highlighting entry points, hubs, and isolated components.
- **Details Inspector**: Inspect direct dependencies, dependents, line-and-column import evidence, source code previews, and switch to 2D relationship explorer.
- **Accessible & Motion-Aware**: Full keyboard navigation (Arrow keys rotate/pan in 3D and navigate cards in 2D, `+`/`-`/`0` zoom, `f` fit, `r` reset, `Escape` clear) and respecting `prefers-reduced-motion`.

### 2. Git-Powered Temporal Graph
- **Commit Ancestry DAG**: Visualizes repository commit history, branch tracks, and merge arcs with deterministic topological lane allocation.
- **Anchor-Based Cursor Pagination**: History paginates stably using commit SHA anchors, immune to concurrent commits added to HEAD.
- **Stale Cursor Detection**: Gracefully handles git rebases, resets, and detached commits with automatic recovery (HTTP `410 Gone`).
- **Merge Commit First-Parent Diffs**: Accurately computes file changes on merge commits relative to first parent (`<hash>^1 <hash>`) with explicit UI comparison basis labels.
- **Rename-Aware Diffing**: Tracks file mutations across renames (`git diff-tree -M`) and root commits with similarity scoring.
- **File History Lineage**: Follows the chronological history of individual files across historical moves and renames.
- **Commit Inspector**: View full commit messages, author/committer metadata, diff stats (+/- lines), and click changed files to locate them in the Network Graph.

### 3. Cross-Graph Synchronization
- **From Network to Temporal**: Select any file node in the Network Inspector and click **View File History** to filter the Temporal DAG to commits that touched that file.
- **From Temporal to Network**: Click any changed file in a commit's inspector to jump directly to the Network Graph, focusing and highlighting the file's node.

### 4. Live Filesystem Watching
- **Rust `notify` Watcher**: Automatically detects file additions, modifications, and deletions.
- **Noise Rejection**: Excludes `.git/objects`, `node_modules`, `dist`, `target`, and temporary files, while listening to `.git/HEAD` and `.git/refs/` for branch switches and commits.
- **Buffer Overflow Protection**: Falls back safely to full reanalysis when filesystem event queues overflow.
- **Atomic State Publication**: Swaps graph snapshots and indexes under a single lock with strictly monotonic revisions, eliminating state tearing and race conditions.
- **Server-Sent Events (SSE)**: Streams updates to the browser without page reloads, with automatic reconnection reconciliation.

---

## Quick Start

### Prerequisites
- [Rust toolchain](https://rustup.rs/) (1.75 or later)
- [Node.js](https://nodejs.org/) (v18+) & `npm` (required only when compiling frontend from source)
- [Git](https://git-scm.com/)

### Build From Source

```bash
# 1. Clone repository
git clone https://github.com/Qtrick/prebase-cli.git
cd prebase-cli

# 2. Build full distribution (frontend + release binary)
./scripts/build.sh

# The single standalone binary is located at:
# target/release/prebase
```

### Running PreBase

Navigate to any JavaScript or TypeScript repository and execute:

```bash
# Analyze current directory and open interactive 3D Network Graph (default)
./target/release/prebase map

# Explicitly launch the 3D Network Graph view
./target/release/prebase map --view 3d

# Launch directly into the Contextual 2D Relationship Explorer
./target/release/prebase map --view 2d

# Launch directly in 2D mode focused on a specific file
./target/release/prebase map --view 2d --focus src/components/Card.tsx

# Open directly into the Temporal Graph (Git history)
./target/release/prebase history

# Analyze an explicit path without automatically opening the browser
./target/release/prebase map /path/to/project --no-open

# Bind to a custom port and disable filesystem watching
./target/release/prebase map --port 8080 --no-watch
```

> **Note on View Modes**: `prebase map --view 3d` launches the rotatable 3D Network Graph. The `--view 2d` relationship view is scheduled for Stage 2. Passing `--view 2d` returns a clear informational terminal message with exit code 1.

---

## CLI Reference

```text
PreBase is a local-first codebase intelligence application that analyzes repository
structure and Git history, rendering interactive Network and Temporal graphs in your local browser.

Usage: prebase [OPTIONS] [PATH] [COMMAND]

Commands:
  map      Open repository directly into the interactive Network Graph
  history  Inspect Git commit history, ancestry DAG, and changed files (Temporal Graph)
  help     Print this message or the help of the given subcommand(s)

Arguments:
  [PATH]   Target repository path to analyze (defaults to current directory)

Options:
      --port <PORT>  Specific port to bind the local server to (defaults to random available port)
      --no-open      Do not automatically open the default web browser
      --no-watch     Disable live filesystem watching and incremental graph synchronization
  -h, --help         Print help
  -V, --version      Print version
```

---

## Architecture & Crates

PreBase is structured as a modular Cargo workspace:

```text
prebase-cli/
├── Cargo.toml                    # Workspace configuration
├── crates/
│   ├── prebase-core/             # Graph data models, indexing, and scanner
│   ├── prebase-parser/           # Tree-sitter AST/CST analyzer & TS module resolver
│   ├── prebase-git/              # Native Git engine, ancestry DAG & topological lanes
│   ├── prebase-server/           # Axum REST & SSE server, auth, and asset embedding
│   └── prebase-cli/              # CLI entry point, argument parsing, orchestration
├── frontend/                     # React 18 + Vite + TypeScript application
│   ├── src/
│   │   ├── app/                  # Application shell & cross-graph state
│   │   ├── graphs/network/       # Network Canvas, organic layout, 3D math
│   │   ├── graphs/temporal/      # Temporal Canvas, DAG layout, branch curves
│   │   ├── inspector/            # File Inspector & Commit Inspector
│   │   ├── search/               # Search box component
│   │   ├── transport/            # HTTP client & Server-Sent Events listener
│   │   └── types/                # Canonical TypeScript contracts
├── tests/
│   └── fixtures/sample-monorepo/ # Monorepo integration test fixture
├── scripts/                      # Build, test, package, and benchmark scripts
└── docs/                         # Architecture, decisions, and requirement audits
```

---

## Security Hardening

PreBase is engineered with strict local security boundaries:
- **Loopback Only**: Server binds exclusively to `127.0.0.1`.
- **Exact Host Port Validation**: Header must match `127.0.0.1:<port>` or `localhost:<port>`. DNS rebinding attacks from arbitrary hosts are blocked with `400 Bad Request`.
- **Exact Origin Validation**: Cross-origin requests from external origins are rejected with `403 Forbidden`.
- **Single-Use Bootstrap Authentication**: Browser launch uses a single-use bootstrap token exchanged via `POST /api/v1/auth/session` for a secure session cookie, immediately stripped from the URL bar (`history.replaceState`).
- **Path Traversal & Scope Restrictions**: File access is canonicalized against repository root, rejects `..`, and restricts access to files that exist in the indexed dependency graph snapshot.
- **Bounded Resource Limits**: Git subprocesses are bounded by a 10s timeout and a 10MB output cap. Source file reads are capped at 500KB.
- **Strict Offline CSP**: Content-Security-Policy blocks all remote fonts, CDNs, external scripts, and external connections (`default-src 'self' 'unsafe-inline' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none';`).

---

## Development Status

- [x] **Campaign 1: Foundation & Network Graph**
  - Standalone Rust workspace with Tree-sitter AST parser.
  - TS/JS module resolution with tsconfig aliases.
  - Loopback Axum server with session authorization.
  - Extracted HTML5 Canvas Network graph with search and inspector.
- [x] **Campaign 2: Temporal Graph & Live Intelligence**
  - Standalone `prebase-git` engine with commit DAG and topological lanes.
  - Interactive Temporal graph with branch curves and merge arcs.
  - Cross-graph navigation between Network and Temporal views.
  - Rust filesystem watcher (`notify`) with debouncing.
  - Coherent atomic state publication (`PublishedNetworkState`) and monotonic revisions.
  - Server-Sent Events (SSE) live updates preserving user viewports.
- [x] **Campaign 3: Production Hardening, Defect Remediation & Release Readiness**
  - Stable anchor-based pagination cursor (`--is-ancestor`) and stale-cursor detection.
  - Merge commit first-parent diffs and comparison basis indicator.
  - Bounded Git subprocesses (timeout, buffer limit, child cleanup).
  - Machine-readable NUL-delimited parsing immune to delimiter collision in commit messages.
  - Exact Host & Origin port validation and single-use bootstrap token exchange.
  - Indexed set enforcement and 500KB cap on source viewer.
  - Demand-driven Canvas rendering (zero idle CPU utilization).
  - 100% offline system fonts and dark/light theme toggle.
  - GitHub Actions CI matrix and automated release workflow.

---

## Known Limitations

- **Language Scope**: The initial MVP focuses specifically on JavaScript and TypeScript (`.js`, `.jsx`, `.ts`, `.tsx`). Support for Python, Go, and Rust is scheduled for post-MVP.
- **Subprocess Timeout**: Massive repositories with hundreds of thousands of commits may encounter the 10-second subprocess limit on initial root discovery if unindexed.
- **Submodules**: Git submodules are treated as directory boundaries rather than recursively unpacked repositories.

---

## License

Licensed under either of:
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

