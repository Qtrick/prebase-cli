# PreBase CLI — Prompt 1 Implementation Handoff Report

## 1. Implemented Architecture

PreBase CLI is built as an independent, standalone application structured into a 4-crate Rust workspace and a React/TypeScript frontend embedded directly into the compiled executable:

```text
prebase-cli/
├── Cargo.toml
├── crates/
│   ├── prebase-core/       # Canonical graph models, repository scanner, query index
│   ├── prebase-parser/     # Tree-sitter JS/TS/TSX CST parser, module resolver, tsconfig
│   ├── prebase-server/     # Axum loopback HTTP server, security middleware, static asset embed
│   └── prebase-cli/        # Clap CLI commands, process lifecycle, browser launcher
├── frontend/               # Extracted Prebasecode canvas renderer, React UI shell, Vite
├── contracts/              # Shared canonical JSON schema
├── docs/                   # Architecture records, reuse matrix, test specs
└── tests/                  # Golden integration fixture repositories
```

## 2. Implemented Functionality

1. **CLI Commands**:
   - `prebase`: Discovers and analyzes current directory repository.
   - `prebase <path>`: Analyzes specified path.
   - `prebase map`: Opens directly into interactive Network Graph.
   - `prebase history`: Recognizes command and indicates Temporal is scheduled for Prompt 2.
   - `--no-open`: Runs local server without opening default browser.
   - `--port <PORT>`: Optional custom port binding.
   - `--help` and `--version`: Informative CLI output.
   - Graceful shutdown on `Ctrl+C`.

2. **Rust-Native Source Analysis Engine**:
   - Tree-sitter syntax parsing for JavaScript, JSX, TypeScript, and TSX.
   - Extraction of named imports, default imports, namespace imports, side-effect imports, type-only imports, static re-exports (`export ... from`), dynamic `import(...)`, and CommonJS `require(...)`.
   - Resilience against incomplete code and syntax errors.
   - Deterministic module resolution supporting exact relative paths, extension inference (`.ts`, `.tsx`, `.js`, `.jsx`), directory `index` files, and `tsconfig.json` `paths` / `baseUrl`.
   - Classification of external packages (`react`, `lodash`) without fabricating false internal nodes.
   - Recording of `AnalysisIssue` for unresolvable references without polluting the confirmed edge graph.

3. **Canonical Graph Contract & Indexes**:
   - Strict directional invariant: $A \to B$ when $A$ imports $B$.
   - Deduplication of edges with preservation of multiple source evidence instances.
   - O(1) in-memory query indexes for file search, neighbor lookups (dependencies vs dependents), and edge inspection.

4. **Security & Localhost Isolation**:
   - Binds exclusively to `127.0.0.1` (loopback).
   - Host header validation preventing DNS rebinding attacks.
   - Ephemeral session authorization tokens required for all API endpoints.
   - Content Security Policy and frame-ancestors headers.
   - Path traversal prevention ensuring all file reads strictly stay within canonical repository roots.
   - Automatic exclusion of secret-bearing files (`.env*`, `*.pem`, `*.key`) and build directories.

5. **Extracted Interactive Network Visualization**:
   - High-performance canvas renderer extracted from Prebasecode without VS Code dependencies (`acquireVsCodeApi`, workbench services).
   - Deterministic organic 3D/2D force layout with collision prevention.
   - Interactive zoom, pan, hover, click-selection, and double-click focus.
   - Contextual Details Inspector showing file metadata, direct dependencies, direct dependents, edge evidence, and source code previews.
   - Instant search bar with keyboard shortcut (`/`) jumping directly to any indexed node.

## 3. Reused vs. Rewritten Components

### Reused from Prebasecode
- `graphs/src/layouts/network/organicLayout.ts`: Direct port of deterministic force layout.
- `graphs/src/layouts/network/networkNormalization.ts`: Direct port of centering and hash math.
- `graphs/src/view/network/networkRenderMath.ts`: Direct port of perspective projection, semantic weight, depth cueing, and zoom-compensated visual radius.
- `graphs/src/view/network/networkEdgeVisual.ts`: Direct port of authoritative edge visual priorities, line widths, and arrow rendering logic.
- `graphs/src/common/constants/fileTypeColors.ts`: Direct port of file extension color mappings.

### Rewritten in Rust
- `graphs/src/core/scanning/*`: Replaced with `prebase-core::scanner` using `ignore` crate and path validation.
- `graphs/src/core/parsing/*`: Replaced old regex-based parser with Tree-sitter CST analysis in `prebase-parser::ast`.
- `graphs/src/core/resolution/*`: Replaced fuzzy heuristic resolver with deterministic resolver in `prebase-parser::resolver`.
- `graphs/src/core/canonical/*`: Replaced with Rust canonical graph and snapshot serializer in `prebase-core::graph`.
- `graphs/src/core/query/*`: Replaced with in-memory `GraphIndex` in `prebase-core::index`.
- VS Code Webview Workbench Host: Replaced with standalone Axum HTTP server in `prebase-server` and embedded React UI.

## 4. Current Graph Schema and API Contract

See `contracts/canonical-graph.schema.json` and `docs/architecture/GRAPH_CONTRACT.md`.

API Endpoints:
- `GET /api/v1/health`
- `GET /api/v1/status`
- `GET /api/v1/repository`
- `GET /api/v1/network`
- `GET /api/v1/files?q=...&limit=...`
- `GET /api/v1/files/{file_id}`
- `GET /api/v1/edges/{edge_id}`
- `GET /api/v1/source/{file_path}`

## 5. Known Limitations & Technical Debt
- Module resolution covers standard relative paths, directory index files, and `tsconfig.json` `paths` / `baseUrl`. Monorepo symlinked package resolution (e.g. `pnpm` virtual stores) will be expanded as needed.
- Tree-sitter currently parses JS, JSX, TS, and TSX. Other languages (Python, Go, Rust) can be plugged into `prebase-parser` via additional Tree-sitter grammars in future phases.
- Frontend rendering runs on standard 2D Canvas; WebGL was not needed for graphs up to several thousand nodes.

## 6. Preparation for Prompt 2 (Temporal Graph & Live Updates)
1. **Shared Repository Model**: `RepositoryInfo.repository_id` and `FileNode.id` (normalized relative path) provide the stable anchor to connect Git historical file changes with current Network nodes.
2. **Revision Model**: `GraphSnapshot.revision` is ready for Server-Sent Events (SSE) live updates.
3. **Crate Organization**: A `prebase-git` crate can be added alongside `prebase-core` and `prebase-parser` to handle Git commit ancestry, file diffs, and rename detection.

