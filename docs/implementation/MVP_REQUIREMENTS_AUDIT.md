# PreBase CLI — MVP Requirements Audit & Remediation Matrix

## 1. Audit Framework & Classification

This document establishes the definitive requirements compliance and status baseline for PreBase CLI across all three development campaigns. Every requirement is assessed against actual working source code and empirical execution.

Statuses:
- **Verified complete**: Fully implemented, tested, and validated.
- **Implemented but unverified**: Code exists but lacks complete edge-case or production test coverage.
- **Partially implemented**: Core functionality exists but key capabilities or error handling are missing.
- **Defective**: Implementation is broken, fragile, or produces incorrect behavior under stress/edge cases.
- **Missing**: Not implemented in source code.
- **Intentionally excluded**: Explicitly deferred out-of-scope for the MVP.

---

## 2. Requirements Matrix

| ID | Requirement Area | Original Specification | Implementation Location | Current Status | Verification Evidence | Known Limitations | Required Correction | Final Acceptance Test |
|---|---|---|---|---|---|---|---|---|
| **REQ-01** | CLI Startup & Orchestration | Discovers repo, allocates loopback port, starts backend, opens browser | `crates/prebase-cli/src/main.rs` | **Verified complete** | `cli_test.rs`, manual CLI run on port 8999 | None | Minor: pass bootstrap token instead of permanent session in URL | `test_cli_startup_and_navigation` |
| **REQ-02** | Rust Tree-sitter Parser | Parse JS/JSX/TS/TSX, extract ES/CJS/Dynamic imports & exports | `crates/prebase-parser/src/ast.rs`, `analyzer.rs` | **Verified complete** | 4 unit tests in `prebase-parser` | Syntax errors skip damaged nodes safely | None | `test_tree_sitter_import_extractions` |
| **REQ-03** | Module Resolution | Resolve relative, extensionless, index, and `tsconfig.json` path aliases | `crates/prebase-parser/src/resolver.rs`, `tsconfig.rs` | **Verified complete** | Fixture tests in `cli_test.rs` | External node_modules packages intentionally unresolved | Add invalidation on `tsconfig.json` edits | `test_tsconfig_invalidation` |
| **REQ-04** | Canonical Graph Model | Structured snapshots with nodes, edges, resolution status, import evidence | `crates/prebase-core/src/model.rs`, `graph.rs`, `index.rs` | **Verified complete** | 3 tests in `prebase-core` | None | None | `test_directional_edge_semantics_and_indexing` |
| **REQ-05** | Network Graph Visualization | Interactive canvas rendering, organic layout, 3D projection, zoom, pan | `frontend/src/graphs/network/NetworkCanvas.tsx`, `organicLayout.ts` | **Partially implemented** | Vitest tests in `networkMath.test.ts` | Relayout on updates changes node coordinates; continuous RAF loop wastes CPU | Implement layout node position preservation & demand-driven rendering | `test_network_viewport_and_position_preservation` |
| **REQ-06** | File & Edge Inspection | Inspect node dependencies/dependents, edge line/col evidence, source snippet | `frontend/src/inspector/Inspector.tsx`, `crates/prebase-server/src/routes.rs` | **Partially implemented** | Manual inspection test | Source endpoint unbounded; lacks check that requested file is in indexed set | Restrict source endpoint to indexed files; bound read size (max 200KB) | `test_source_preview_authorization_and_bounds` |
| **REQ-07** | Git History Traversal | Commits, ancestry DAG, author/timestamp, commit body | `crates/prebase-git/src/engine.rs`, `model.rs` | **Partially implemented** | 8 tests in `prebase-git` | Uses numeric skip offset for pagination; fragile when HEAD moves | Implement anchor-based commit cursor & stale-cursor detection | `test_git_history_stable_pagination` |
| **REQ-08** | Git Metadata Parsing | Multiline messages, unicode names, full SHAs | `crates/prebase-git/src/engine.rs` | **Partially implemented** | Initial commit tests | Custom ASCII control delimiters can conflict with user-controlled messages | Use robust NUL-delimited/framed machine output | `test_git_metadata_parsing_adversarial` |
| **REQ-09** | Merge Commit Changes | Display changed files for merge commits | `crates/prebase-git/src/engine.rs` | **Defective** | Merge commit test in topology | `diff-tree` without comparison base produces 0 changed files for merge commits | Compare against first parent (`hash^1`) by default and label comparison basis | `test_git_merge_commit_file_changes` |
| **REQ-10** | Subprocess Safety | Safe git execution with bounds and timeouts | `crates/prebase-git/src/engine.rs` | **Defective** | None | Unbounded execution time; no cancellation or output limits | Introduce 10s deadline, max 10MB output buffer, subprocess reaping | `test_git_subprocess_timeout_and_bounds` |
| **REQ-11** | Worktrees & Status | Support detached HEAD, unborn branches, worktrees, unicode/space paths | `crates/prebase-git/src/engine.rs` | **Partially implemented** | `test_git_repo_detection_and_status` | Status uses porcelain v1 with line splitting; doesn't handle worktrees | Use `git status -z -uall`; detect `.git` file worktrees | `test_git_worktrees_and_status_null_delimited` |
| **REQ-12** | Temporal Canvas Rendering | Canvas DAG, topological lanes, branch curves, commit badges | `frontend/src/graphs/temporal/TemporalCanvas.tsx`, `temporalLayout.ts` | **Partially implemented** | Vitest tests in `temporalLayout.test.ts` | Continuous RAF loop; parent edges to unloaded commits terminate abruptly | Implement demand-driven rendering and boundary continuation markers | `test_temporal_demand_rendering_and_pagination` |
| **REQ-13** | Cross-Graph Navigation | Jump from Network inspector to Temporal, and from Temporal to Network | `frontend/src/app/App.tsx`, `Inspector.tsx`, `CommitInspector.tsx` | **Verified complete** | Integration tests, manual verification | None | Enhance historical file indicators | `test_cross_graph_navigation_e2e` |
| **REQ-14** | Live Filesystem Watcher | Detect file changes, reanalyze, emit update events | `crates/prebase-server/src/watcher.rs` | **Partially implemented** | Server tests | Does not invalidate on `tsconfig.json` changes; possible channel drop | Add `tsconfig.json` invalidation, queue overflow rescan fallback | `test_watcher_incremental_and_tsconfig_invalidation` |
| **REQ-15** | State Coherence & Monotonicity | Single-lock state swap, strictly monotonic revisions, stale rejection | `crates/prebase-server/src/state.rs` | **Verified complete** | `test_atomic_state_publication_and_monotonic_revisions` | Concurrency window between generation check and write lock | Enclose generation check inside write lock | `test_atomic_state_concurrency` |
| **REQ-16** | Server-Sent Events (SSE) | Stream updates without page reload, preserve view | `crates/prebase-server/src/routes.rs`, `frontend/src/transport/api.ts` | **Partially implemented** | `test_auth_and_security_headers` | Token in query param; frontend does not reconcile on reconnection | Implement bootstrap token exchange, reconnection reconciliation | `test_sse_reconnection_and_reconciliation` |
| **REQ-17** | Localhost Security Controls | Loopback binding, Host verification, Origin isolation, CSP | `crates/prebase-server/src/auth.rs` | **Defective** | `test_auth_and_security_headers` | Origin check uses `starts_with`; Host doesn't check exact port; external fonts in HTML | Exact Host/Origin comparison, remove external fonts, strict CSP | `test_security_host_origin_and_offline_csp` |
| **REQ-18** | UI/UX Refinement | Dark/Light themes, keyboard shortcuts, responsive layout | `frontend/src/app/App.tsx`, `App.css` | **Partially implemented** | Manual inspection | Only dark mode available; lacks light theme and comprehensive keyboard nav | Add theme toggle, keyboard shortcuts (`/`, `Esc`, `1`, `2`) | `test_theme_and_keyboard_navigation` |
| **REQ-19** | Performance & Scalability | Handle medium to large repositories with low idle CPU | `prebase-parser`, `prebase-git`, frontend canvas | **Implemented but unverified** | Baseline on small monorepo | No benchmarks on 500+ or 2,000+ file repos; idle CPU high | Add benchmark script (`scripts/benchmark.sh`), demand-driven canvas | `benchmark_large_repository` |
| **REQ-20** | Reproducible Build & Release | Standalone binary embedding frontend, CI, packaging, licensing | Root `README.md`, `Cargo.toml`, frontend build | **Partially implemented** | Release build works | Missing `build.sh`, `check.sh`, `package.sh`, CI workflow, license files | Add build scripts, GitHub Actions CI, package script with SHA256, license files | `test_clean_build_and_ci` |

---

## 3. Explicitly Excluded Features (Out of Scope for MVP)

The following capabilities are deliberately excluded from the PreBase MVP and deferred to future releases:
- Python, Go, Rust source language parsing.
- AI chat, AI coding agents, and LLM integrations.
- Graph Diff as a separate standalone product module.
- Architecture drift scoring and policy enforcement engines.
- Cloud backends, user accounts, and billing systems.
- Generalized data-flow tracing and runtime dynamic tracing.
- VS Code extension and IDE embedder plugins.

