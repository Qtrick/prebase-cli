# PreBase CLI

> **Local-first codebase intelligence application featuring interactive Network and Temporal graphs, powered by a standalone Rust engine.**

[![Rust 1.75+](https://img.shields.io/badge/rust-1.75%2B-orange.svg)](https://www.rust-lang.org)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE)
[![Status: Campaign 2 Verified](https://img.shields.io/badge/status-Campaign%202%20Verified-2dd4bf.svg)](#development-status)

---

## Overview

PreBase is a developer tool for understanding codebase architecture, dependency topologies, and historical Git evolution.

Launched directly from your terminal, PreBase discovers your repository, analyzes source relationships with a Rust-native Tree-sitter engine, extracts Git commit lineage, and serves an interactive web interface in your default browser.

**Key Design Principles:**
- **Zero Runtime Dependencies**: Does not require Node.js, Electron, or Code - OSS at runtime. The compiled `prebase` binary is fully standalone and embeds the frontend.
- **Strictly Local-First**: Runs entirely on `127.0.0.1`. No code leaves your machine. No accounts, telemetry, or external cloud services.
- **Bi-Directional Visual Intelligence**: Seamlessly switch between the **Network Graph** (spatial dependency structure) and the **Temporal Graph** (Git ancestry DAG).
- **Live Incremental Monitoring**: Watches source files for changes, reanalyzes code incrementally, and updates browser views in real time via authenticated Server-Sent Events (SSE) while preserving your camera viewport.

---

## Features

### 1. Interactive Network Graph
- **Tree-sitter Parser**: Extracts ES imports, CommonJS requires, dynamic imports, re-exports, and TypeScript type-only imports across `.js`, `.jsx`, `.ts`, and `.tsx`.
- **Module Resolution**: Resolves relative paths, extensionless imports, directory indexes (`index.ts`), and `tsconfig.json` path mappings / baseUrl aliases.
- **Organic Visual Layout**: 2.5D/3D organic force-directed projection highlighting entry points, hubs, and isolated components.
- **Details Inspector**: Inspect direct dependencies, dependents, line-and-column import evidence, and source code previews.

### 2. Git-Powered Temporal Graph
- **Commit Ancestry DAG**: Visualizes repository commit history, branch tracks, and merge arcs with deterministic topological lane allocation.
- **Rename-Aware Diffing**: Tracks file mutations across renames (`git diff-tree -M`) and root commits with similarity scoring.
- **File History Lineage**: Follows the chronological history of individual files across historical moves and renames.
- **Commit Inspector**: View full commit messages, author/committer metadata, diff stats (+/- lines), and click changed files to locate them in the Network Graph.

### 3. Cross-Graph Synchronization
- **From Network to Temporal**: Select any file node in the Network Inspector and click **View File History** to filter the Temporal DAG to commits that touched that file.
- **From Temporal to Network**: Click any changed file in a commit's inspector to jump directly to the Network Graph, focusing and highlighting the file's node.

### 4. Live Filesystem Watching
- **Rust `notify` Watcher**: Automatically detects file additions, modifications, and deletions.
- **Noise Rejection**: Excludes `.git/objects`, `node_modules`, `dist`, `target`, and temporary files, while listening to `.git/HEAD` and `.git/refs/` for branch switches and commits.
- **Atomic State Publication**: Swaps graph snapshots and indexes under a single lock with strictly monotonic revisions, eliminating state tearing and race conditions.
- **Server-Sent Events (SSE)**: Streams updates to the browser without page reloads.

---

## Quick Start

### Prerequisites
- [Rust toolchain](https://rustup.rs/) (1.75 or later)
- [Node.js](https://nodejs.org/) (v18+) & `npm` (required only to compile frontend assets)
- [Git](https://git-scm.com/)

### Build From Source

```bash
# 1. Clone repository
git clone https://github.com/prebase/prebase-cli.git
cd prebase-cli

# 2. Build the frontend (compiles to crates/prebase-server/dist)
npm --prefix frontend run build

# 3. Build standalone release binary
cargo build --release

# The single standalone binary is now at:
# target/release/prebase
```

### Running PreBase

Navigate to any JavaScript or TypeScript repository and execute:

```bash
# Analyze current directory and open interactive Network Graph
./target/release/prebase

# Open directly into the Temporal Graph (Git history)
./target/release/prebase history

# Analyze an explicit path without automatically opening the browser
./target/release/prebase /path/to/project --no-open

# Bind to a custom port and disable filesystem watching
./target/release/prebase --port 8080 --no-watch
```

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
└── docs/                         # Architecture, migration, and testing specifications
```

---

## Security

PreBase is designed with security boundaries for local code exploration:
- **Loopback Only**: Server binds exclusively to `127.0.0.1`.
- **DNS Rebinding Protection**: Host headers other than `127.0.0.1` and `localhost` are rejected with `400 Bad Request`.
- **CSRF / Origin Isolation**: Cross-origin requests from external origins are rejected with `403 Forbidden`.
- **Session Token Authorization**: An ephemeral 32-character alphanumeric session token is generated on startup. API endpoints require the token via `x-prebase-session` header or `?token=` query parameter.
- **Path Traversal Protection**: File paths are strictly canonicalized against the repository root; requests containing `..` or escaping the workspace root are blocked.
- **Security Headers**: All HTTP responses include `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

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
- [ ] **Campaign 3: Production Hardening & Distribution**
  - Performance profiling on 10,000+ node codebases.
  - Multi-language expansion (Python, Go, Rust).
  - Homebrew, binary distribution, and automated GitHub Actions releases.

---

## License

Licensed under either of:
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

