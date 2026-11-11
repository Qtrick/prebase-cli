use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use prebase_parser::RepositoryAnalyzer;
use prebase_server::state::{AppState, ServerEvent};
use prebase_server::watcher::start_repo_watcher;
use tempfile::tempdir;
use tokio::sync::broadcast;

fn init_git_repo(path: &Path) {
    let mut cmd = Command::new("git");
    cmd.current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(["init", "-b", "main"]);
    let status = cmd.status().expect("failed to run git init");
    assert!(status.success(), "git init failed");

    let _ = Command::new("git")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(["config", "user.name", "PreBase Test"])
        .status();

    let _ = Command::new("git")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(["config", "user.email", "test@prebase.dev"])
        .status();

    let _ = Command::new("git")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(["add", "."])
        .status();

    let _ = Command::new("git")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(["commit", "-m", "chore: initial commit"])
        .status();
}

async fn wait_for_network_updated(
    event_rx: &mut broadcast::Receiver<ServerEvent>,
    expected_revision: u64,
    timeout_duration: Duration,
) -> (u64, Vec<String>) {
    let deadline = tokio::time::Instant::now() + timeout_duration;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("Timed out waiting for NetworkUpdated revision {expected_revision}");
        }
        match tokio::time::timeout(remaining, event_rx.recv()).await {
            Ok(Ok(ServerEvent::NetworkUpdated {
                revision,
                changed_files,
                ..
            })) => {
                if revision == expected_revision {
                    return (revision, changed_files);
                } else if revision > expected_revision {
                    panic!(
                        "Received revision {revision} which exceeded expected revision {expected_revision}"
                    );
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("broadcast recv error: {e}"),
            Err(_) => panic!("Timed out waiting for NetworkUpdated revision {expected_revision}"),
        }
    }
}

async fn wait_for_git_updated(
    event_rx: &mut broadcast::Receiver<ServerEvent>,
    timeout_duration: Duration,
) -> (Option<String>, Option<String>) {
    let deadline = tokio::time::Instant::now() + timeout_duration;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("Timed out waiting for GitUpdated event");
        }
        match tokio::time::timeout(remaining, event_rx.recv()).await {
            Ok(Ok(ServerEvent::GitUpdated {
                head_commit,
                branch,
            })) => {
                return (head_commit, branch);
            }
            Ok(Ok(ServerEvent::NetworkUpdated { revision, .. })) => {
                panic!("Unexpected NetworkUpdated revision {revision} received during git update");
            }
            Ok(Ok(_)) => {}
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("broadcast recv error: {e}"),
            Err(_) => panic!("Timed out waiting for GitUpdated event"),
        }
    }
}

#[tokio::test]
async fn test_watcher_live_sync_lifecycle() {
    // 1. Create temporary directory with a synthetic repo (e.g. src/a.ts, src/b.ts)
    let temp_dir = tempdir().expect("failed to create temp dir");
    let repo_path = temp_dir.path();
    let src_dir = repo_path.join("src");
    fs::create_dir_all(&src_dir).expect("failed to create src dir");

    fs::write(
        src_dir.join("a.ts"),
        "export const a = 42;\nexport function getA() { return a; }\n",
    )
    .expect("failed to write a.ts");

    fs::write(
        src_dir.join("b.ts"),
        "import { a } from './a';\nexport const b = a + 1;\n",
    )
    .expect("failed to write b.ts");

    init_git_repo(repo_path);

    let canonical_root = repo_path
        .canonicalize()
        .expect("failed to canonicalize repo path");

    // 2. Initialize AppState and start the real watcher (start_repo_watcher)
    let state = Arc::new(AppState::new(
        canonical_root.clone(),
        "synthetic-repo".to_string(),
        "repo-synthetic-123".to_string(),
        "session-secret".to_string(),
        None,
        9999,
        true,
    ));

    let mut event_rx = state.event_sender.subscribe();

    let watcher_handle =
        start_repo_watcher(state.clone()).expect("failed to start repo filesystem watcher");

    // Allow watcher thread and FSEvents stream to initialize
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 3. Perform initial analysis/publication (rev 1)
    let initial_gen = state.get_next_generation();
    let analyzer = RepositoryAnalyzer::default();
    let initial_analysis = analyzer
        .analyze_path(&canonical_root)
        .expect("initial repository analysis failed");

    let rev_1 = state
        .publish_network(
            initial_analysis.snapshot,
            initial_analysis.index,
            vec![],
            Some(initial_gen),
        )
        .expect("failed to publish initial network state");

    assert_eq!(rev_1, 1);
    assert_eq!(state.get_current_revision(), 1);

    // Verify initial NetworkUpdated event on SSE channel
    let (event_rev, _) = wait_for_network_updated(&mut event_rx, 1, Duration::from_secs(3)).await;
    assert_eq!(event_rev, 1);

    let initial_pub = state
        .get_published()
        .expect("missing published state for rev 1");
    assert_eq!(initial_pub.revision, 1);
    assert!(initial_pub
        .snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/a.ts"));
    assert!(initial_pub
        .snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/b.ts"));

    // 4. Create a new supported source file (src/c.ts importing a.ts), wait deterministically for revision 2
    fs::write(
        src_dir.join("c.ts"),
        "import { a } from './a';\nexport const c = a * 2;\n",
    )
    .expect("failed to write c.ts");

    let (rev_2, changed_2) =
        wait_for_network_updated(&mut event_rx, 2, Duration::from_secs(5)).await;
    assert_eq!(rev_2, 2);
    assert!(
        changed_2.contains(&"src/c.ts".to_string()) || changed_2.contains(&"*".to_string()),
        "changed_files must contain src/c.ts, got: {changed_2:?}"
    );

    let pub_2 = state
        .get_published()
        .expect("missing published state for rev 2");
    assert_eq!(pub_2.revision, 2);
    assert!(
        pub_2
            .snapshot
            .nodes
            .iter()
            .any(|n| n.relative_path == "src/c.ts"),
        "published graph must contain node src/c.ts"
    );

    // 5. Modify src/a.ts, wait for revision 3, verify snapshot updated and SSE event received
    fs::write(
        src_dir.join("a.ts"),
        "export const a = 100;\nexport const updated = true;\n",
    )
    .expect("failed to modify a.ts");

    let (rev_3, changed_3) =
        wait_for_network_updated(&mut event_rx, 3, Duration::from_secs(5)).await;
    assert_eq!(rev_3, 3);
    assert!(
        changed_3.contains(&"src/a.ts".to_string()) || changed_3.contains(&"*".to_string()),
        "changed_files must contain src/a.ts, got: {changed_3:?}"
    );

    let pub_3 = state
        .get_published()
        .expect("missing published state for rev 3");
    assert_eq!(pub_3.revision, 3);
    assert_eq!(state.get_current_revision(), 3);
    let a_node = pub_3
        .snapshot
        .nodes
        .iter()
        .find(|n| n.relative_path == "src/a.ts")
        .expect("src/a.ts node missing");
    assert!(a_node.size_bytes > 0);

    // 6. Delete src/c.ts, wait for revision 4, verify node src/c.ts is REMOVED from the graph snapshot
    fs::remove_file(src_dir.join("c.ts")).expect("failed to delete c.ts");

    let (rev_4, _) = wait_for_network_updated(&mut event_rx, 4, Duration::from_secs(5)).await;
    assert_eq!(rev_4, 4);

    let pub_4 = state
        .get_published()
        .expect("missing published state for rev 4");
    assert_eq!(pub_4.revision, 4);
    assert_eq!(state.get_current_revision(), 4);
    assert!(
        !pub_4
            .snapshot
            .nodes
            .iter()
            .any(|n| n.relative_path == "src/c.ts"),
        "node src/c.ts must be REMOVED from graph snapshot"
    );

    // 7a. Add an unsupported non-ignored file (notes.txt), verify it triggers full rescan and revision increments
    fs::write(repo_path.join("notes.txt"), "Architectural notes\n")
        .expect("failed to write notes.txt");

    let (rev_5, changed_5) =
        wait_for_network_updated(&mut event_rx, 5, Duration::from_secs(5)).await;
    assert_eq!(rev_5, 5);
    assert!(
        changed_5.contains(&"*".to_string()),
        "unsupported non-ignored file must trigger full rescan wildcard: {changed_5:?}"
    );

    let pub_5 = state
        .get_published()
        .expect("missing published state for rev 5");
    assert_eq!(pub_5.revision, 5);
    assert!(
        pub_5
            .snapshot
            .nodes
            .iter()
            .any(|n| n.relative_path == "notes.txt"),
        "notes.txt must appear in snapshot nodes"
    );

    // 7b. Modify ignored files (.DS_Store, scratch.tmp), verify revision does NOT increment
    fs::write(repo_path.join(".DS_Store"), "mock macos ds store")
        .expect("failed to write .DS_Store");
    fs::write(src_dir.join(".DS_Store"), "mock nested ds store")
        .expect("failed to write src/.DS_Store");
    fs::write(repo_path.join("scratch.tmp"), "temporary data")
        .expect("failed to write scratch.tmp");

    // Wait longer than the debounce window (200ms) and confirm no NetworkUpdated event is emitted
    let debounce_window = tokio::time::sleep(Duration::from_millis(600));
    tokio::pin!(debounce_window);
    loop {
        tokio::select! {
            _ = &mut debounce_window => break,
            evt = event_rx.recv() => {
                if let Ok(ServerEvent::NetworkUpdated { revision, .. }) = evt {
                    panic!("Unexpected NetworkUpdated revision {revision} triggered by ignored files");
                }
            }
        }
    }
    assert_eq!(state.get_current_revision(), 5);
    assert!(!state.is_analyzing());

    // 8. Update .git/HEAD, verify git.updated event is emitted and NO source reanalysis / revision increment occurs
    fs::write(
        repo_path.join(".git/HEAD"),
        "ref: refs/heads/feature-live-sync\n",
    )
    .expect("failed to update .git/HEAD");

    let (_head_commit, branch) = wait_for_git_updated(&mut event_rx, Duration::from_secs(5)).await;
    assert_eq!(
        branch.as_deref(),
        Some("feature-live-sync"),
        "branch name should reflect updated HEAD ref"
    );
    assert_eq!(
        state.get_current_revision(),
        5,
        "revision must not increment on git ref update"
    );
    assert!(!state.is_analyzing());

    // Additional quiet window to ensure no delayed reanalysis occurred
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(state.get_current_revision(), 5);
    assert!(!state.is_analyzing());

    // 9. Rapid burst of multiple writes: write 3 files in rapid succession, verify they coalesce into a single follow-up revision (rev 6)
    fs::write(
        src_dir.join("burst1.ts"),
        "export const burst1 = 'burst-1';\n",
    )
    .expect("failed to write burst1.ts");
    fs::write(
        src_dir.join("burst2.ts"),
        "export const burst2 = 'burst-2';\n",
    )
    .expect("failed to write burst2.ts");
    fs::write(
        src_dir.join("burst3.ts"),
        "export const burst3 = 'burst-3';\n",
    )
    .expect("failed to write burst3.ts");

    let (rev_6, changed_6) =
        wait_for_network_updated(&mut event_rx, 6, Duration::from_secs(5)).await;
    assert_eq!(rev_6, 6);

    assert!(
        changed_6.contains(&"*".to_string())
            || (changed_6.contains(&"src/burst1.ts".to_string())
                && changed_6.contains(&"src/burst2.ts".to_string())
                && changed_6.contains(&"src/burst3.ts".to_string())),
        "Coalesced change set must report all burst files: {changed_6:?}"
    );

    let pub_6 = state
        .get_published()
        .expect("missing published state for rev 6");
    assert_eq!(pub_6.revision, 6);
    assert!(pub_6
        .snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/burst1.ts"));
    assert!(pub_6
        .snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/burst2.ts"));
    assert!(pub_6
        .snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/burst3.ts"));

    // Verify coalesce by ensuring no additional revision (rev 7) fires
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        state.get_current_revision(),
        6,
        "burst writes must coalesce into exactly one revision increment"
    );
    assert!(!state.is_analyzing());

    // 10. Verify clean watcher shutdown
    watcher_handle
        .shutdown_tx
        .send(())
        .expect("failed to send shutdown signal to watcher");

    tokio::time::timeout(Duration::from_secs(3), watcher_handle.task_handle)
        .await
        .expect("watcher task timed out during shutdown")
        .expect("watcher task panicked during execution");

    assert!(
        state.is_shutting_down(),
        "state must reflect shutting down flag"
    );
}
