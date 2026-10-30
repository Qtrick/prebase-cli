pub mod engine;
pub mod error;
pub mod model;
pub mod topology;

pub use engine::GitEngine;
pub use error::GitError;
pub use model::*;

impl CommitDetails {
    pub fn summary_or_message(&self) -> &str {
        self.message.lines().next().unwrap_or("")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::tempdir;

    fn setup_test_git_repo() -> tempfile::TempDir {
        let dir = tempdir().expect("failed to create tempdir");
        let path = dir.path();

        let run = |args: &[&str]| {
            let status = Command::new("git")
                .current_dir(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init"]);
        run(&["config", "user.name", "PreBase Test"]);
        run(&["config", "user.email", "test@prebase.dev"]);

        // Commit 1: Initial commit with 2 files
        fs::write(path.join("file_a.txt"), "hello world\n").unwrap();
        fs::write(path.join("file_b.txt"), "second file\n").unwrap();
        run(&["add", "."]);
        run(&[
            "commit",
            "-m",
            "feat: initial commit with file_a and file_b",
        ]);

        // Commit 2: Modify file_a and add file_c
        fs::write(path.join("file_a.txt"), "hello world modified\n").unwrap();
        fs::write(path.join("file_c.txt"), "new file c\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "chore: update file_a and add file_c"]);

        // Commit 3: Rename file_b to file_b_renamed
        run(&["mv", "file_b.txt", "file_b_renamed.txt"]);
        run(&["commit", "-m", "refactor: rename file_b to file_b_renamed"]);

        dir
    }

    #[test]
    fn test_git_repo_detection_and_status() {
        let dir = setup_test_git_repo();
        let engine = GitEngine::new(dir.path().to_path_buf());

        assert!(engine.is_git_repository());

        let status = engine.get_status().expect("failed to get status");
        assert!(status.is_git_repo);
        assert!(status.head_commit.is_some());
        assert!(!status.is_dirty);
        assert_eq!(status.dirty_files.len(), 0);

        // Make it dirty with spaces and unicode
        fs::write(dir.path().join("untracked with space 🌟.txt"), "dirty").unwrap();
        let dirty_status = engine.get_status().expect("failed to get dirty status");
        assert!(dirty_status.is_dirty);
        assert!(dirty_status
            .dirty_files
            .contains(&"untracked with space 🌟.txt".to_string()));
    }

    #[test]
    fn test_git_history_anchor_pagination() {
        let dir = setup_test_git_repo();
        let engine = GitEngine::new(dir.path().to_path_buf());

        // Page 1: limit 2
        let page1 = engine
            .get_history(2, None)
            .expect("failed to get history page 1");
        assert_eq!(page1.commits.len(), 2);
        assert!(page1.has_more);
        assert_eq!(page1.total_commits, Some(3));
        let cursor = page1.next_cursor.expect("expected next cursor");

        // Add a new commit to HEAD while user is paginating!
        fs::write(dir.path().join("new_file.txt"), "new content").unwrap();
        Command::new("git")
            .current_dir(dir.path())
            .args(["add", "."])
            .status()
            .unwrap();
        Command::new("git")
            .current_dir(dir.path())
            .args(["commit", "-m", "feat: new commit during pagination"])
            .status()
            .unwrap();

        // Page 2: with anchor cursor from Page 1 (must be immune to new commits on HEAD!)
        let page2 = engine
            .get_history(2, Some(&cursor))
            .expect("failed to get history page 2");
        assert_eq!(page2.commits.len(), 1);
        assert!(!page2.has_more);
        assert_eq!(page2.next_cursor, None);

        // Verify no duplicate commits between page 1 and page 2
        let page1_hashes: Vec<_> = page1.commits.iter().map(|c| &c.hash).collect();
        assert!(!page1_hashes.contains(&&page2.commits[0].hash));
    }

    #[test]
    fn test_stale_cursor_detection() {
        let dir = setup_test_git_repo();
        let engine = GitEngine::new(dir.path().to_path_buf());

        // A fabricated SHA that is not an ancestor of HEAD
        let fake_cursor = "0123456789abcdef0123456789abcdef01234567";
        let res = engine.get_history(2, Some(fake_cursor));
        assert!(res.is_err());
        match res.unwrap_err() {
            GitError::StaleCursor(c) => assert_eq!(c, fake_cursor),
            err => panic!("Unexpected error variant: {:?}", err),
        }
    }

    #[test]
    fn test_git_commit_details_and_renames() {
        let dir = setup_test_git_repo();
        let engine = GitEngine::new(dir.path().to_path_buf());

        let history = engine.get_history(10, None).expect("failed to get history");
        assert_eq!(history.commits.len(), 3);

        // Head commit is the rename commit
        let rename_commit = &history.commits[0];
        let details = engine
            .get_commit_details(&rename_commit.hash)
            .expect("failed to get rename commit details");

        assert_eq!(details.author_name, "PreBase Test");
        assert_eq!(
            details.summary_or_message(),
            "refactor: rename file_b to file_b_renamed"
        );

        // Verify rename detection
        let rename_file = details
            .files
            .iter()
            .find(|f| f.status == FileChangeStatus::Renamed)
            .expect("expected renamed file change");
        assert_eq!(rename_file.path, "file_b_renamed.txt");
        assert_eq!(rename_file.old_path, Some("file_b.txt".into()));

        // Initial commit (root commit) details
        let root_commit = &history.commits[2];
        let root_details = engine
            .get_commit_details(&root_commit.hash)
            .expect("failed to get root commit details");
        assert_eq!(root_details.parent_hashes.len(), 0);
        assert_eq!(root_details.files.len(), 2);
        assert!(root_details
            .files
            .iter()
            .all(|f| f.status == FileChangeStatus::Added));
    }

    #[test]
    fn test_merge_commit_file_changes_and_comparison_basis() {
        let dir = tempdir().expect("failed to create tempdir");
        let path = dir.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .current_dir(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init"]);
        run(&["config", "user.name", "Merge Tester"]);
        run(&["config", "user.email", "merge@prebase.dev"]);

        // Commit 1 on main
        fs::write(path.join("base.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "chore: base commit"]);

        // Branch feature
        run(&["checkout", "-b", "feature"]);
        fs::write(path.join("feature_file.txt"), "feature content\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "feat: add feature file"]);

        // Switch back to main and commit on main
        run(&["checkout", "main"]);
        fs::write(path.join("main_file.txt"), "main content\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "chore: add main file"]);

        // Merge feature into main (creates 2-parent merge commit)
        run(&[
            "merge",
            "feature",
            "--no-ff",
            "-m",
            "merge: merge feature into main",
        ]);

        let engine = GitEngine::new(path.to_path_buf());
        let head_history = engine.get_history(1, None).unwrap();
        let merge_commit_hash = &head_history.commits[0].hash;

        let details = engine.get_commit_details(merge_commit_hash).unwrap();
        assert_eq!(
            details.parent_hashes.len(),
            2,
            "Expected 2 parents for merge commit"
        );
        assert!(
            details.comparison_basis.is_some(),
            "Expected comparison basis label"
        );

        // The merge brought feature_file.txt relative to first parent (main)!
        let feature_change = details.files.iter().find(|f| f.path == "feature_file.txt");
        assert!(
            feature_change.is_some(),
            "Expected feature_file.txt in merge commit diff"
        );
        assert_eq!(feature_change.unwrap().status, FileChangeStatus::Added);
    }

    #[test]
    fn test_file_history_with_rename_follow() {
        let dir = setup_test_git_repo();
        let engine = GitEngine::new(dir.path().to_path_buf());

        // File was created as file_b.txt and renamed to file_b_renamed.txt
        let file_hist = engine
            .get_file_history("file_b_renamed.txt", 10)
            .expect("failed to get file history");

        // Should find 2 commits: the rename commit and the initial creation commit!
        assert_eq!(file_hist.commits.len(), 2);
        assert_eq!(file_hist.file_path, "file_b_renamed.txt");
    }

    #[test]
    fn test_empty_repository_handled_gracefully() {
        let dir = tempdir().unwrap();
        Command::new("git")
            .current_dir(dir.path())
            .arg("init")
            .status()
            .unwrap();

        let engine = GitEngine::new(dir.path().to_path_buf());
        assert!(engine.is_git_repository());

        let status = engine.get_status().unwrap();
        assert!(status.is_git_repo);
        assert_eq!(status.head_commit, None);

        let history = engine.get_history(10, None).unwrap();
        assert_eq!(history.commits.len(), 0);
        assert_eq!(history.total_commits, Some(0));
        assert!(!history.has_more);
    }

    #[test]
    fn test_non_git_repository_handled_gracefully() {
        let dir = tempdir().unwrap();
        let engine = GitEngine::new(dir.path().to_path_buf());

        assert!(!engine.is_git_repository());

        let status = engine.get_status().unwrap();
        assert!(!status.is_git_repo);

        let history_err = engine.get_history(10, None);
        assert!(history_err.is_err());
    }

    #[test]
    fn test_branched_dag_pagination_no_skipped_or_duplicated_commits() {
        let dir = tempdir().unwrap();
        let path = dir.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .current_dir(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init"]);
        run(&["config", "user.name", "DAG Test"]);
        run(&["config", "user.email", "dag@prebase.dev"]);

        // 1. Root commit
        fs::write(path.join("root.txt"), "root").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "root commit"]);

        // 2. Main branch commits (m1, m2)
        fs::write(path.join("main1.txt"), "m1").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "main 1 commit"]);

        fs::write(path.join("main2.txt"), "m2").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "main 2 commit"]);

        // 3. Feature branch off root (f1, f2)
        run(&["checkout", "-b", "feature", "HEAD~2"]);
        fs::write(path.join("feat1.txt"), "f1").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "feature 1 commit"]);

        fs::write(path.join("feat2.txt"), "f2").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "feature 2 commit"]);

        // 4. Merge feature into main
        run(&["checkout", "main"]);
        run(&["merge", "feature", "--no-ff", "-m", "merge commit"]);

        // 5. Additional commit on main after merge
        fs::write(path.join("after.txt"), "after").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "post merge commit"]);

        let engine = GitEngine::new(path.to_path_buf());

        // Get total expected commits in single full query
        let full_page = engine.get_history(100, None).unwrap();
        let expected_total = full_page.commits.len();
        assert_eq!(expected_total, 7);
        let expected_hashes: Vec<String> =
            full_page.commits.iter().map(|c| c.hash.clone()).collect();

        // Test pagination with various page sizes: 1, 2, 3, 5
        for page_size in [1, 2, 3, 5] {
            let mut paginated_hashes = Vec::new();
            let mut cursor: Option<String> = None;

            loop {
                let page = engine
                    .get_history(page_size, cursor.as_deref())
                    .expect("page fetch failed");

                for c in &page.commits {
                    assert!(
                        !paginated_hashes.contains(&c.hash),
                        "Duplicate commit detected in page size {}: {}",
                        page_size,
                        c.hash
                    );
                    paginated_hashes.push(c.hash.clone());
                }

                if !page.has_more {
                    assert_eq!(page.next_cursor, None);
                    break;
                }

                assert!(page.next_cursor.is_some());
                cursor = page.next_cursor;
            }

            assert_eq!(
                paginated_hashes.len(),
                expected_total,
                "Missing commits with page size {}",
                page_size
            );
            assert_eq!(
                paginated_hashes, expected_hashes,
                "Topological order mismatch with page size {}",
                page_size
            );
        }
    }

    #[test]
    fn test_git_subprocess_large_output_no_deadlock() {
        let dir = tempdir().unwrap();
        let path = dir.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .current_dir(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init"]);
        run(&["config", "user.name", "Large Test"]);
        run(&["config", "user.email", "large@prebase.dev"]);

        // Create 1,500 files to generate > 100KB stdout during git status / log
        for i in 0..1500 {
            fs::write(path.join(format!("file_{i}.txt")), format!("content {i}\n")).unwrap();
        }
        run(&["add", "."]);
        run(&["commit", "-m", "chore: add 1500 files"]);

        let engine = GitEngine::new(path.to_path_buf());
        // This diff details will output > 100KB of text, exceeding standard 64KB pipe buffer
        let head = engine.get_status().unwrap().head_commit.unwrap();
        let details = engine.get_commit_details(&head).unwrap();
        assert_eq!(details.files.len(), 1500);
    }
}
