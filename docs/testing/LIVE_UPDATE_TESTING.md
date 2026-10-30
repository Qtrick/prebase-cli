# Live Update & Synchronization Test Strategy

## 1. Overview

Live update testing ensures that real-time filesystem modifications result in coherent, thread-safe, and race-free updates to both the Rust backend and the React frontend.

---

## 2. Test Cases

### 2.1 State Coherence & Monotonicity (`test_atomic_state_publication_and_monotonic_revisions`)

Located in `crates/prebase-server/src/lib.rs`:
- **Atomic Pointer Swap**: Verifies that `snapshot` and `index` are updated synchronously under a single lock within `PublishedNetworkState`. Readers cannot observe torn state where the snapshot revision differs from the index revision.
- **Strictly Monotonic Revisions**: Confirms that successive calls to `publish_network` yield revisions $1, 2, 3\dots$ and never regress or stall.
- **Broadcast Delivery**: Asserts that `event_sender` broadcasts `ServerEvent::NetworkUpdated` with matching revision number and changed files list.
- **Stale Analysis Rejection**: Validates that publishing a snapshot with an older generation token than the current generation fails and is safely discarded.

### 2.2 SSE Query Parameter Authentication (`test_auth_and_security_headers`)

Located in `crates/prebase-server/src/lib.rs`:
- Verifies that while unauthenticated requests return `401 Unauthorized`, passing `?token=<valid_session_token>` in the query string succeeds with `200 OK`.
- Ensures compatibility with browser native `EventSource`.

### 2.3 Filesystem Watcher Unit Coverage (`crates/prebase-server/src/watcher.rs`)

- Verifies that non-source files (`.DS_Store`, `.tmp`, `.reference/`, `node_modules/`, `target/`, `dist/`) are filtered out.
- Verifies that `.git/HEAD` and `.git/refs/` trigger `git.updated` broadcast.
- Verifies that source modifications (`.ts`, `.tsx`, `.js`, `.jsx`) are batched into a 250ms debounce window.

---

## 3. Running Live Update Tests

```bash
# Test server atomic state publication and SSE authentication
cargo test -p prebase-server

# Verify entire workspace suite
cargo test --workspace
```

