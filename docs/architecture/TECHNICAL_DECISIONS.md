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

