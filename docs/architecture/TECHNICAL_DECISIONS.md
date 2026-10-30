# PreBase CLI — Technical Decisions Record (ADR)

## ADR-001: Rust Workspace Architecture and Crate Partitioning

### Problem
PreBase requires an independent, robust codebase intelligence engine written in Rust that operates locally, launches via CLI, parses source files, builds a canonical graph model, and serves a local browser interface. A monolithic or poorly bounded structure would entangle CLI argument parsing with AST traversal or web server logic.

### Options Investigated
1. **Single Flat Crate**: Everything in one `src/` directory.
2. **Fine-grained Micro-crates (7+ crates)**: `prebase-cli`, `prebase-core`, `prebase-scanner`, `prebase-parser`, `prebase-resolver`, `prebase-graph`, `prebase-server`, `prebase-git`.
3. **Focused Multi-Crate Workspace (4 crates)**:
   - `prebase-core`: Canonical graph data structures, repository discovery, indexing, and query interfaces.
   - `prebase-parser`: Tree-sitter syntax parsing and TypeScript module resolution.
   - `prebase-server`: Axum HTTP server, static file serving, local API routing, and security middleware.
   - `prebase-cli`: Command-line entrypoint, CLI arguments via `clap`, server lifecycle, and browser launcher.

### Selected Approach
Option 3: Four focused crates in a single Cargo workspace (`crates/prebase-*`).

### Rationale
Provides clean separation of concerns without excessive fragmentation or build overhead. `prebase-parser` can be tested independently with golden AST fixtures without initializing web servers. `prebase-core` remains the single source of truth for canonical graph models and indexes. `prebase-server` enforces security boundaries and HTTP serialization. `prebase-cli` coordinates startup and shutdown.

### Risks
Potential duplication of error types or boilerplate conversions across crate boundaries. Managed using `thiserror` and well-defined shared error classifications.

### Rejected Approaches
- Single flat crate: Violates Ponytail modularity and makes isolated test fixture verification difficult.
- Micro-crates (7+ crates): Over-engineered for MVP; violates Ponytail Code Reduction rule ("Boring over clever. Fewest files possible").

---

## ADR-002: Source Code Parsing with Tree-sitter

### Problem
PreBase must analyze real JavaScript, JSX, TypeScript, and TSX files to extract static imports (`import { ... }`, default imports, namespace imports, side-effect imports, type-only imports) and re-exports (`export ... from ...`), with resilience against syntax errors.

### Options Investigated
1. **Regular Expressions** (as used in previous Prebasecode prototype): Fast to write, but fundamentally unable to correctly handle multi-line imports, complex destructured imports, comments, template literals, or type annotations in TSX.
2. **SWC / Biome / Oxc AST parsers**: Feature-rich JavaScript toolchains, but large dependency footprints with complex C/C++ or Rust dependencies and frequent API churn.
3. **Tree-sitter (`tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`)**: The established industry standard for language-agnostic resilient concrete syntax tree parsing.

### Selected Approach
Option 3: Tree-sitter with `tree-sitter-javascript` and `tree-sitter-typescript` (which provides both TypeScript and TSX grammars).

### Rationale
- **Resilience**: Tree-sitter builds an error-tolerant CST even when source files are partially edited or have syntax errors.
- **Accuracy**: Distinguishes string literals in imports from strings inside comments or template strings.
- **Future Incremental Parsing**: Supports incremental parsing for live updates in Prompt 2.
- **Type-only Awareness**: Accurately classifies `import type { ... }` from runtime imports.

### Risks
Grammar compilation requires a C compiler during build. Mitigated by standard `cc` crate integration supported by all tier-1 Rust platforms.

### Rejected Approaches
- Regex matching: Proved brittle and prone to false positives/negatives in the original repository audit.

---

## ADR-003: Module Resolution Strategy and TypeScript Configuration

### Problem
Parsed import specifiers (e.g. `./components/button`, `@/utils/math`, `react`) must be resolved to canonical file nodes within the analyzed repository, or classified as external/unresolved.

### Options Investigated
1. **Full TypeScript Compiler Compiler Host emulation**: Extremely heavyweight; requires pulling in Node or full TypeScript type checker.
2. **Documented Supported Subset with Deterministic Resolver**:
   - Exact relative resolution (`./foo.ts`, `../bar/baz.js`).
   - Extension inference (`.ts`, `.tsx`, `.js`, `.jsx`).
   - Directory index resolution (`./foo/index.ts`, `./foo/index.tsx`, etc.).
   - Local `tsconfig.json` parsing for `baseUrl` and path aliases (`paths: { "@/*": ["src/*"] }`).
   - Classification of package imports (`react`, `lodash`) as external.
   - Classification of missing files as unresolved.

### Selected Approach
Option 2: Documented supported subset with strict classification:
- `ResolvedInternal(PathBuf)`
- `ExternalPackage(String)`
- `Unresolved(String)`
- `Unsupported(String)`

### Rationale
The MVP specification explicitly requires: *"Never represent guessed or unresolved relationships as confirmed dependencies."* Implementing a deterministic resolver with clear classification ensures graph truthfulness.

### Risks
Complex tsconfig `extends` hierarchies across nested monorepos may not resolve all aliases. Handled gracefully by recording `AnalysisIssue` and tagging unresolved imports rather than fabricating fake graph edges.

---

## ADR-004: HTTP Server and Localhost Security Isolation

### Problem
The local server runs on the developer's workstation. Malicious websites visited by the developer in another browser tab could attempt to execute cross-origin requests (DNS rebinding, CSRF, localhost scanning) to steal sensitive source code or graph data.

### Options Investigated
1. **Open HTTP Server without Authentication**: Typical naive dev server; completely vulnerable to localhost scraping by hostile origins.
2. **Loopback Binding + Session Token + Origin/Host Validation**:
   - Bind exclusively to `127.0.0.1` (never `0.0.0.0`).
   - Dynamic port selection to prevent port squatting.
   - Per-process ephemeral session token generated on CLI startup, passed to the browser URL as a parameter / cookie / authorization header.
   - Strict `Host` header check (rejects requests where `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, defeating DNS rebinding).
   - Strict `Origin` / `Sec-Fetch-Site` validation (rejects unauthorized cross-origin requests).
   - Security response headers: `Content-Security-Policy: default-src 'self' 'unsafe-inline' data:; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
   - Path traversal prevention: Canonicalization and strict root boundary verification on all file lookups.

### Selected Approach
Option 2: Comprehensive multi-layered localhost isolation.

### Rationale
Meets all strict security requirements of the MVP specification (Section 12 and Section 11) from day one.

---

## ADR-005: Canonical Graph Contract and Stable Identifiers

### Problem
The frontend renderer must consume an authoritative, deterministic graph snapshot generated by Rust. Node and edge identifiers must remain stable across rescans and view projections.

### Options Investigated
1. **Dynamic Sequential Integer IDs (0, 1, 2...)**: Volatile; breaks selection and animation across updates.
2. **Full Absolute Paths as IDs**: Leaks developer local filesystem paths to the browser and breaks portability.
3. **Normalized Repository-Relative Path IDs (`repo-rel:<normalized-path>`)**:
   - `id`: e.g. `src/auth/session.ts` (normalized with forward slashes).
   - Edge ID: `edge:<source_id>-><target_id>` (deduplicated; multiple import statements to the same target merge into one canonical edge holding an array of `DependencyEvidence`).
   - Invariant: A imports B produces directed edge `A -> B`.

### Selected Approach
Option 3: Normalized relative path IDs with canonical edge formulation.

### Rationale
- Completely deterministic and reproducible across operating systems.
- Does not expose private user directories in browser DOM or network logs.
- Enables O(1) node lookup and edge deduplication.

---

## ADR-006: Network Graph Renderer Architecture

### Problem
The original Prebasecode graph renderer was a 4865-line file embedded in a VS Code webview. It must be adapted for a standalone browser without losing its high-performance canvas rendering, organic force layout, depth cueing, or visual polish.

### Options Investigated
1. **Rewrite everything into React components and SVG**: Unusable for medium-to-large graphs; SVG DOM explosion leads to severe frame drops during pan/zoom.
2. **Replace with generic third-party graph library (e.g. Cytoscape, vis.js, react-flow)**: Violates product mandate to retain Prebasecode's distinct visual identity, organic 3D/2D perspective, and tested edge render strategies.
3. **Decoupled Standalone Canvas Engine mounted in a React Shell**:
   - Extract the pure TypeScript math modules (`networkRenderMath.ts`, `networkEdgeVisual.ts`, `organicLayout.ts`, `fileTypeColors.ts`).
   - Create a clean `NetworkCanvas` component managing the HTML5 `<canvas>`, DPR scaling, camera transform (`transform = { x, y, k }`), hit testing, pointer gesture listeners, and `requestAnimationFrame` loop.
   - Wrap in a modern, lightweight React application shell providing search, navigation, details inspector, and status indicators.

### Selected Approach
Option 3: Extracted high-performance canvas engine within a clean React shell.

### Rationale
Preserves 100% of Prebasecode's visual algorithms, depth cueing, edge visual priorities, and arrow geometry, while completely severing all VS Code webview and workbench dependencies.

---

## ADR-007: Stable Git History Traversal and Anchor-Based Pagination

### Problem
Pagination using numeric offset skips (`--skip N`) breaks whenever commits are added or HEAD branches change between page requests. An offset-based cursor can return duplicate commits or skip commits if history shifts.

### Options Investigated
1. **Numeric Offset Cursor (`skip=N`)**: Simple, but fragile under concurrent commits or branch checkouts.
2. **Persistent Database of Commits (SQLite / embedded DB)**: Heavyweight; introduces cache invalidation complexities, disk overhead, and sync drift.
3. **Anchor Commit Cursor with History Generation Verification**:
   - The client passes `cursor=<commit_hash>` anchored to the last seen commit.
   - The engine checks if the anchor commit exists in current HEAD history (`git merge-base --is-ancestor <anchor> HEAD`).
   - If the anchor is valid, the log resumes strictly after that commit (`<anchor>~1`).
   - If the anchor is no longer an ancestor (e.g. branch checkout), return a structured `410 Gone / StaleCursor` error letting the frontend refresh from new HEAD.

### Selected Approach
Option 3: Anchor commit SHA cursor with ancestor verification.

### Rationale
Provides O(1) storage overhead, avoids external databases, guarantees no duplicates in stable traversal, and detects stale branches deterministically.

---

## ADR-008: Bounded and Cancellable Subprocess Execution

### Problem
Executing `git` commands synchronously with standard `Command::output()` risks unbounded execution time and memory consumption on huge repositories or adversarial inputs.

### Options Investigated
1. **Unbounded Synchronous Execution**: High risk of hangs or OOM.
2. **Asynchronous Bounded Execution with Deadline and Buffer Cap**:
   - `tokio::process::Command` with explicit execution deadline (`tokio::time::timeout`, 10s default).
   - Bounded stdout/stderr reader (max 10MB) to prevent buffer overflows.
   - Kill child process on cancellation or timeout (`kill_on_drop(true)`).

### Selected Approach
Option 2: Asynchronous execution with deadline, output bounds, and child process cleanup.

---

## ADR-009: Session Bootstrap and Credential Protection

### Problem
Passing long-lived session tokens in URL query strings exposes credentials in shell history, browser address bar, and terminal logs.

### Options Investigated
1. **Permanent Session Token in URL (`?token=...`)**: Insecure; URL persists in browser history and logs.
2. **Short-Lived Single-Use Bootstrap Token with HttpOnly Cookie Exchange**:
   - Server generates a single-use bootstrap token valid for 30 seconds.
   - Browser opens with `?bootstrap=<bootstrap_token>`.
   - Frontend immediately exchanges bootstrap token via `POST /api/v1/auth/session` to obtain an `HttpOnly`, `SameSite=Strict` cookie (or local bearer token).
   - URL parameter is immediately stripped via `history.replaceState`.
   - Host header and exact port matching enforced on all requests.

### Selected Approach
Option 2: Single-use bootstrap token exchanged for scoped session credentials and stripped from URL.

---

## ADR-010: Demand-Driven Canvas Rendering and Layout Preservation

### Problem
Continuous `requestAnimationFrame` loops waste significant CPU/battery even when the graph is static. Full re-layout on live updates causes existing nodes to jump randomly across the screen.

### Options Investigated
1. **Continuous 60fps Loop with Full Relayout**: Consumes 20-40% idle CPU and disorients developers during code edits.
2. **Demand-Driven Redraw with Incremental Position Seeding**:
   - Frame renders are scheduled only when inputs change: viewport pan/zoom, hover, selection, or graph state update.
   - When a new snapshot arrives, existing node coordinates are preserved in the positions map.
   - New nodes are seeded near connected neighbors; removed nodes are cleaned up without moving unchanged nodes.

### Selected Approach
Option 2: Demand-driven rendering with node position preservation.


