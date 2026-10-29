pub mod engine;
pub mod error;
pub mod model;
pub mod topology;

pub use engine::GitEngine;
pub use error::GitError;
pub use model::*;

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

        // Make it dirty
        fs::write(dir.path().join("untracked.txt"), "dirty").unwrap();
        let dirty_status = engine.get_status().expect("failed to get dirty status");
        assert!(dirty_status.is_dirty);
        assert!(dirty_status
            .dirty_files
            .contains(&"untracked.txt".to_string()));
    }

    #[test]
    fn test_git_history_pagination() {
        let dir = setup_test_git_repo();
        let engine = GitEngine::new(dir.path().to_path_buf());

        let history = engine
            .get_history(2, None)
            .expect("failed to get history page 1");
        assert_eq!(history.commits.len(), 2);
        assert!(history.has_more);
        assert_eq!(history.total_commits, Some(3));
        assert!(history.next_cursor.is_some());

        let page2 = engine
            .get_history(2, history.next_cursor.as_deref())
            .expect("failed to get history page 2");
        assert_eq!(page2.commits.len(), 1);
        assert!(!page2.has_more);
        assert_eq!(page2.next_cursor, None);
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
}

impl CommitDetails {
    pub fn summary_or_message(&self) -> &str {
        self.message.lines().next().unwrap_or("")
    }
}
