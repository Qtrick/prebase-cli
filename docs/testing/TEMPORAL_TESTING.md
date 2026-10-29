# Temporal Graph & Git Engine Test Strategy

## 1. Test Architecture Overview

The Temporal subsystem is validated across three verification tiers:
1. **Rust Native Git Engine Unit & Integration Tests (`crates/prebase-git`)**: Tests real git operations against programmatic, isolated temporary Git repositories created with `tempfile`.
2. **Rust Server & Endpoints Integration Tests (`crates/prebase-server` & `crates/prebase-cli`)**: Verifies HTTP route serialization, error status codes, and security.
3. **Frontend Geometry & Topology Tests (`frontend/src/graphs/temporal/__tests__`)**: Validates 2D canvas layout, lane allocations, edge extraction, and time formatting.

---

## 2. Test Matrix

| Component | Test File | Test Case | Purpose |
|---|---|---|---|
| `prebase-git` | `topology.rs` | `test_single_linear_branch_single_lane` | Verifies linear history commits remain on single lane 0 |
| `prebase-git` | `topology.rs` | `test_branch_and_merge_lanes` | Verifies branch commits occupy parallel lanes and merge correctly into trunk |
| `prebase-git` | `lib.rs` | `test_git_repo_detection_and_status` | Tests branch retrieval, head commit, clean state, and dirty working tree detection |
| `prebase-git` | `lib.rs` | `test_git_history_pagination` | Verifies limit, skip offset cursor, and total commit count |
| `prebase-git` | `lib.rs` | `test_git_commit_details_and_renames` | Verifies author/committer parsing, root commit handling, and rename tracking with similarity |
| `prebase-git` | `lib.rs` | `test_file_history_with_rename_follow` | Verifies `--follow` tracks file across previous renames |
| `prebase-git` | `lib.rs` | `test_empty_repository_handled_gracefully` | Verifies 0-commit repository returns clean empty list rather than erroring |
| `prebase-git` | `lib.rs` | `test_non_git_repository_handled_gracefully` | Verifies graceful error when target is not a Git repo |
| `frontend` | `temporalLayout.test.ts` | `assigns unique coordinates and extracts parent edges` | Verifies node positioning, parent DAG edges, and bounding box computation |
| `frontend` | `temporalLayout.test.ts` | `cycles through distinct lane colors` | Verifies lane palette rotation and stability |
| `frontend` | `temporalLayout.test.ts` | `formats relative timestamps correctly` | Verifies seconds-to-relative-time formatting (m, h, d) |
| `prebase-cli` | `cli_test.rs` | `test_sample_monorepo_analysis_and_server` | Tests end-to-end Axum server with `/api/v1/git/status`, static asset serving, and security headers |

---

## 3. Running Temporal Tests

### Rust Suite
```bash
cargo test -p prebase-git
```

### Frontend Suite
```bash
npm --prefix frontend test
```

### End-to-End Workspace Suite
```bash
cargo test --workspace
```
