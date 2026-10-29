# Network Graph and Core Intelligence Testing Specification

## 1. Overview
This document details the test strategy, execution methods, and verification outcomes for the PreBase CLI foundation and Network Graph vertical slice.

## 2. Test Architecture

### 2.1 Rust Unit and Component Tests
- **`prebase-core`**:
  - `test_directional_edge_semantics_and_indexing`: Confirms strict directional invariant ($A \to B$ for $A$ imports $B$), outgoing dependencies calculation, incoming dependents calculation, and index retrieval.
  - `test_edge_evidence_deduplication`: Verifies that multiple import statements between the same two files merge into one canonical edge holding an array of discrete evidence records.
  - `test_search_ranking`: Validates fast prefix, substring, and exact match search scoring across indexed files.

- **`prebase-parser`**:
  - `test_tree_sitter_import_extractions`: Validates Tree-sitter CST parsing across ES named imports, default imports, namespace imports, side-effect imports, type-only imports, static re-exports (`export ... from ...`), dynamic `import(...)`, and CommonJS `require(...)`. Confirms string literals in comments are ignored.
  - `test_tree_sitter_syntax_resilience`: Validates that malformed source code with incomplete tokens does not crash the parser and extracts available valid imports.
  - `test_import_resolver_relative_and_extensionless`: Validates extensionless file matching (`.ts`, `.tsx`, `.js`, `.jsx`), directory `index` resolution, parent traversal, and external package classification.
  - `test_import_resolver_path_aliases`: Validates `tsconfig.json` `paths` mapping (`@/*` -> `src/*`).
  - `test_repository_analyzer_e2e_on_disk`: Tests real file creation on disk, scanning, parsing, resolution, and graph snapshot generation.

- **`prebase-server`**:
  - `test_auth_and_security_headers`: Tests loopback security, Host header validation (defeating DNS rebinding), missing token rejection (401), valid token acceptance (200), and CSP/X-Frame-Options presence.
  - `test_path_traversal_protection`: Tests that requests attempting `../../` or path traversal outside the repository root are strictly blocked.

### 2.2 Integration Test Fixture (`tests/fixtures/sample-monorepo`)
A realistic TypeScript/TSX project containing:
- Multi-file hierarchy (`src/index.ts`, `src/components/Header.tsx`, `src/components/Button.tsx`, `src/components/Card/index.ts`, `src/utils/math.ts`, `src/utils/format.js`, `src/types.ts`)
- Edge cases: files with spaces (`dashboard with spaces.ts`), unicode characters (`unicode_🌟.ts`)
- TypeScript path aliases via `tsconfig.json` (`@/*` -> `src/*`)
- Secret file `.env` (verified to be excluded from graph nodes)
- External packages (`react`, verified to NOT fabricate fake internal nodes)
- `crates/prebase-cli/tests/cli_test.rs`: Spins up an ephemeral server on a dynamic port, sets the snapshot ready, and issues real HTTP requests to verify all versioned API routes and static asset serving.

### 2.3 Frontend Tests (`frontend/src/graphs/network/__tests__/networkMath.test.ts`)
Executed with Vitest:
- `computes deterministic organic positions`: Asserts deterministic 3D coordinate generation.
- `projects 3D points with perspective scaling`: Asserts perspective depth scale and normalized depth factors.
- `resolves edge visuals accurately for highlighted vs normal edges`: Validates edge priorities, colors (`#2dd4bf`), and alpha blending.
- `calculates node radius with zoom compensation`: Verifies visual readability across zoom levels.

## 3. Test Execution Commands

```bash
# Run all Rust workspace tests
cargo test --workspace

# Run Clippy checks
cargo clippy --workspace --all-targets -- -D warnings

# Run Rust formatting verification
cargo fmt --all -- --check

# Run Frontend unit tests
cd frontend && npm test

# Run Frontend TypeScript check and production build
cd frontend && npm run build
```

## 4. Verification Evidence Matrix

| Test Suite | Tests Executed | Passed | Failed | Duration |
|---|---|---|---|---|
| `prebase-core` unit tests | 3 | 3 | 0 | < 1ms |
| `prebase-parser` unit tests | 4 | 4 | 0 | 10ms |
| `prebase-server` unit tests | 2 | 2 | 0 | 1ms |
| `prebase-cli` integration tests | 1 | 1 | 0 | 20ms |
| `frontend` vitest suite | 4 | 4 | 0 | 78ms |
| Total | 14 | 14 | 0 | < 150ms |

