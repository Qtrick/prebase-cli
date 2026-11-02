# Mandatory Session Close Rule: Suggested Commit Message (Plain Text Only)

ALWAYS, after every work session, the agent (Codex, Cursor, Antigravity, or any other AI assistant) MUST provide a suggested commit message following Conventional Commits standards.

## CRITICAL: NO AUTOMATIC GIT COMMITS OR STAGING
**THE AGENT MUST NEVER STAGE FILES (`git add`), COMMIT (`git commit`), OR PUSH (`git push`).**
All changes must remain in the working tree for explicit human review and approval. The suggested commit message must be output as plain text only.

## Required End-of-Session Behavior
1. **Report completed changes**: List files created, modified, or deleted with clear rationale.
2. **Report test results**: Provide exact commands, pass/fail counts, and evidence from actual runs.
3. **Report remaining issues**: Note any edge cases, outstanding risks, or environmental limitations honestly.
4. **Report git status**: Output `git status --short` and `git diff --stat`.
5. **Provide suggested Conventional Commit message**: Format as plain text markdown block.
6. **Stop**: Terminate the session without executing git commit or modifying git history.

## Standards for the Suggested Message
1. **Type Prefix**: Use standard prefixes:
   - `feat:` for new capabilities or surface additions
   - `fix:` for defect fixes or regressions
   - `refactor:` for internal restructuring without behavior change
   - `test:` for adding or updating test suites and fixtures
   - `docs:` for documentation, guides, or specifications
   - `chore:` for build tooling, dependencies, auditor baselines, or asset generation
   - `perf:` for performance optimizations
2. **Scope (Optional)**: e.g. `feat(network):`, `fix(camera):`, `test(browser):`
3. **Subject**: Imperative mood, lowercase, concise (50-72 chars max), no trailing period.
4. **Body**: Detailed breakdown explaining *what* changed and *why*, referencing specific files, components, models, and evidence/testing outcomes.
5. **Footer**: Any breaking change notes, issue references, or release milestone tags.
