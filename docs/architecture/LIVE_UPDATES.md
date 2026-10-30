# Live Repository Intelligence & State Synchronization Architecture

## 1. Motivation & Challenges Addressed

During Campaign 1, the PreBase server performed a single initial parse of the repository. Subsequent code edits on disk went undetected unless the CLI was restarted. Furthermore, architectural audits identified two concurrency concerns:
1. **Lock Tearing (Finding C)**: Storing `snapshot` and `index` in distinct, independent `RwLock` primitives meant a concurrent reader could read revision $N$ of the snapshot while accessing revision $N-1$ of the index.
2. **Revision Monotonicity (Finding D)**: Revisions were hardcoded, preventing clients from discerning whether state had changed.
3. **Inspector Async Races (Finding F)**: Rapidly selecting nodes could result in out-of-order fetch fulfillment where an earlier request overwrote a newer selection.
4. **SSE Browser Authentication (Finding H)**: The native browser `EventSource` API does not allow setting custom HTTP headers (`x-prebase-session`).

Campaign 2 resolves all of these issues with a cohesive, Rust-native live monitoring and synchronization subsystem.

---

## 2. Coherent Atomic State Publication

### 2.1 The `PublishedNetworkState` Record

In `crates/prebase-server/src/state.rs`, the state model unifies snapshot and index into an immutable container:

```rust
#[derive(Clone)]
pub struct PublishedNetworkState {
    pub revision: u64,
    pub snapshot: Arc<GraphSnapshot>,
    pub index: Arc<GraphIndex>,
    pub timestamp: u64,
}
```

The application state encapsulates this via a single read-write lock:
```rust
pub struct AppState {
    pub published: RwLock<Option<Arc<PublishedNetworkState>>>,
    pub revision_counter: AtomicU64,
    pub analysis_generation: AtomicU64,
    // ...
}
```

### 2.2 Guarantees

- **Single Lock Swap**: When publication occurs (`publish_network`), a single write lock updates the `published` pointer. Readers querying `/api/v1/network`, `/api/v1/files`, or `/api/v1/edges` acquire a single read lock and clone the `Arc<PublishedNetworkState>`, guaranteeing that snapshot and index are always synchronized to the exact same revision.
- **Strictly Monotonic Revisions**: `revision_counter.fetch_add(1, Ordering::SeqCst) + 1` assigns sequential revisions ($1, 2, 3\dots$).
- **Stale Analysis Rejection**: Before background analysis begins, `analysis_generation` is captured. If a newer change arrives while the analyzer is running, the generation advances. When the older analysis completes, its generation token mismatches, and it is safely discarded.

---

## 3. Rust Filesystem Watcher (`crates/prebase-server/src/watcher.rs`)

### 3.1 Event Classification & Noise Rejection

The watcher utilizes `notify::RecommendedWatcher` configured in recursive mode. It filters events into two streams:

```
Filesystem Event
       │
       ├─► Contains "node_modules", "target", "dist", ".reference", ".tmp" ──► Discard
       │
       ├─► Contains ".git/HEAD" or ".git/refs/" ─────────────────────────────► Mark git_ref_changed = true
       │
       └─► Extension in [.js, .jsx, .ts, .tsx] ──────────────────────────────► Record in changed_sources
```

### 3.2 Debouncing Strategy

Modern IDEs (VS Code, JetBrains) often execute multiple discrete filesystem operations for a single save (atomic write-to-temp, delete, rename, chmod).
- Events are buffered into a 250ms debounce window.
- When the window expires:
  - If `git_ref_changed` is true, `state.notify_git_updated()` broadcasts a `git.updated` event.
  - If `changed_sources` is non-empty, a background reanalysis task is spawned, passing the expected generation token to `publish_network`.

---

## 4. Authenticated Server-Sent Events (SSE) Transport

### 4.1 Browser Authentication

Because native browser `EventSource` cannot send custom HTTP headers like `x-prebase-session`, the authentication middleware in `crates/prebase-server/src/auth.rs` accepts the session token via either:
1. `x-prebase-session: <token>` HTTP Header.
2. `?token=<token>` Query Parameter.

Host header verification (`127.0.0.1` / `localhost`) and Origin validation protect the SSE stream from DNS rebinding and cross-origin hijacking.

### 4.2 Stream Protocol

The `/api/v1/events` endpoint streams JSON-formatted events with periodic keep-alive heartbeats every 15 seconds:

```json
{"type": "network.updated", "data": {"revision": 2, "changed_files": ["src/index.ts"], "node_count": 73, "edge_count": 47}}
```
```json
{"type": "git.updated", "data": {"head_commit": "490a2d4...", "branch": "main"}}
```
```json
{"type": "heartbeat", "data": {"timestamp": 1793310000}}
```

---

## 5. Frontend View Preservation & Race Condition Elimination

### 5.1 Viewport and Selection Stability

When a `network.updated` event arrives in the browser:
1. `api.getNetwork()` fetches the new revision.
2. `snapshot` state is updated.
3. In `NetworkCanvas.tsx`, camera `transform` ($x, y, k$) is **not** reset, allowing developers to inspect a specific node or cluster while live edits apply in real time.
4. If a node was selected, its reference is reconciled against the new snapshot rather than cleared.

### 5.2 Async Race Prevention (Finding F)

In `Inspector.tsx` and `CommitInspector.tsx`:
- Each request increments a monotonic `requestTokenRef.current`.
- An `AbortController` cancels previous in-flight requests.
- When a response arrives, it verifies `currentToken === requestTokenRef.current` before updating React state, guaranteeing that rapid selection clicks never render stale responses out of order.

