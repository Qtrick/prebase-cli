# PreBase CLI

> **Local-first codebase intelligence application featuring interactive Network and Temporal graphs, powered by a standalone Rust engine.**

[![Rust 1.99.0](https://img.shields.io/badge/rust-1.99.0-orange.svg)](https://www.rust-lang.org)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE-MIT)
[![Status: MVP Complete](https://img.shields.io/badge/status-MVP%20Complete-2dd4bf.svg)](#development-status)
[![CI](https://github.com/Qtrick/prebase-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Qtrick/prebase-cli/actions/workflows/ci.yml)

---

## Overview

PreBase is a developer tool for understanding codebase architecture, dependency topologies, and historical Git evolution.

Launched directly from your terminal, PreBase discovers your repository, analyzes source relationships with a Rust-native Tree-sitter engine, extracts Git commit lineage, and serves an interactive web interface in your default browser.

**Key Design Principles:**
- **Standalone Runtime (Zero Node/Electron/VM Dependencies)**: Does not require Node.js, Electron, or Code - OSS at runtime. The compiled `prebase` binary is fully standalone and embeds the frontend distribution. A system `git` CLI executable in `PATH` is utilized for Temporal history DAG extraction; in non-git directories or environments without Git, PreBase operates seamlessly in Network Graph mode.
- **Strictly Local-First & 100% Offline**: Runs entirely on `127.0.0.1`. No code leaves your machine. No accounts, telemetry, external fonts, or cloud dependencies.
- **Bi-Directional Visual Intelligence**: Seamlessly switch between the **Network Graph** (spatial dependency structure) and the **Temporal Graph** (Git ancestry DAG).
- **Demand-Driven Rendering**: Quiescent animation loops. HTML5 Canvas requestAnimationFrame rendering pauses automatically when gestures, transitions, and camera movement settle, re-rendering on demand when the user interacts or when live filesystem updates arrive.
- **Live Filesystem Synchronization**: Watches source files for changes, reanalyzes modified files and updates graph state in real time via authenticated Server-Sent Events (SSE) while preserving your camera viewport.

---

## Features

### 1. Interactive Network Graphs (3D Overview & Contextual 2D Relationships)
- **Architectural Group Membership Rings**: File nodes display concentric, depth-attenuated outer rings matching their canonical architectural group color (`frontend`, `server`, `git`, `parser`, `tests`), while preserving language/file-type interior fills and distinct selection halos.
- **Collision-Free Area Monograms**: Area monograms are uniquely disambiguated across the repository (e.g., `tests` receives `TS` and `testing` receives `TG`), preventing monogram collisions on overview hubs.
- **Source-Focused File Visibility**: Toggle between "All Discovered Files" and "Analyzed Code Only" via the Filters dropdown, allowing clean architectural exploration without clutter from unsupported artifacts.
- **Professional Linear/Raycast UI**: Modern developer-tool aesthetic with Obsidian Navy & Electric Indigo theme, sleek divider-separated metric strips, borderless flat rows with subtle hover states, and circular canonical area swatches.
- **Unrestricted Continuous 3D Rotation**: Freely rotates in three dimensions with screen-relative quaternion orientation, operating continuously 360° across poles and inverted orientations with zero pitch lock.
- **Native Graph Zoom Interception**: Wheel events and trackpad pinches are intercepted via non-passive listeners, zooming the visualization smoothly within `[0.15, 4.0]` while preventing browser-level page zoom.
- **Floating Controls HUD**: Glassmorphic control strip for Zoom In (`#zoomIn`, `+`), Zoom Out (`#zoomOut`, `-`), Fit View (`#fitView`, `F`), Reset Camera (`#resetCam`, `R`), and Center-Lock toggle (`#centerLock`, `L`).
- **Contextual 2D Relationship Explorer**: Focused 3-to-5 column deterministic neighborhood analysis oriented strictly by dependency direction (`Dependents (Left) -> Focus File (Center) -> Dependencies (Right)`).
- **Depth & Direction Controls**: Toggle between 1-hop direct neighbors and 2-hop extended context; filter by Dependents-only, Dependencies-only, or Both.
- **Direction-Aware Bézier Routing**: Curved spline paths with explicit directional arrowheads, visual encoding of relationship kinds (solid = runtime import, dashed = type-only, dotted = dynamic import, violet = export), and vertical clearance for mutual dependency cycles.
- **Seamless Dual-Mode Switching**: Instant transitions via header switcher (`3D Overview | 2D Relationships`) or non-conflicting `V` key shortcut, preserving active selection and independent viewport cameras.
- **Focus History Navigation**: Double-click or press Enter on any neighbor card to refocus the 2D neighborhood; navigate back through your exploration trail with the in-canvas `← Back` button.
- **Safety Caps & Omission Stats**: Caps visible nodes (120) and edges (240) deterministically to ensure fast compute times on huge repositories, displaying truthful omission counts.
- **Intuitive Camera Navigation**: Shift-drag or middle-click pans; wheel or trackpad delivers smooth, continuous cursor-anchored zoom with rotational inertia.
- **Decoupled Selection & Inspection**: Selecting a node or clicking search results updates selection, highlights incident relationships, and inspects metadata with 0ms camera jump.
- **Visibility-Aware Reveal**: Explicit "Reveal in 3D" action in the Inspector smoothly centers offscreen nodes while strictly preserving camera orientation.
- **Tree-sitter Parser**: Extracts ES imports, CommonJS requires, dynamic imports, re-exports, and TypeScript type-only imports across `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, and `.cts`.
- **Module Resolution**: Resolves relative paths, extensionless imports, directory indexes (`index.ts`, `index.tsx`, `index.js`, `index.jsx`, `index.mts`, `index.cts`, `index.mjs`, `index.cjs`), and `tsconfig.json` path mappings / baseUrl aliases.
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
- **Noise Rejection**: Excludes `.git/objects`, `node_modules`, `dist`, `target`, and temporary files, while listening to `.git/HEAD`, `.git/refs/`, `.git/packed-refs`, and `.git/index` for branch switches, staging, and commits.
- **Dedicated Worker Offloading**: Offloads Git status queries (`git status`) to dedicated blocking worker threads (`tokio::task::spawn_blocking`), preventing synchronous subprocess execution from blocking the asynchronous event loop.
- **Buffer Overflow Protection**: Falls back safely to full reanalysis when filesystem event queues overflow.
- **Atomic State Publication**: Swaps graph snapshots and indexes under a single lock with strictly monotonic revisions, eliminating state tearing and race conditions.
- **Server-Sent Events (SSE)**: Streams updates to the browser without page reloads, with automatic reconnection reconciliation and generation tracking.

---

## Quick Start

### Runtime & Build Prerequisites

- **Runtime (Standalone Binary)**:
  - **Network Graph (3D & 2D)**: Completely standalone. Zero runtime dependencies (no Node.js, Electron, Python, or external runtime required).
  - **Temporal Graph (Git History)**: Requires a system `git` CLI executable available in `PATH` (Git 2.20+ recommended). In environments without Git or in non-git directories, PreBase runs seamlessly in Network Graph mode and displays a purposeful informational state for Temporal history.
  - **Release Binaries & Signing**: PreBase distribution binaries are currently unsigned and un-notarized open-source artifacts. On macOS, if Gatekeeper flags the downloaded binary, remove the quarantine attribute with `xattr -d com.apple.quarantine prebase` or compile locally from source.

- **Supported Platforms & Architecture Matrix**:
  - **Tier 1 (Automated CI & Full Browser E2E Matrix)**:
    - macOS Apple Silicon (`aarch64-apple-darwin`, macOS 12+)
    - Linux x86_64 (`x86_64-unknown-linux-gnu`, glibc 2.31+)
  - **Tier 2 (Packaged Release Binaries / Built in Release Workflow)**:
    - macOS Intel (`x86_64-apple-darwin`)
  - **Experimental / Source-buildable (Unverified in CI; no prebuilt release binaries)**:
    - Windows x86_64 (`x86_64-pc-windows-msvc` — source-buildable; path canonicalization and backslash handling supported, but not routinely validated in automated CI)
    - Linux ARM64 (`aarch64-unknown-linux-gnu`)

- **Testing & Headless Browser Verification Prerequisites**:
  - Python **3.10 – 3.13** (Python 3.14 is not currently supported due to upstream Playwright/greenlet wheel compatibility).
  - Test dependencies: `pip install -r requirements-test.txt && playwright install chromium`

- **Compiling From Source**:
  - [Rust toolchain](https://rustup.rs/) (1.99.0, pinned via `rust-toolchain.toml`)
  - [Node.js](https://nodejs.org/) (v18+) & `npm` (required only when building frontend assets into the binary)

### Build From Source

```bash
# 1. Clone repository
git clone https://github.com/Qtrick/prebase-cli.git
cd prebase-cli

# 2. Build full distribution (frontend + release binary) without installing
./scripts/build.sh

# The compiled standalone binary is located at:
# target/release/prebase
```

### Installation

PreBase provides both a user installation script (`scripts/install.sh`) and unified flags on `scripts/build.sh`. Both ensure that fresh frontend distribution assets are compiled and embedded into the Rust release binary before installing.

#### 1. Standard User Installation (Copy to PATH)

Installs the standalone executable into `$HOME/.local/bin` (or custom directory):

```bash
# Installs to $HOME/.local/bin/prebase (default)
./scripts/install.sh
# Or equivalently via build.sh:
./scripts/build.sh --install

# Install to a specific executable directory (--bin-dir)
./scripts/install.sh --bin-dir ~/.local/bin

# Install to a system or prefix root (--prefix installs into <PREFIX>/bin)
./scripts/install.sh --prefix /usr/local
```

> **Directory Option Distinction**:
> - `--bin-dir <DIR>`: Specifies the **exact destination directory** for the executable (installs to `<DIR>/prebase`).
> - `--prefix <PREFIX>`: Specifies the **installation prefix root** (installs to `<PREFIX>/bin/prebase`).
>
> If neither option is passed, installation defaults to `$HOME/.local/bin` (or `$PREBASE_BIN_DIR` / `$PREBASE_PREFIX/bin` if defined in your environment).

#### 2. Development Symlink Installation

For active local development, create a development symlink instead of copying the executable. Whenever you recompile the Rust binary (`cargo build --release` or `./scripts/build.sh`), your system command is immediately updated:

```bash
# Creates or updates ~/.local/bin/prebase -> <prebase_root>/target/release/prebase
./scripts/build.sh --link
# Or via install.sh:
./scripts/install.sh --link
```

#### 3. PATH Verification & Shell Configuration

The installation scripts automatically verify command resolution using `command -v prebase` and detect potential issues:
- **Missing from PATH**: If your target bin directory is not in your shell `$PATH`, actionable configuration commands for both **Zsh** (`~/.zshrc`) and **Bash** (`~/.bashrc`) are displayed.
- **PATH Shadowing Detection**: If another `prebase` binary earlier in your `$PATH` precedes the newly installed binary, a warning is printed displaying the conflicting path and guidance to fix your PATH order.
- **Atomic & Safe**: Executable files are installed using atomic replacement (`0755` permissions) and safe symlink replacement, avoiding partial file writes or unintended traversal of unrelated user files.

---

### Running PreBase

PreBase can be used both as an **interactive graphical application** and as a **fast, terminal-native CLI** for scripts, CI pipelines, and developer workflows.

#### 1. Fast Terminal-Native CLI Commands (No browser required)

All CLI commands run in sub-second time directly from your terminal and support both human-friendly formatted terminal output and `--json` for machine consumption:

```bash
# High-level architecture summary: file counts, languages, hub files, and top areas
prebase analyze
prebase analyze /path/to/repo --json

# List indexed repository files with language, size, and analysis status
prebase files
prebase files --language typescript
prebase files --json

# Fast filename and path search ranked by architectural centrality
prebase search "Card"
prebase search "model" --json

# Detailed single-file architecture report: direct dependencies, callers, lines/bytes
prebase inspect src/components/Card.tsx
prebase inspect src/components/Card.tsx --json

# Print direct dependencies imported by a specific file
prebase deps src/app/App.tsx
prebase deps src/app/App.tsx --json

# Print direct dependents (callers) that import a specific file
prebase dependents src/types/graph.ts
prebase dependents src/types/graph.ts --json

# Trace shortest dependency path between any two source files
prebase path src/main.tsx src/types/graph.ts
prebase path src/main.tsx src/types/graph.ts --json

# Stream Git commit history in concise terminal format without starting a browser
prebase history --text --limit 20
prebase history --text --json

# Check background server status or cleanly stop a detached daemon
prebase status
prebase stop
```

#### 2. Interactive Browser Views (Web UI)

```bash
# Analyze repository and open interactive 3D Network Graph in foreground
prebase map

# Launch server in background daemon mode (freeing terminal immediately)
prebase map --detach

# Explicitly launch into Contextual 2D Relationship Explorer
prebase map --view 2d

# Launch directly in 2D mode focused on a specific file
prebase map --view 2d --focus src/components/Card.tsx

# Open directly into the Temporal Graph (Git history DAG)
prebase history

# Analyze an explicit path without automatically opening the browser
prebase map /path/to/project --no-open

# Bind to a custom port and disable filesystem watching
prebase map --port 8080 --no-watch
```

> **View Modes**: PreBase supports both a full volumetric **3D Overview** and a focused **2D Relationship Explorer**. By default, `prebase map` launches in 3D mode. Launching with `--view 2d` (or pressing `V` in the UI) switches directly into the deterministic 2D column view, with optional `--focus <path>` to center on a designated source file.

---

## CLI Reference

```text
PreBase CLI — Codebase Intelligence & Temporal Analysis

Usage: prebase [OPTIONS] [PATH] [COMMAND]

Commands:
  map         Launch interactive Network Graph (3D Overview & 2D Relationship Explorer)
  history     Inspect Git commit ancestry DAG or print concise commit history
  analyze     Print high-level architectural metrics and dependency hubs
  files       List indexed repository source files with language and status
  search      Search files by name or path ranked by dependency importance
  inspect     Display detailed architecture inspection for a specific file
  deps        List direct dependencies imported by a file
  dependents  List direct dependents (callers) that import a file
  path        Trace dependency path connecting two source files
  status      Check status of active PreBase background server for this repository
  stop        Stop active PreBase background server for this repository
  help        Print this message or the help of the given subcommand(s)

Arguments:
  [PATH]  Target repository path to analyze (defaults to current directory)

Options:
      --port <PORT>  Specific port to bind the local server to (defaults to random available port)
      --no-open      Do not automatically open the default web browser
      --no-watch     Disable live filesystem watching and graph synchronization
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
- **RFC 6265 Cookie Port-Scoping Defense**: HTTP cookies on localhost are scoped by host (`127.0.0.1`) and path (`/`), not TCP port (RFC 6265 §8.5). Because standard browsers transmit localhost cookies across differing ports, PreBase scopes its HttpOnly, SameSite=Strict cookies to `prebase_session_{port}`. Each PreBase server validates that incoming cookies strictly match its own allocated port and rejects foreign or un-suffixed cookies.
- **Exact Host Port Validation**: Header must match `127.0.0.1:<port>` or `localhost:<port>`. DNS rebinding attacks from arbitrary hosts are blocked with `400 Bad Request`.
- **Exact Origin Validation**: Cross-origin requests from external origins are rejected with `403 Forbidden`.
- **Single-Use Bootstrap Authentication**: Browser launch generates a cryptographically random single-use bootstrap token exchanged via `POST /api/v1/auth/session` for a secure session cookie, immediately stripped from the URL bar (`history.replaceState`).
- **Non-blocking Safe File Reader (`O_NONBLOCK`)**: Open system calls for source file inspection, TypeScript configuration (`tsconfig.json`), and AST analysis explicitly specify non-blocking mode on Unix platforms (`O_NONBLOCK`), preventing indefinite process hangs or denial-of-service if a path targets a FIFO/named pipe, socket, or device node.
- **TOCTOU Symlink Race Elimination & Regular File Verification**: After opening, descriptors verify `metadata.file_type().is_file()` directly on the active file handle. On Unix platforms, the physical kernel path is resolved from the open descriptor (`F_GETPATH` on macOS, `/proc/self/fd` on Linux) to confirm that the opened file strictly resides within the target repository bounds, mitigating Time-Of-Check to Time-Of-Use (TOCTOU) symlink substitution attacks.
- **Path Traversal & Scope Restrictions**: File access is canonicalized against repository root, rejects `..`, and restricts access to files that exist in the indexed dependency graph snapshot.
- **Bounded Resource Limits & Overflow Protection**: Git stdout is concurrently drained and immediately terminated if output exceeds 10MB; stderr is continuously drained up to 64KB, eliminating OS pipe buffer deadlocks. Source file AST analysis reads are capped at 2MB, `tsconfig.json` reads at 1MB, and HTTP source viewer reads at 500KB.
- **Clean Lifecycle Termination**: Responds to Unix `SIGTERM` and `SIGINT`, cleanly terminating filesystem watcher threads and immediately releasing the loopback TCP port without hanging or leaving orphaned child processes.
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
  - Demand-driven Canvas rendering (pauses render loop when quiescent).
  - 100% offline system fonts and dark/light theme toggle.
  - GitHub Actions CI matrix and automated release workflow.

---

## Known Limitations

- **Language Scope**: PreBase extracts internal dependencies from JavaScript and TypeScript (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`), Rust (`.rs`, `Cargo.toml` crates/modules), and Python (`.py`, `.pyi` packages, modules, and relative imports). Non-source assets and other languages are discovered in the file tree and indexed as unsupported formats.
- **Subprocess Timeout**: Massive repositories with hundreds of thousands of commits may encounter the 10-second subprocess limit on initial root discovery if unindexed.
- **Submodules**: Git submodules are treated as directory boundaries rather than recursively unpacked repositories.

---

## License

Licensed under either of:
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

