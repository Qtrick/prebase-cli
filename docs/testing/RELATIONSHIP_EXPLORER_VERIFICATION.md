# PreBase CLI — 2D Relationship Explorer Verification Report

**Suites**: `scripts/e2e_stage2_verification.py`, `frontend/src/graphs/relationship/__tests__/`  
**Execution Environment**: Headless Chromium (Playwright) + Vitest  
**Verification Date**: 2026-11-01  
**Status**: **ALL VERIFICATION CHECKS PASSED**

---

## 1. Executive Summary

This suite validates the Contextual 2D Relationship Explorer in PreBase CLI across CLI flag parsing, URL routing, directional dependency graph derivation, deterministic columnar layout, Bézier edge routing, depth traversal controls, purposeful empty states, and bidirectional view transitions.

```text
======================================================================
ALL STAGE 2 END-TO-END VERIFICATION CHECKS PASSED!
======================================================================
```

---

## 2. Invariant Verification Matrix

| Category | Invariant Verified | Evidence & Mechanism | Status |
| :--- | :--- | :--- | :--- |
| **CLI & URL Routing** | `--view 2d` and `--focus <path>` parsing | Clap enum validates `3d` and `2d`. Paths with spaces and unicode are percent-encoded via RFC 3986. `api.ts` extracts parameters and purges `bootstrap` without reload. | **PASS** |
| **Directional Semantics** | Dependency arrow invariant ($A \text{ imports } B \iff A \to B$) | `deriveRelationshipGraph` maps direct incoming imports to Dependents (Column -1) and direct outgoing imports to Dependencies (Column +1). | **PASS** |
| **Multi-Hop Traversal** | 1-hop and 2-hop upstream/downstream extraction | `depth=1` limits to immediate neighbors; `depth=2` reveals second-hop callers (Column -2) and callees (Column +2). Interactive depth buttons dynamically rebuild graph. | **PASS** |
| **Safety Budgets** | Bounded rendering for massive modules | Enforces `MAX_NODES = 120` and `MAX_EDGES = 240`. Omission counts reported cleanly via `OmissionStats` and warning banner. | **PASS** |
| **Deterministic Layout** | Monotonic $X$ coordinates & Bézier routing | Columns positioned monotonically: $X_{-2} < X_{-1} < X_0 < X_1 < X_2$. Forward edges, cyclic dependencies, reverse cycle arcs, and self-loops route without visual collisions. | **PASS** |
| **Purposeful Empty State** | Missing or deleted focus file handling | When `--focus non_existent.ts` is requested, renders `.relationship-empty-state` with AlertCircle icon, file citation, and top candidate recommendations. | **PASS** |
| **State Preservation** | 3D $\leftrightarrow$ 2D roundtrip invariance | Switching between modes preserves 3D camera coordinates (`yaw`, `pitch`, `panX`, `panY`, `zoom`). Unfocused canvas RAF rendering loop is paused via `isVisible: false`. | **PASS** |
| **Keyboard Accessibility** | Full navigation via keyboard | `ArrowLeft`/`ArrowRight` traverses columns; `ArrowUp`/`ArrowDown` navigates cards within column; `Enter` re-centers focus; `Backspace` navigates history. | **PASS** |

---

## 3. Unit and Integration Test Results

- `relationshipStateAndLiveReconciliation.test.ts`: 10 passed (history navigation, snapshot reconciliation, selection synchronization).
- `deriveRelationshipGraph.test.ts`: 16 passed (directional classification, cycle detection, safety budgets).
- `relationshipLayout.test.ts`: 9 passed (monotonic coordinates, responsive vertical fallback, Bézier control points).
- Total Stage 2 Unit Tests: **35 passed (0 failed)** in Vitest.

