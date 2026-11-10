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

    fn test_git_cmd(path: &std::path::Path) -> Command {
        let mut cmd = Command::new("git");
        cmd.current_dir(path)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE");
        cmd
    }

    fn setup_test_git_repo() -> tempfile::TempDir {
        let dir = tempdir().expect("failed to create tempdir");
        let path = dir.path();

        let run = |args: &[&str]| {
            let status = test_git_cmd(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init", "-b", "main"]);
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

        // Deterministic fixture assertion: the caller's global init.defaultBranch
        // must never decide which branch these tests operate on.
        let head_branch = test_git_cmd(path)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .expect("failed to read HEAD branch");
        assert!(head_branch.status.success(), "git rev-parse failed");
        assert_eq!(
            String::from_utf8_lossy(&head_branch.stdout).trim(),
            "main",
            "test fixture must start on an explicit 'main' branch"
        );

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
    fn test_git_status_filename_exactness_spaces_and_renames() {
        let dir = setup_test_git_repo();
        let path = dir.path();
        let engine = GitEngine::new(path.to_path_buf());

        // 1. Untracked file with leading spaces
        fs::write(path.join("   leading_space.txt"), "leading").unwrap();

        // 2. Untracked file with trailing spaces
        fs::write(path.join("trailing_space.txt   "), "trailing").unwrap();

        // 3. Staged rename with spaces
        let run = |args: &[&str]| {
            let out = test_git_cmd(path).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["mv", "file_a.txt", "renamed file with spaces.txt"]);

        let status = engine.get_status().expect("failed to get status");
        assert!(status.is_dirty);

        // Verify exact filename preservation (leading and trailing spaces must NOT be trimmed)
        assert!(
            status
                .dirty_files
                .contains(&"   leading_space.txt".to_string()),
            "Expected leading spaces preserved, got: {:?}",
            status.dirty_files
        );
        assert!(
            status
                .dirty_files
                .contains(&"trailing_space.txt   ".to_string()),
            "Expected trailing spaces preserved, got: {:?}",
            status.dirty_files
        );
        assert!(
            status
                .dirty_files
                .contains(&"renamed file with spaces.txt".to_string()),
            "Expected renamed destination path preserved, got: {:?}",
            status.dirty_files
        );
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
        test_git_cmd(dir.path())
            .args(["add", "."])
            .status()
            .unwrap();
        test_git_cmd(dir.path())
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
            let status = test_git_cmd(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init", "-b", "main"]);
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
        test_git_cmd(dir.path()).arg("init").status().unwrap();

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
            let status = test_git_cmd(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init", "-b", "main"]);
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
            let status = test_git_cmd(path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "git {:?} failed", args);
        };

        run(&["init", "-b", "main"]);
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

    // Mutex ensuring tests mutating ambient process environment run serialized.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        saved_git_dir: Option<std::ffi::OsString>,
        saved_git_work_tree: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(git_dir: Option<&std::path::Path>, git_work_tree: Option<&std::path::Path>) -> Self {
            let saved_git_dir = std::env::var_os("GIT_DIR");
            let saved_git_work_tree = std::env::var_os("GIT_WORK_TREE");

            match git_dir {
                Some(p) => unsafe { std::env::set_var("GIT_DIR", p) },
                None => unsafe { std::env::remove_var("GIT_DIR") },
            }
            match git_work_tree {
                Some(p) => unsafe { std::env::set_var("GIT_WORK_TREE", p) },
                None => unsafe { std::env::remove_var("GIT_WORK_TREE") },
            }

            Self {
                saved_git_dir,
                saved_git_work_tree,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.saved_git_dir {
                Some(v) => unsafe { std::env::set_var("GIT_DIR", v) },
                None => unsafe { std::env::remove_var("GIT_DIR") },
            }
            match &self.saved_git_work_tree {
                Some(v) => unsafe { std::env::set_var("GIT_WORK_TREE", v) },
                None => unsafe { std::env::remove_var("GIT_WORK_TREE") },
            }
        }
    }

    #[test]
    fn test_git_engine_scoped_despite_ambient_git_dir_and_work_tree() {
        let _lock = ENV_LOCK.lock().unwrap();

        // 1. Setup primary repo (the intended target for GitEngine)
        let primary_dir = tempdir().unwrap();
        let primary_path = primary_dir.path();
        let run_primary = |args: &[&str]| {
            let status = test_git_cmd(primary_path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "primary git {:?} failed", args);
        };
        run_primary(&["init", "-b", "main"]);
        run_primary(&["config", "user.name", "Primary User"]);
        run_primary(&["config", "user.email", "primary@prebase.dev"]);
        fs::write(primary_path.join("primary.txt"), "hello primary\n").unwrap();
        run_primary(&["add", "primary.txt"]);
        run_primary(&["commit", "-m", "feat: commit in primary repo"]);

        let primary_head_output = test_git_cmd(primary_path)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let primary_head = String::from_utf8_lossy(&primary_head_output.stdout)
            .trim()
            .to_string();

        // 2. Setup ambient repo (a completely separate repo that ambient env might point to)
        let ambient_dir = tempdir().unwrap();
        let ambient_path = ambient_dir.path();
        let run_ambient = |args: &[&str]| {
            let status = test_git_cmd(ambient_path)
                .args(args)
                .status()
                .expect("failed to execute git");
            assert!(status.success(), "ambient git {:?} failed", args);
        };
        run_ambient(&["init", "-b", "main"]);
        run_ambient(&["config", "user.name", "Ambient User"]);
        run_ambient(&["config", "user.email", "ambient@prebase.dev"]);
        fs::write(ambient_path.join("ambient.txt"), "hello ambient\n").unwrap();
        run_ambient(&["add", "ambient.txt"]);
        run_ambient(&["commit", "-m", "feat: commit in ambient repo"]);

        let ambient_head_output = test_git_cmd(ambient_path)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let ambient_head = String::from_utf8_lossy(&ambient_head_output.stdout)
            .trim()
            .to_string();

        assert_ne!(primary_head, ambient_head);

        // 3. Setup a plain non-git directory
        let non_git_dir = tempdir().unwrap();

        let engine = GitEngine::new(primary_path.to_path_buf());

        // Case A: Ambient GIT_DIR and GIT_WORK_TREE point to ambient_repo
        {
            let _env_guard = EnvGuard::set(Some(&ambient_path.join(".git")), Some(ambient_path));

            // GitEngine must be scoped to primary_path, NOT ambient_path
            assert!(engine.is_git_repository());

            let status = engine.get_status().expect("failed to get status");
            assert!(status.is_git_repo);
            assert_eq!(
                status.head_commit.as_deref(),
                Some(primary_head.as_str()),
                "status.head_commit must reflect primary repo, not ambient repo"
            );

            // Verify dirty tracking isolation
            fs::write(
                primary_path.join("primary_uncommitted.txt"),
                "dirty primary",
            )
            .unwrap();
            fs::write(
                ambient_path.join("ambient_uncommitted.txt"),
                "dirty ambient",
            )
            .unwrap();

            let dirty_status = engine.get_status().expect("failed to get dirty status");
            assert!(
                dirty_status
                    .dirty_files
                    .contains(&"primary_uncommitted.txt".to_string()),
                "dirty files must include files in primary repo"
            );
            assert!(
                !dirty_status
                    .dirty_files
                    .contains(&"ambient_uncommitted.txt".to_string()),
                "dirty files must NOT include files from ambient repo"
            );

            // Verify history is scoped to primary repo
            let history = engine.get_history(10, None).expect("failed to get history");
            assert_eq!(history.commits.len(), 1);
            assert_eq!(history.commits[0].hash, primary_head);
            assert_eq!(history.commits[0].summary, "feat: commit in primary repo");

            // Verify commit details scoped to primary repo
            let details = engine
                .get_commit_details(&primary_head)
                .expect("failed to get commit details");
            assert_eq!(details.hash, primary_head);
            assert!(details.files.iter().any(|f| f.path == "primary.txt"));
            assert!(!details.files.iter().any(|f| f.path == "ambient.txt"));

            // Verify non-git directory is NOT considered a git repo even if ambient GIT_DIR exists
            let non_git_engine = GitEngine::new(non_git_dir.path().to_path_buf());
            assert!(
                !non_git_engine.is_git_repository(),
                "non-git directory must not be detected as git repository due to ambient GIT_DIR"
            );
            let non_git_status = non_git_engine.get_status().expect("status should succeed");
            assert!(!non_git_status.is_git_repo);
            assert_eq!(non_git_status.head_commit, None);
        }

        // Case B: Ambient GIT_DIR points to a broken / nonexistent path
        {
            let nonexistent = primary_path.join("nonexistent_git_dir_xyz");
            let _env_guard = EnvGuard::set(Some(&nonexistent), Some(&nonexistent));

            // Engine must still succeed and remain scoped to primary_path
            assert!(engine.is_git_repository());
            let status = engine
                .get_status()
                .expect("engine must ignore broken ambient GIT_DIR");
            assert_eq!(status.head_commit.as_deref(), Some(primary_head.as_str()));
        }
    }
}
