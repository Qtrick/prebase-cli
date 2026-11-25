use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;

/// Helper function to locate the fixture repository
fn get_fixture_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("tests/fixtures/sample-monorepo")
}

/// Helper to create a temporary Git repository for history testing
fn create_temp_git_repo() -> TempDir {
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let repo_path = temp_dir.path();

    // git init
    let status = Command::new("git")
        .args(["init"])
        .current_dir(repo_path)
        .status()
        .expect("git init failed to execute");
    assert!(status.success(), "git init must succeed");

    // git config
    Command::new("git")
        .args(["config", "user.name", "Test Author"])
        .current_dir(repo_path)
        .status()
        .expect("git config user.name failed");

    Command::new("git")
        .args(["config", "user.email", "test@prebase.dev"])
        .current_dir(repo_path)
        .status()
        .expect("git config user.email failed");

    // Create a commit
    std::fs::write(repo_path.join("README.md"), "# Temp Git Repo\n").unwrap();
    Command::new("git")
        .args(["add", "README.md"])
        .current_dir(repo_path)
        .status()
        .expect("git add failed");

    Command::new("git")
        .args(["commit", "-m", "Initial commit for prebase history test"])
        .current_dir(repo_path)
        .status()
        .expect("git commit 1 failed");

    // Create a second commit
    std::fs::write(
        repo_path.join("index.ts"),
        "export const hello = 'world';\n",
    )
    .unwrap();
    Command::new("git")
        .args(["add", "index.ts"])
        .current_dir(repo_path)
        .status()
        .expect("git add 2 failed");

    Command::new("git")
        .args(["commit", "-m", "feat: add index.ts entrypoint"])
        .current_dir(repo_path)
        .status()
        .expect("git commit 2 failed");

    temp_dir
}

#[test]
fn test_cli_help_and_version() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");

    // 1. --help test
    let output = Command::new(prebase_bin)
        .arg("--help")
        .output()
        .expect("Failed to execute prebase --help");

    assert!(output.status.success(), "Exit code must be 0 for --help");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("PreBase is a local-first codebase intelligence tool"),
        "Help output must contain CLI description"
    );
    assert!(stdout.contains("analyze"), "Must list analyze command");
    assert!(stdout.contains("files"), "Must list files command");
    assert!(stdout.contains("search"), "Must list search command");
    assert!(stdout.contains("inspect"), "Must list inspect command");
    assert!(stdout.contains("deps"), "Must list deps command");
    assert!(
        stdout.contains("dependents"),
        "Must list dependents command"
    );
    assert!(stdout.contains("path"), "Must list path command");
    assert!(stdout.contains("history"), "Must list history command");
    assert!(stdout.contains("map"), "Must list map command");

    // 2. --version test
    let output_ver = Command::new(prebase_bin)
        .arg("--version")
        .output()
        .expect("Failed to execute prebase --version");

    assert!(
        output_ver.status.success(),
        "Exit code must be 0 for --version"
    );
    let stdout_ver = String::from_utf8_lossy(&output_ver.stdout);
    assert!(
        stdout_ver.contains("prebase"),
        "Version output must contain 'prebase'"
    );
}

#[test]
fn test_cli_analyze_command() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");
    let fixture_dir = get_fixture_dir();

    // 1. Text mode
    let output = Command::new(prebase_bin)
        .args(["analyze", fixture_dir.to_str().unwrap()])
        .output()
        .expect("Failed to execute analyze");

    assert!(output.status.success(), "analyze must exit with 0");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("PreBase Repository Intelligence"));
    assert!(stdout.contains("Discovered Files:"));
    assert!(stdout.contains("Analyzed Sources:"));
    assert!(stdout.contains("Confirmed Links:"));
    assert!(stdout.contains("Architectural Areas:"));
    assert!(stdout.contains("Languages:"));
    assert!(stdout.contains("typescript"));

    // 2. JSON mode
    let output_json = Command::new(prebase_bin)
        .args(["analyze", fixture_dir.to_str().unwrap(), "--json"])
        .output()
        .expect("Failed to execute analyze --json");

    assert!(
        output_json.status.success(),
        "analyze --json must exit with 0"
    );
    let json_text = String::from_utf8_lossy(&output_json.stdout);
    let v: serde_json::Value =
        serde_json::from_str(&json_text).expect("analyze --json output must be valid JSON");

    assert_eq!(v["repository"]["name"], "sample-monorepo");
    assert!(v["summary"]["discovered_files"].as_u64().unwrap() >= 5);
    assert!(v["summary"]["analyzed_files"].as_u64().unwrap() >= 5);
    assert!(v["summary"]["connections"].as_u64().unwrap() >= 4);
    assert!(v["summary"]["areas"].as_u64().unwrap() >= 1);
    assert!(v["languages"].is_array());
    assert!(v["entry_candidates"].is_array());
    assert!(!v["entry_candidates"].as_array().unwrap().is_empty());

    // 3. Error on non-existent repository path
    let output_err = Command::new(prebase_bin)
        .args(["analyze", "/nonexistent/path/for/prebase/tests"])
        .output()
        .expect("Failed to execute invalid analyze");

    assert_eq!(
        output_err.status.code(),
        Some(1),
        "Exit code must be 1 on nonexistent path"
    );
    let stderr = String::from_utf8_lossy(&output_err.stderr);
    assert!(
        stderr.contains("Error: Could not locate repository"),
        "Expected error message on stderr, got: {stderr}"
    );
}

#[test]
fn test_cli_files_command() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");
    let fixture_dir = get_fixture_dir();

    // 1. Plain text files command
    let output = Command::new(prebase_bin)
        .args(["files", fixture_dir.to_str().unwrap()])
        .output()
        .expect("Failed to execute files");

    assert!(output.status.success(), "files must exit with 0");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("src/index.ts"));
    assert!(stdout.contains("src/components/Header.tsx"));
    assert!(stdout.contains("src/utils/math.ts"));

    // 2. Language filter
    let output_filter = Command::new(prebase_bin)
        .args([
            "files",
            fixture_dir.to_str().unwrap(),
            "--language",
            "typescript",
        ])
        .output()
        .expect("Failed to execute files --language typescript");

    assert!(output_filter.status.success());
    let stdout_filter = String::from_utf8_lossy(&output_filter.stdout);
    assert!(stdout_filter.contains("src/index.ts"));

    // 3. Nonexistent language filter
    let output_none = Command::new(prebase_bin)
        .args([
            "files",
            fixture_dir.to_str().unwrap(),
            "--language",
            "nonexistent_lang",
        ])
        .output()
        .expect("Failed to execute files with nonexistent language");

    assert!(output_none.status.success());
    let stdout_none = String::from_utf8_lossy(&output_none.stdout);
    assert!(stdout_none.contains("No files matched language filter"));

    // 4. JSON mode
    let output_json = Command::new(prebase_bin)
        .args(["files", fixture_dir.to_str().unwrap(), "--json"])
        .output()
        .expect("Failed to execute files --json");

    assert!(output_json.status.success());
    let json_text = String::from_utf8_lossy(&output_json.stdout);
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&json_text).expect("files --json output must be a valid JSON array");

    assert!(!arr.is_empty());
    assert!(arr.iter().any(|item| item["path"] == "src/index.ts"));
    assert!(arr.iter().any(|item| item["language"] == "typescript"));
}

#[test]
fn test_cli_search_command() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");
    let fixture_dir = get_fixture_dir();

    // 1. Text search matching files
    let output = Command::new(prebase_bin)
        .args(["search", "Header", fixture_dir.to_str().unwrap()])
        .output()
        .expect("Failed to execute search");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("src/components/Header.tsx"));

    // 2. JSON search
    let output_json = Command::new(prebase_bin)
        .args(["search", "math", fixture_dir.to_str().unwrap(), "--json"])
        .output()
        .expect("Failed to execute search --json");

    assert!(output_json.status.success());
    let json_text = String::from_utf8_lossy(&output_json.stdout);
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&json_text).expect("search --json output must be valid JSON array");

    assert!(!arr.is_empty());
    assert!(arr.iter().any(|item| item["path"] == "src/utils/math.ts"));
    assert!(arr[0]["score"].as_i64().unwrap() > 0);

    // 3. Search with no matches
    let output_nomatch = Command::new(prebase_bin)
        .args([
            "search",
            "absolutely_no_match_xyz",
            fixture_dir.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to execute search with no matches");

    assert!(output_nomatch.status.success());
    let stdout_nomatch = String::from_utf8_lossy(&output_nomatch.stdout);
    assert!(stdout_nomatch.contains("No files matched"));

    // 4. Empty query exits with code 1 and error on stderr
    let output_empty = Command::new(prebase_bin)
        .args(["search", "   ", fixture_dir.to_str().unwrap()])
        .output()
        .expect("Failed to execute empty query search");

    assert_eq!(output_empty.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output_empty.stderr);
    assert!(stderr.contains("Error: Search query cannot be empty"));
}

#[test]
fn test_cli_inspect_command() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");
    let fixture_dir = get_fixture_dir();

    // 1. Text mode inspection
    let output = Command::new(prebase_bin)
        .args(["inspect", "src/index.ts", fixture_dir.to_str().unwrap()])
        .output()
        .expect("Failed to execute inspect");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("src/index.ts"));
    assert!(stdout.contains("typescript"));
    assert!(stdout.contains("Direct Dependencies"));
    assert!(stdout.contains("src/components/Header.tsx"));

    // 2. Disambiguated by filename
    let output_fn = Command::new(prebase_bin)
        .args(["inspect", "Header.tsx", fixture_dir.to_str().unwrap()])
        .output()
        .expect("Failed to execute inspect Header.tsx");

    assert!(output_fn.status.success());
    let stdout_fn = String::from_utf8_lossy(&output_fn.stdout);
    assert!(stdout_fn.contains("src/components/Header.tsx"));

    // 3. JSON mode inspection
    let output_json = Command::new(prebase_bin)
        .args([
            "inspect",
            "src/index.ts",
            fixture_dir.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("Failed to execute inspect --json");

    assert!(output_json.status.success());
    let json_text = String::from_utf8_lossy(&output_json.stdout);
    let v: serde_json::Value =
        serde_json::from_str(&json_text).expect("inspect --json output must be valid JSON");

    assert_eq!(v["file"]["path"], "src/index.ts");
    assert_eq!(v["file"]["language"], "typescript");
    assert!(v["dependencies"].is_array());
    assert!(v["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["path"] == "src/components/Header.tsx"));

    // 4. Nonexistent file exits with code 1 and error on stderr
    let output_err = Command::new(prebase_bin)
        .args([
            "inspect",
            "nonexistent/file.ts",
            fixture_dir.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to execute inspect nonexistent");

    assert_eq!(output_err.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output_err.stderr);
    assert!(stderr.contains("Error: File 'nonexistent/file.ts' not found"));
}

#[test]
fn test_cli_deps_and_dependents_commands() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");
    let fixture_dir = get_fixture_dir();

    // 1. Direct dependencies of src/index.ts
    let output_deps = Command::new(prebase_bin)
        .args(["deps", "src/index.ts", fixture_dir.to_str().unwrap()])
        .output()
        .expect("Failed to execute deps");

    assert!(output_deps.status.success());
    let stdout_deps = String::from_utf8_lossy(&output_deps.stdout);
    assert!(stdout_deps.contains("src/components/Header.tsx"));
    assert!(stdout_deps.contains("src/utils/math.ts"));

    // 2. Transitive dependencies of src/index.ts
    let output_trans = Command::new(prebase_bin)
        .args([
            "deps",
            "src/index.ts",
            fixture_dir.to_str().unwrap(),
            "--transitive",
        ])
        .output()
        .expect("Failed to execute deps --transitive");

    assert!(output_trans.status.success());
    let stdout_trans = String::from_utf8_lossy(&output_trans.stdout);
    // Button.tsx is an indirect dependency of index.ts (via Header.tsx)
    assert!(stdout_trans.contains("src/components/Button.tsx"));

    // 3. Deps JSON mode
    let output_deps_json = Command::new(prebase_bin)
        .args([
            "deps",
            "src/index.ts",
            fixture_dir.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("Failed to execute deps --json");

    assert!(output_deps_json.status.success());
    let v_deps: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output_deps_json.stdout))
            .expect("deps --json must be valid JSON");
    assert_eq!(v_deps["target"], "src/index.ts");
    assert_eq!(v_deps["transitive"], false);
    assert!(v_deps["dependencies"].is_array());

    // 4. Dependents of Button.tsx
    let output_dependents = Command::new(prebase_bin)
        .args([
            "dependents",
            "src/components/Button.tsx",
            fixture_dir.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to execute dependents");

    assert!(output_dependents.status.success());
    let stdout_dependents = String::from_utf8_lossy(&output_dependents.stdout);
    assert!(stdout_dependents.contains("src/components/Header.tsx"));

    // 5. Transitive dependents of Button.tsx
    let output_dependents_trans = Command::new(prebase_bin)
        .args([
            "dependents",
            "src/components/Button.tsx",
            fixture_dir.to_str().unwrap(),
            "--transitive",
        ])
        .output()
        .expect("Failed to execute dependents --transitive");

    assert!(output_dependents_trans.status.success());
    let stdout_dep_trans = String::from_utf8_lossy(&output_dependents_trans.stdout);
    // index.ts is a transitive dependent of Button.tsx (calls Header.tsx -> calls Button.tsx)
    assert!(stdout_dep_trans.contains("src/index.ts"));

    // 6. Dependents JSON mode
    let output_dep_json = Command::new(prebase_bin)
        .args([
            "dependents",
            "src/components/Button.tsx",
            fixture_dir.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("Failed to execute dependents --json");

    assert!(output_dep_json.status.success());
    let v_dep: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output_dep_json.stdout))
            .expect("dependents --json must be valid JSON");
    assert_eq!(v_dep["target"], "src/components/Button.tsx");
    assert!(v_dep["dependents"].is_array());
}

#[test]
fn test_cli_path_command() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");
    let fixture_dir = get_fixture_dir();

    // 1. Text mode path
    let output = Command::new(prebase_bin)
        .args([
            "path",
            "src/index.ts",
            "src/components/Button.tsx",
            fixture_dir.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to execute path");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Dependency Path Found"));
    assert!(stdout.contains("src/index.ts"));
    assert!(stdout.contains("src/components/Header.tsx"));
    assert!(stdout.contains("src/components/Button.tsx"));

    // 2. JSON mode path
    let output_json = Command::new(prebase_bin)
        .args([
            "path",
            "src/index.ts",
            "src/components/Button.tsx",
            fixture_dir.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("Failed to execute path --json");

    assert!(output_json.status.success());
    let v: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&output_json.stdout))
        .expect("path --json must be valid JSON");

    assert_eq!(v["status"], "found");
    assert_eq!(v["path"]["hops"], 2);
    let nodes = v["path"]["nodes"].as_array().unwrap();
    assert_eq!(nodes[0], "src/index.ts");
    assert_eq!(nodes[1], "src/components/Header.tsx");
    assert_eq!(nodes[2], "src/components/Button.tsx");

    // 3. Nonexistent from-file exits with code 1
    let output_err = Command::new(prebase_bin)
        .args([
            "path",
            "nonexistent_source.ts",
            "src/components/Button.tsx",
            fixture_dir.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to execute invalid path");

    assert_eq!(output_err.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output_err.stderr);
    assert!(stderr.contains("Error: Starting file 'nonexistent_source.ts' could not be resolved."));
}

#[test]
fn test_cli_history_command() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");

    // 1. Non-git directory: must exit with code 1 and error on stderr
    let empty_temp = TempDir::new().expect("Failed to create empty temp dir");
    let output_non_git = Command::new(prebase_bin)
        .args(["history", empty_temp.path().to_str().unwrap(), "--text"])
        .output()
        .expect("Failed to execute history on non-git dir");

    assert_eq!(
        output_non_git.status.code(),
        Some(1),
        "history on non-git directory must exit with code 1"
    );
    let stderr_non_git = String::from_utf8_lossy(&output_non_git.stderr);
    assert!(
        stderr_non_git.contains("Not a git repository")
            || stderr_non_git.contains("not a Git repository"),
        "stderr must report not a Git repository, got: {stderr_non_git}"
    );

    // 2. Real git repository test using temporary git repo
    let temp_git = create_temp_git_repo();
    let temp_path = temp_git.path();

    // 2a. Text mode
    let output_git = Command::new(prebase_bin)
        .args(["history", temp_path.to_str().unwrap(), "--text"])
        .output()
        .expect("Failed to execute history --text on temp git repo");

    assert!(
        output_git.status.success(),
        "history --text must exit 0 on git repo"
    );
    let stdout_git = String::from_utf8_lossy(&output_git.stdout);
    assert!(stdout_git.contains("feat: add index.ts entrypoint"));
    assert!(stdout_git.contains("Initial commit for prebase history test"));

    // 2b. JSON mode
    let output_git_json = Command::new(prebase_bin)
        .args(["history", temp_path.to_str().unwrap(), "--json"])
        .output()
        .expect("Failed to execute history --json on temp git repo");

    assert!(output_git_json.status.success());
    let v: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output_git_json.stdout))
            .expect("history --json must be valid JSON");

    assert!(v["branch"].is_string());
    assert_eq!(v["total_commits"], 2);
    let commits = v["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 2);
    assert!(commits[0]["summary"]
        .as_str()
        .unwrap()
        .contains("feat: add index.ts entrypoint"));
    assert_eq!(commits[0]["author_name"], "Test Author");

    // 2c. Limit flag
    let output_limit = Command::new(prebase_bin)
        .args([
            "history",
            temp_path.to_str().unwrap(),
            "--json",
            "--limit",
            "1",
        ])
        .output()
        .expect("Failed to execute history --json --limit 1");

    assert!(output_limit.status.success());
    let v_lim: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output_limit.stdout))
            .expect("history limit output must be valid JSON");
    assert_eq!(v_lim["commits"].as_array().unwrap().len(), 1);
}

#[test]
fn test_cli_exit_codes_and_stdout_stderr_separation() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");

    // 1. Invalid argument syntax produces clap exit code 2
    let output_bad_flag = Command::new(prebase_bin)
        .arg("--unknown-flag-prebase-test")
        .output()
        .expect("Failed to execute prebase with bad flag");

    assert_eq!(
        output_bad_flag.status.code(),
        Some(2),
        "Clap argument parse errors must exit with code 2"
    );
    let stderr = String::from_utf8_lossy(&output_bad_flag.stderr);
    assert!(stderr.contains("unexpected argument") || stderr.contains("error:"));

    // 2. Strict stdout/stderr separation with --json
    let fixture_dir = get_fixture_dir();
    let output_json = Command::new(prebase_bin)
        .args(["analyze", fixture_dir.to_str().unwrap(), "--json"])
        .output()
        .expect("Failed to execute analyze --json");

    assert!(output_json.status.success());
    // stdout must be strictly valid JSON
    let stdout_str = String::from_utf8_lossy(&output_json.stdout);
    assert!(
        stdout_str.trim().starts_with('{') && stdout_str.trim().ends_with('}'),
        "JSON stdout must start and end with braces"
    );
    assert!(
        !stdout_str.contains("\x1b["),
        "JSON output must never contain ANSI escape codes"
    );
}

#[test]
fn test_cli_new_window_flag_accepted_across_interactive_subcommands() {
    let prebase_bin = env!("CARGO_BIN_EXE_prebase");

    // 1. Global --help documents -n / --new
    let help_out = Command::new(prebase_bin)
        .arg("--help")
        .output()
        .expect("Failed to execute prebase --help");
    assert!(help_out.status.success());
    let help_stdout = String::from_utf8_lossy(&help_out.stdout);
    assert!(
        help_stdout.contains("-n, --new"),
        "Global --help must document -n, --new flag"
    );

    // 2. -n and --new are accepted on root, map, and history subcommands
    for args in [
        vec!["-n", "map", "--help"],
        vec!["--new", "map", "--help"],
        vec!["map", "-n", "--help"],
        vec!["history", "--new", "--help"],
    ] {
        let out = Command::new(prebase_bin)
            .args(&args)
            .output()
            .expect("Failed to execute prebase with -n/--new");
        assert!(
            out.status.success(),
            "Expected {:?} to parse cleanly with -n/--new, stderr: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // 3. Conflicting -n/--new combinations must be rejected with exit code 2
    for bad_args in [
        vec!["-n", "--no-open"],
        vec!["-n", "map", "--no-open"],
        vec!["-n", "history", "--text"],
        vec!["-n", "history", "--json"],
        vec!["-n", "analyze"],
        vec!["-n", "status"],
        vec!["-n", "stop"],
    ] {
        let out = Command::new(prebase_bin)
            .args(&bad_args)
            .output()
            .expect("Failed to execute conflicting -n command");
        assert_eq!(
            out.status.code(),
            Some(2),
            "Expected {:?} to exit with code 2, got {:?}, stderr: {}",
            bad_args,
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
