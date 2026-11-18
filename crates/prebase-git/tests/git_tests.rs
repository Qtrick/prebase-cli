use prebase_git::{GitEngine, GitError};
use std::fs;
use std::process::Command;
use tempfile::tempdir;

fn run_git(dir: &std::path::Path, args: &[&str]) {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(args);
    let output = cmd.output().expect("failed to execute git command");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Defect G1: Literal Pathspec Handling
///
/// `get_file_history` must treat `:(top)private.txt` or `*.txt` as literal filenames
/// and must not expand them as git pathspec magic or wildcards.
#[test]
fn test_defect_g1_literal_pathspec_handling() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "PreBase Test"]);
    run_git(repo_path, &["config", "user.email", "test@prebase.dev"]);

    // 1. Setup commit history for :(top)private.txt vs private.txt
    // Commit 1: Add literal :(top)private.txt
    let top_literal_path = repo_path.join(":(top)private.txt");
    fs::write(&top_literal_path, "top secret literal content\n").unwrap();
    run_git(
        repo_path,
        &["--literal-pathspecs", "add", ":(top)private.txt"],
    );
    run_git(
        repo_path,
        &["commit", "-m", "commit 1: add literal :(top)private.txt"],
    );

    // Commit 2: Add ordinary private.txt
    let private_path = repo_path.join("private.txt");
    fs::write(&private_path, "regular private content\n").unwrap();
    run_git(repo_path, &["add", "private.txt"]);
    run_git(
        repo_path,
        &["commit", "-m", "commit 2: add regular private.txt"],
    );

    // Commit 3: Modify ordinary private.txt
    fs::write(&private_path, "updated regular private content\n").unwrap();
    run_git(repo_path, &["add", "private.txt"]);
    run_git(
        repo_path,
        &["commit", "-m", "commit 3: modify regular private.txt"],
    );

    let engine = GitEngine::new(repo_path.to_path_buf());

    // Query file history for literal `:(top)private.txt`:
    // It MUST NOT match commits 2 or 3 (which only modified private.txt).
    // It MUST only contain commit 1!
    let history_top = engine
        .get_file_history(":(top)private.txt", 10, None)
        .expect("get_file_history for :(top)private.txt failed");

    assert_eq!(
        history_top.commits.len(),
        1,
        "File history for ':(top)private.txt' must only match the literal file, not 'private.txt'. Found: {:?}",
        history_top
            .commits
            .iter()
            .map(|c| &c.summary)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        history_top.commits[0].summary,
        "commit 1: add literal :(top)private.txt"
    );

    // 2. Setup commit history for *.txt wildcard vs literal *.txt
    // Commit 4: Add regular file text.txt
    let text_path = repo_path.join("regular.txt");
    fs::write(&text_path, "regular text file\n").unwrap();
    run_git(repo_path, &["add", "regular.txt"]);
    run_git(repo_path, &["commit", "-m", "commit 4: add regular.txt"]);

    // Commit 5: Add literal file named *.txt
    let star_path = repo_path.join("*.txt");
    fs::write(&star_path, "literal asterisk dot txt\n").unwrap();
    run_git(repo_path, &["--literal-pathspecs", "add", "*.txt"]);
    run_git(repo_path, &["commit", "-m", "commit 5: add literal *.txt"]);

    // Query file history for literal `*.txt`:
    // It MUST NOT match regular.txt, private.txt, etc.
    // It MUST only contain commit 5!
    let history_star = engine
        .get_file_history("*.txt", 10, None)
        .expect("get_file_history for *.txt failed");

    assert_eq!(
        history_star.commits.len(),
        1,
        "File history for '*.txt' must only match the literal file '*.txt', not wildcard matches. Found: {:?}",
        history_star
            .commits
            .iter()
            .map(|c| &c.summary)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        history_star.commits[0].summary,
        "commit 5: add literal *.txt"
    );
}

/// Defect G2: Record Separator Collision
///
/// When a commit subject contains control character `0x1e` (record separator, e.g. `feat: before\x1eafter`),
/// the parsed commit subject must preserve `feat: before\x1eafter` without being truncated to `feat: before`.
#[test]
fn test_defect_g2_record_separator_collision() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "PreBase Test"]);
    run_git(repo_path, &["config", "user.email", "test@prebase.dev"]);

    // Create a commit whose subject contains the record separator byte 0x1e
    let file_path = repo_path.join("file.txt");
    fs::write(&file_path, "hello record separator\n").unwrap();
    run_git(repo_path, &["add", "file.txt"]);

    let subject_with_sep = "feat: before\x1eafter";
    run_git(repo_path, &["commit", "-m", subject_with_sep]);

    let engine = GitEngine::new(repo_path.to_path_buf());

    // 1. Test get_history
    let page = engine.get_history(10, None).expect("get_history failed");

    assert_eq!(
        page.commits.len(),
        1,
        "Expected exactly 1 commit in history"
    );
    assert_eq!(
        page.commits[0].summary, subject_with_sep,
        "Commit subject containing 0x1e must not be truncated; expected {:?}, got {:?}",
        subject_with_sep, page.commits[0].summary
    );

    // 2. Test get_file_history
    let file_history = engine
        .get_file_history("file.txt", 10, None)
        .expect("get_file_history failed");

    assert_eq!(
        file_history.commits.len(),
        1,
        "Expected exactly 1 commit in file history"
    );
    assert_eq!(
        file_history.commits[0].summary, subject_with_sep,
        "File history commit subject containing 0x1e must not be truncated; expected {:?}, got {:?}",
        subject_with_sep, file_history.commits[0].summary
    );
}

/// Verification: Multi-Commit History Framing, Merges, Root Commits, and Pagination Continuity
#[test]
fn test_multi_commit_history_framing() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "Framing Tester"]);
    run_git(repo_path, &["config", "user.email", "framing@prebase.dev"]);

    // 1. Root commit (0 parents)
    let f1 = repo_path.join("root.txt");
    fs::write(&f1, "root commit content\n").unwrap();
    run_git(repo_path, &["add", "root.txt"]);
    run_git(repo_path, &["commit", "-m", "root commit"]);

    // 2. Commit with special characters and emoji
    let f2 = repo_path.join("file2.txt");
    fs::write(&f2, "file 2\n").unwrap();
    run_git(repo_path, &["add", "file2.txt"]);
    run_git(
        repo_path,
        &["commit", "-m", "feat: \x1e control chars & 🚀 emoji"],
    );

    // 3. Commit with empty subject (using allow-empty-message)
    let f3 = repo_path.join("file3.txt");
    fs::write(&f3, "file 3\n").unwrap();
    run_git(repo_path, &["add", "file3.txt"]);
    run_git(repo_path, &["commit", "--allow-empty-message", "-m", ""]);

    // 4. Create feature branch and add commit
    run_git(repo_path, &["checkout", "-b", "feature"]);
    let f_feat = repo_path.join("feature.txt");
    fs::write(&f_feat, "feature work\n").unwrap();
    run_git(repo_path, &["add", "feature.txt"]);
    run_git(repo_path, &["commit", "-m", "feature commit"]);

    // 5. Back on main, add another commit
    run_git(repo_path, &["checkout", "main"]);
    let f_main = repo_path.join("main.txt");
    fs::write(&f_main, "main work\n").unwrap();
    run_git(repo_path, &["add", "main.txt"]);
    run_git(repo_path, &["commit", "-m", "main concurrent commit"]);

    // 6. Merge feature into main (creates merge commit with 2 parents)
    run_git(
        repo_path,
        &[
            "merge",
            "--no-ff",
            "feature",
            "-m",
            "merge branch feature into main",
        ],
    );

    let engine = GitEngine::new(repo_path.to_path_buf());

    // Test get_history pagination
    let page1 = engine.get_history(3, None).expect("page 1 failed");
    assert_eq!(page1.commits.len(), 3);
    assert!(page1.has_more);
    assert!(page1.next_cursor.is_some());

    // Verify merge commit has 2 parents
    let merge_commit = &page1.commits[0];
    assert_eq!(merge_commit.summary, "merge branch feature into main");
    assert_eq!(
        merge_commit.parent_hashes.len(),
        2,
        "Merge commit must have 2 parents"
    );

    // Fetch page 2 using cursor
    let page2 = engine
        .get_history(3, page1.next_cursor.as_deref())
        .expect("page 2 failed");
    assert_eq!(page2.commits.len(), 3);

    // Verify root commit (last in chronological history) has 0 parents
    let root_commit = page2.commits.last().unwrap();
    assert_eq!(root_commit.summary, "root commit");
    assert_eq!(
        root_commit.parent_hashes.len(),
        0,
        "Root commit must have 0 parents"
    );

    // Total count check
    assert_eq!(page1.total_commits, Some(6));
}

/// Verifies anchor continuation and pagination for file history
#[test]
fn test_file_history_anchor_continuation_and_pagination() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "PreBase Test"]);
    run_git(repo_path, &["config", "user.email", "test@prebase.dev"]);

    let tracked_file = repo_path.join("app.ts");
    for i in 1..=15 {
        fs::write(&tracked_file, format!("export const version = {i};\n")).unwrap();
        run_git(repo_path, &["add", "app.ts"]);
        run_git(
            repo_path,
            &["commit", "-m", &format!("commit {i} for app.ts")],
        );
    }

    let engine = GitEngine::new(repo_path.to_path_buf());

    // Fetch page 1 with limit 10
    let page1 = engine
        .get_file_history("app.ts", 10, None)
        .expect("page 1 file history failed");

    assert_eq!(page1.commits.len(), 10);
    assert!(page1.has_more, "Page 1 must have has_more = true");
    assert!(
        page1.next_cursor.is_some(),
        "Page 1 must return next_cursor"
    );

    // Fetch page 2 with cursor
    let page2 = engine
        .get_file_history("app.ts", 10, page1.next_cursor.as_deref())
        .expect("page 2 file history failed");

    assert_eq!(page2.commits.len(), 5);
    assert!(!page2.has_more, "Page 2 must have has_more = false");
    assert!(page2.next_cursor.is_none());

    // Verify disjoint sets (0 duplicate commit SHAs)
    let p1_shas: std::collections::HashSet<_> = page1.commits.iter().map(|c| &c.hash).collect();
    for c in &page2.commits {
        assert!(
            !p1_shas.contains(&c.hash),
            "Duplicate commit SHA in page 2: {}",
            c.hash
        );
    }
}

/// HIST-01: Pagination cursor is pinned to commit revision (`{pinned_head}:{offset}:{last_hash}`)
#[test]
fn test_hist_01_cursor_pinned_to_commit_revision() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "PreBase Test"]);
    run_git(repo_path, &["config", "user.email", "test@prebase.dev"]);

    let tracked_file = repo_path.join("file.txt");
    for i in 1..=15 {
        fs::write(&tracked_file, format!("content version {i}\n")).unwrap();
        run_git(repo_path, &["add", "file.txt"]);
        run_git(
            repo_path,
            &["commit", "-m", &format!("commit {i} for file.txt")],
        );
    }

    let head_sha_bytes = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap()
        .stdout;
    let head_sha = String::from_utf8_lossy(&head_sha_bytes).trim().to_string();

    let engine = GitEngine::new(repo_path.to_path_buf());
    let page1 = engine
        .get_file_history("file.txt", 10, None)
        .expect("page 1 failed");

    assert_eq!(page1.commits.len(), 10);
    assert!(page1.has_more);
    let cursor = page1.next_cursor.expect("next_cursor must be present");

    // Format must be: "{pinned_head}:{offset}:{last_hash}"
    let parts: Vec<&str> = cursor.split(':').collect();
    assert_eq!(
        parts.len(),
        3,
        "Cursor must have exactly 3 colon-delimited parts '{{pinned_head}}:{{offset}}:{{last_hash}}', got: {:?}",
        cursor
    );
    assert_eq!(
        parts[0], head_sha,
        "Cursor pinned_head must match the repository HEAD SHA at page 1 query time"
    );
    assert_eq!(
        parts[1], "10",
        "Cursor offset must be 10 after fetching 10 commits"
    );
    assert_eq!(
        parts[2], page1.commits[9].hash,
        "Cursor last_hash must match the hash of the last commit in page 1"
    );
}

/// HIST-01: Interleaving commits pagination correctness:
/// Create repo with 15 commits to file.txt. Fetch page 1 (limit 10). Create 3 new commits on main.
/// Fetch page 2 using page 1's cursor.
/// Assert: zero duplicate commits, zero skipped commits.
#[test]
fn test_hist_01_interleaving_commits_pagination_correctness() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "PreBase Test"]);
    run_git(repo_path, &["config", "user.email", "test@prebase.dev"]);

    let tracked_file = repo_path.join("file.txt");
    let mut original_hashes = Vec::new();
    for i in 1..=15 {
        fs::write(&tracked_file, format!("line {i}\n")).unwrap();
        run_git(repo_path, &["add", "file.txt"]);
        run_git(repo_path, &["commit", "-m", &format!("commit {i}")]);
        let sha_bytes = Command::new("git")
            .current_dir(repo_path)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout;
        original_hashes.push(String::from_utf8_lossy(&sha_bytes).trim().to_string());
    }

    let engine = GitEngine::new(repo_path.to_path_buf());

    // Fetch page 1 (limit 10)
    let page1 = engine
        .get_file_history("file.txt", 10, None)
        .expect("page 1 failed");
    assert_eq!(page1.commits.len(), 10);
    assert!(page1.has_more);
    let cursor = page1.next_cursor.clone().expect("cursor should exist");

    // Create 3 new interleaving commits on main modifying file.txt
    for i in 16..=18 {
        fs::write(&tracked_file, format!("interleaving commit {i}\n")).unwrap();
        run_git(repo_path, &["add", "file.txt"]);
        run_git(repo_path, &["commit", "-m", &format!("commit {i}")]);
    }

    // Fetch page 2 using page 1's cursor
    let page2 = engine
        .get_file_history("file.txt", 10, Some(&cursor))
        .expect("page 2 failed");

    // Assert: page 2 must fetch the remaining 5 commits from the pinned history
    assert_eq!(
        page2.commits.len(),
        5,
        "Page 2 must return exactly 5 remaining commits from pinned revision"
    );

    // Assert: zero duplicate commits
    let p1_hashes: std::collections::HashSet<_> =
        page1.commits.iter().map(|c| c.hash.clone()).collect();
    for c in &page2.commits {
        assert!(
            !p1_hashes.contains(&c.hash),
            "Duplicate commit found in page 2 that was already in page 1: {} ({})",
            c.hash,
            c.summary
        );
    }

    // Assert: zero skipped commits (all 15 original commits must be present in reverse chronological order)
    let combined_hashes: Vec<String> = page1
        .commits
        .iter()
        .chain(page2.commits.iter())
        .map(|c| c.hash.clone())
        .collect();

    assert_eq!(
        combined_hashes.len(),
        15,
        "Combined page 1 and page 2 must contain exactly 15 commits"
    );

    // Original hashes were chronological 1..=15, git log order is 15..=1
    let mut expected_order = original_hashes.clone();
    expected_order.reverse();
    assert_eq!(
        combined_hashes, expected_order,
        "Combined commits must match the exact pinned original commits with zero skipped"
    );

    // Commits 16, 17, 18 created AFTER page 1 must NOT appear in page 2
    for c in &page2.commits {
        assert!(
            !c.summary.contains("commit 16")
                && !c.summary.contains("commit 17")
                && !c.summary.contains("commit 18"),
            "Interleaved commit appeared in paginated results: {}",
            c.summary
        );
    }
}

/// HIST-01: Invalid cursor format or non-existent commit hash in cursor returns GitError::InvalidRevision or GitError::StaleCursor
#[test]
fn test_hist_01_invalid_cursor_and_non_existent_commit_hash() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "PreBase Test"]);
    run_git(repo_path, &["config", "user.email", "test@prebase.dev"]);

    let tracked_file = repo_path.join("file.txt");
    fs::write(&tracked_file, "initial\n").unwrap();
    run_git(repo_path, &["add", "file.txt"]);
    run_git(repo_path, &["commit", "-m", "initial commit"]);

    let engine = GitEngine::new(repo_path.to_path_buf());

    // 1. Invalid cursor formats: non-SHA, invalid syntax
    let invalid_cursors = [
        "not_a_valid_cursor",
        "zzzzzz:10:yyyyyy",
        "123:abc",
        "::",
        ":10:",
    ];

    for cur in invalid_cursors {
        let res = engine.get_file_history("file.txt", 10, Some(cur));
        assert!(
            res.is_err(),
            "Expected error for invalid cursor '{cur}', but got Ok"
        );
        match res.unwrap_err() {
            GitError::InvalidRevision(_) | GitError::StaleCursor(_) => {}
            other => panic!(
                "Expected GitError::InvalidRevision or GitError::StaleCursor for '{cur}', got: {:?}",
                other
            ),
        }
    }

    // 2. Non-existent commit SHA in cursor
    let fake_sha_cursor =
        "0123456789abcdef0123456789abcdef01234567:10:0123456789abcdef0123456789abcdef01234567";
    let fake_res = engine.get_file_history("file.txt", 10, Some(fake_sha_cursor));
    assert!(
        fake_res.is_err(),
        "Expected error for non-existent commit SHA cursor, but got Ok"
    );
    match fake_res.unwrap_err() {
        GitError::StaleCursor(_) | GitError::InvalidRevision(_) => {}
        other => panic!(
            "Expected GitError::StaleCursor or GitError::InvalidRevision for non-existent SHA, got: {:?}",
            other
        ),
    }
}

/// HIST-01: File history on a file that has been renamed (old.txt -> new.txt)
#[test]
fn test_hist_01_file_rename_history_tracking() {
    let dir = tempdir().expect("failed to create tempdir");
    let repo_path = dir.path();

    run_git(repo_path, &["init", "-b", "main"]);
    run_git(repo_path, &["config", "user.name", "PreBase Test"]);
    run_git(repo_path, &["config", "user.email", "test@prebase.dev"]);

    // Commit 1: create old.txt
    let old_file = repo_path.join("old.txt");
    fs::write(&old_file, "content in old file\n").unwrap();
    run_git(repo_path, &["add", "old.txt"]);
    run_git(repo_path, &["commit", "-m", "commit 1: add old.txt"]);

    // Commit 2: update old.txt
    fs::write(&old_file, "content in old file updated\n").unwrap();
    run_git(repo_path, &["add", "old.txt"]);
    run_git(repo_path, &["commit", "-m", "commit 2: update old.txt"]);

    // Commit 3: rename old.txt -> new.txt
    run_git(repo_path, &["mv", "old.txt", "new.txt"]);
    run_git(
        repo_path,
        &["commit", "-m", "commit 3: rename old.txt to new.txt"],
    );

    // Commit 4: update new.txt
    let new_file = repo_path.join("new.txt");
    fs::write(&new_file, "content in new file updated again\n").unwrap();
    run_git(repo_path, &["add", "new.txt"]);
    run_git(repo_path, &["commit", "-m", "commit 4: update new.txt"]);

    let engine = GitEngine::new(repo_path.to_path_buf());

    // Query file history for new.txt
    let history = engine
        .get_file_history("new.txt", 10, None)
        .expect("get_file_history for new.txt failed");

    assert_eq!(
        history.commits.len(),
        4,
        "File history across rename must follow all 4 commits, found: {:?}",
        history
            .commits
            .iter()
            .map(|c| &c.summary)
            .collect::<Vec<_>>()
    );

    let summaries: Vec<&str> = history.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries[0], "commit 4: update new.txt");
    assert_eq!(summaries[1], "commit 3: rename old.txt to new.txt");
    assert_eq!(summaries[2], "commit 2: update old.txt");
    assert_eq!(summaries[3], "commit 1: add old.txt");
}
