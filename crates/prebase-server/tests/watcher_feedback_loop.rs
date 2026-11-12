use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use prebase_parser::RepositoryAnalyzer;
use prebase_server::state::AppState;
use prebase_server::watcher::start_repo_watcher;
use tempfile::tempdir;

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

#[tokio::test]
async fn test_server_log_ignored_no_feedback_loop() {
    let temp_dir = tempdir().expect("failed to create temp dir");
    let repo_path = temp_dir.path();
    let src_dir = repo_path.join("src");
    fs::create_dir_all(&src_dir).expect("failed to create src dir");

    fs::write(
        src_dir.join("main.ts"),
        "export const message = 'hello world';\n",
    )
    .expect("failed to write main.ts");

    init_git_repo(repo_path);

    let canonical_root = repo_path
        .canonicalize()
        .expect("failed to canonicalize repo path");

    let state = Arc::new(AppState::new(
        canonical_root.clone(),
        "feedback-loop-test".to_string(),
        "repo-fl-1".to_string(),
        "session-secret".to_string(),
        None,
        9998,
        true,
    ));

    let watcher_handle =
        start_repo_watcher(state.clone()).expect("failed to start repo filesystem watcher");

    tokio::time::sleep(Duration::from_millis(150)).await;

    // Initial analysis
    let initial_gen = state.get_next_generation();
    let analyzer = RepositoryAnalyzer::default();
    let initial_analysis = analyzer
        .analyze_path(&canonical_root)
        .expect("initial analysis failed");

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

    // Register the server log path on state as the process output destination
    let log_file = repo_path.join("server.log");
    state.register_process_log_path(&log_file);

    // Rapidly write to server.log 50 times (simulating server logger stdout)
    for i in 0..50 {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
            .expect("failed to open server.log");
        writeln!(f, "[2026-11-11 23:00:00 INFO] Processing request #{i}")
            .expect("failed to write log");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Wait long enough for any debounce and analysis cycles to run if they were triggered
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Revision must strictly remain 1 because server.log is ignored
    assert_eq!(
        state.get_current_revision(),
        1,
        "Revision climbed despite writes being to server.log!"
    );

    let _ = watcher_handle.shutdown_tx.send(());
}

#[tokio::test]
async fn test_high_frequency_modifications_coalesced_and_throttled() {
    let temp_dir = tempdir().expect("failed to create temp dir");
    let repo_path = temp_dir.path();
    let src_dir = repo_path.join("src");
    fs::create_dir_all(&src_dir).expect("failed to create src dir");

    fs::write(src_dir.join("main.ts"), "export const count = 0;\n")
        .expect("failed to write main.ts");

    init_git_repo(repo_path);

    let canonical_root = repo_path
        .canonicalize()
        .expect("failed to canonicalize repo path");

    let state = Arc::new(AppState::new(
        canonical_root.clone(),
        "coalesce-test".to_string(),
        "repo-fl-2".to_string(),
        "session-secret".to_string(),
        None,
        9997,
        true,
    ));

    let watcher_handle =
        start_repo_watcher(state.clone()).expect("failed to start repo filesystem watcher");

    tokio::time::sleep(Duration::from_millis(150)).await;

    // Initial analysis
    let initial_gen = state.get_next_generation();
    let analyzer = RepositoryAnalyzer::default();
    let initial_analysis = analyzer
        .analyze_path(&canonical_root)
        .expect("initial analysis failed");

    let rev_1 = state
        .publish_network(
            initial_analysis.snapshot,
            initial_analysis.index,
            vec![],
            Some(initial_gen),
        )
        .expect("failed to publish initial network state");

    assert_eq!(rev_1, 1);

    // Rapidly write 30 changes to an unignored file over 300ms
    let file = src_dir.join("main.ts");
    for i in 1..=30 {
        fs::write(&file, format!("export const count = {i};\n")).expect("failed to write main.ts");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Allow debounce (200ms) and cooldown (300ms) to settle
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let final_rev = state.get_current_revision();
    // 30 bursts over 300ms with 200ms debounce and 300ms cooldown must coalesce into <= 3 revisions
    assert!(
        (2..=3).contains(&final_rev),
        "Expected revisions to be coalesced to 2..=3, but got revision {final_rev}"
    );

    let _ = watcher_handle.shutdown_tx.send(());
}

#[tokio::test]
async fn test_legitimate_user_server_log_is_discovered_and_watched() {
    let temp_dir = tempdir().expect("failed to create temp dir");
    let repo_path = temp_dir.path();
    let src_dir = repo_path.join("src");
    fs::create_dir_all(&src_dir).expect("failed to create src dir");

    fs::write(src_dir.join("main.ts"), "export const count = 0;\n")
        .expect("failed to write main.ts");

    // Legitimate user server.log in repo
    let user_log = repo_path.join("server.log");
    fs::write(&user_log, "Initial user server log content\n").expect("failed to write server.log");

    init_git_repo(repo_path);

    let canonical_root = repo_path
        .canonicalize()
        .expect("failed to canonicalize repo path");

    let state = Arc::new(AppState::new(
        canonical_root.clone(),
        "user-log-test".to_string(),
        "repo-fl-3".to_string(),
        "session-secret".to_string(),
        None,
        9996,
        true,
    ));
    let watcher_handle =
        start_repo_watcher(state.clone()).expect("failed to start repo filesystem watcher");

    tokio::time::sleep(Duration::from_millis(150)).await;

    // Initial analysis: user server.log is discovered by scanner
    let initial_gen = state.get_next_generation();
    let analyzer = RepositoryAnalyzer::default();
    let initial_analysis = analyzer
        .analyze_path(&canonical_root)
        .expect("initial analysis failed");

    // User server.log must be discovered
    assert!(
        initial_analysis.snapshot.coverage.total_discovered >= 2,
        "User server.log must be included in discovered files"
    );

    let rev_1 = state
        .publish_network(
            initial_analysis.snapshot,
            initial_analysis.index,
            vec![],
            Some(initial_gen),
        )
        .expect("failed to publish initial network state");

    assert_eq!(rev_1, 1);

    // Now user edits their server.log (not a process output destination)
    {
        let mut f = OpenOptions::new()
            .append(true)
            .open(&user_log)
            .expect("failed to open user server.log");
        writeln!(f, "[USER APPLICATION] Server started on port 8080")
            .expect("failed to write user server.log");
    }

    // Wait for watcher debounce & rescan
    tokio::time::sleep(Duration::from_millis(800)).await;

    // The revision must increment because a user file changed!
    assert!(
        state.get_current_revision() > 1,
        "Revision must advance when legitimate user server.log is edited!"
    );

    let _ = watcher_handle.shutdown_tx.send(());
}
