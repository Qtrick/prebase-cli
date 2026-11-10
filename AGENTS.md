# PreBase Agent Governance and Engineering Standards

## 1. Mandatory Git Governance — Strict No-Commit Rule

**ALL CODING AGENTS (ANTIGRAVITY, SUBAGENTS, CODEX, CURSOR, BACKGROUND TASKS, AND AUTOMATION) ARE STRICTLY FORBIDDEN FROM PERFORMING UNAUTHORIZED GIT MUTATIONS.**

- **Never stage files** (`git add`) without explicit, documented user approval.
- **Never create commits** (`git commit`) without explicit user approval.
- **Never amend commits** (`git commit --amend`) without approval.
- **Never push** (`git push`) to any remote without approval.
- **Never merge** (`git merge`) or **rebase** (`git rebase`) without approval.
- **Never create or publish tags** (`git tag`) without approval.
- **Never create pull requests** without approval.
- **Never perform destructive resets** (`git reset --hard`) or discard user work (`git checkout -- .`, `git restore .`).
- **Never delete or overwrite unrelated user changes**.
- **Never perform automatic end-of-session commits**.
- **Never treat a suggested Conventional Commit message as permission or authorization to commit.**
- **Leave all changes uncommitted in the working tree** for the user's personal manual review.
- At session close, report the working-tree diff summary (`git status`, `git diff --stat`) and provide a suggested Conventional Commit message as **plain text only**.

### Permitted Git Operations (Read-Only)
Only non-destructive, read-only inspection commands are permitted without prior authorization:
```bash
git status
git status --short
git diff
git diff --stat
git diff --check
git log
git show
git branch --show-current
git ls-files
git check-ignore
```

---

## 2. Mandatory Live GitHub Actions Verification Rule

**EVERY PREBASE CLI DEVELOPMENT CAMPAIGN MUST BEGIN WITH A LIVE GITHUB ACTIONS AUDIT.**

Before implementation:
1. Identify the actual repository remote (`git remote -v`).
2. Inspect recent commits and verify current branch.
3. Retrieve recent GitHub Actions workflow runs (`gh run list --repo <owner>/<repo> --limit 30`).
4. Identify failed and cancelled runs.
5. Retrieve failed jobs and steps (`gh run view <run_id> --log-failed`).
6. Inspect actual failed job logs.
7. Determine the exact failure mechanism.
8. Correlate failures with commits and affected source files.
9. Check whether the same defect remains in the working tree.
10. Add unresolved CI failures to the implementation plan.

*Never guess why CI failed. Read the logs.* Never claim GitHub Actions is green unless an actual remote run for the corrected commit has succeeded.

---

## 3. Engineering Workflow

All implementation and bug remediation must follow the iterative engineering loop:

$$\text{PLAN} \longrightarrow \text{IMPLEMENT} \longrightarrow \text{TEST} \longrightarrow \text{REVIEW} \longrightarrow \text{FIX} \longrightarrow \text{RETEST} \longrightarrow \text{REAUDIT}$$

Agents must drive continuously through this cycle until all task acceptance criteria are fully met or genuine environmental blockers are explicitly documented with evidence.

---

## 4. Specialist Roles and Delegations

Agents must utilize appropriate specialists throughout development:
- **`code-reviewer-editor`**: Evaluates integrated diffs for correctness, race conditions, memory leaks, performance, and accessibility; applies focused patches to conclusive defects.
- **`test-writer`**: Independently identifies coverage gaps, edge cases, state transitions, and writes high-value behavioral regression tests (avoiding trivial passthrough tests).
- **`test-runner`**: Runs unit, integration, typecheck, lint, and browser E2E test suites; reports truthful pass/fail baselines without editing production code.
- **`security-reviewer`**: Audits trust boundaries, auth/session tokens, SSE streams, CORS/origin validation, path traversal guards, and network safety.
- **UI/UX & Design Review**: Utilize UI/UX Pro Max, available design-taste skills (`ui-ensemble`, `pen-design`), and frontend reviews for high-fidelity visual and interaction validation.
- **`Ponytail Code Reduction`**: Enforce radical simplicity: reuse existing code, avoid unnecessary abstractions/dependencies, prefer stdlib/native solutions, and produce the smallest safe working diff.

*Honesty Requirement*: Never claim a specialist was invoked or a test passed unless it actually ran and produced verifiable evidence.

---

## 5. Code Quality and Architecture Invariants

- **Minimal Necessary Abstractions**: Avoid premature generalizations, framework creep, or unnecessary state stores.
- **Reuse Existing Code**: Always inspect existing utilities, math modules, and layout algorithms before introducing new ones.
- **Single Source of Truth**: Never duplicate state authority (e.g. split camera models or parallel snapshot revision states).
- **Zero Unnecessary Dependencies**: Do not introduce heavy external libraries (e.g., Three.js) when existing native canvas math suffices.
- **Root-Cause Remediation**: Fix underlying algorithmic and architectural causes, not surface symptoms. Grep all call sites.
- **Meaningful Regression Tests**: Every non-trivial fix must have an automated test demonstrating that the bug cannot regress.
- **Actual Runtime & Real Browser Verification**: Do not rely solely on unit tests or type checks. Verify behaviors in the running application and browser via Playwright.

---

## 6. Source Safety and Reference Isolation

- The `.reference/` directory contains historical reference material (e.g., Code - OSS Prebasecode).
- Agents may freely inspect `.reference/` for algorithms, projection math, and architectural insights.
- **Never package, commit, publish, or copy license-incompatible code from `.reference/` into the active CLI project.**
- Keep the active CLI codebase self-contained, clean, and distinct.

