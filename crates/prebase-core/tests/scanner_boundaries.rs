//! Integration tests for the repository scanner security boundary.
//!
//! These tests exercise the public `RepositoryScanner` API against real
//! filesystem fixtures (no mocks). They intentionally live outside
//! `src/` so the scanner boundary is tested through its public surface.

use prebase_core::{DiscoveredFile, FileKind, RepositoryScanner, ScannerConfig};
use std::fs;
use std::path::Path;

/// Collected/sorted relative paths, mirroring the scanner's documented
/// deterministic ordering (ascending by relative path).
fn rel_paths(files: &[DiscoveredFile]) -> Vec<String> {
    files.iter().map(|f| f.relative_path.clone()).collect()
}

fn sorted(mut paths: Vec<&str>) -> Vec<String> {
    paths.sort_unstable();
    paths.into_iter().map(str::to_string).collect()
}

fn find<'a>(files: &'a [DiscoveredFile], rel: &str) -> &'a DiscoveredFile {
    files
        .iter()
        .find(|f| f.relative_path == rel)
        .unwrap_or_else(|| panic!("expected discovered file {rel:?} in {files:#?}"))
}

fn write_fixtures(root: &Path, fixtures: &[(&str, &str)]) {
    for (rel, contents) in fixtures {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }
}

#[test]
fn discovers_regular_supported_files_and_classifies_them() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    let fixtures: &[(&str, &str)] = &[
        ("src/main.ts", "export const main = 1;\n"),
        ("src/App.tsx", "export const App = () => null;\n"),
        ("lib/util.js", "module.exports = {};\n"),
        ("script.mjs", "export default 1;\n"),
        ("Shout.TS", "export const shout = true;\n"),
        ("README.md", "# Fixture\n"),
        ("package.json", "{}\n"),
        ("styles.css", "body {}\n"),
    ];
    write_fixtures(root, fixtures);

    let scanner = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();
    let (files, excluded) = scanner.scan();

    assert_eq!(
        rel_paths(&files),
        sorted(fixtures.iter().map(|(rel, _)| *rel).collect())
    );
    assert_eq!(excluded, 0, "no fixture file should be excluded");

    // Supported TypeScript/JavaScript variants.
    for rel in [
        "src/main.ts",
        "src/App.tsx",
        "lib/util.js",
        "script.mjs",
        "Shout.TS",
    ] {
        let file = find(&files, rel);
        assert!(file.is_supported_language, "{rel} should be supported");
        assert_eq!(file.file_kind, FileKind::Source, "{rel} should be Source");
        assert_eq!(
            file.absolute_path,
            scanner.root().join(rel),
            "{rel} absolute path should be rooted at the discovered root"
        );
    }

    // Extensions are normalized to lowercase, but the filename is preserved.
    assert_eq!(find(&files, "Shout.TS").filename, "Shout.TS");
    assert_eq!(find(&files, "Shout.TS").extension, ".ts");
    assert_eq!(find(&files, "src/App.tsx").extension, ".tsx");

    // Non-source classifications.
    let readme = find(&files, "README.md");
    assert!(!readme.is_supported_language);
    assert_eq!(readme.file_kind, FileKind::Doc);

    let package = find(&files, "package.json");
    assert!(!package.is_supported_language);
    assert_eq!(package.file_kind, FileKind::Config);

    let css = find(&files, "styles.css");
    assert!(!css.is_supported_language);
    assert_eq!(css.file_kind, FileKind::Other);

    // Reported sizes match the bytes actually written.
    for (rel, contents) in fixtures {
        assert_eq!(
            find(&files, rel).size_bytes,
            contents.len() as u64,
            "size mismatch for {rel}"
        );
    }
}

#[test]
fn enforces_max_file_size_boundary_in_both_directions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    const LIMIT: u64 = 64;
    // Exactly at the limit, just under, empty, and just over.
    fs::write(root.join("at_limit.ts"), "a".repeat(LIMIT as usize)).unwrap();
    fs::write(root.join("under_limit.ts"), "b".repeat(63)).unwrap();
    fs::write(root.join("empty.ts"), "").unwrap();
    fs::write(root.join("over_limit.ts"), "c".repeat(65)).unwrap();

    let scanner = RepositoryScanner::new(
        root,
        ScannerConfig {
            max_file_size_bytes: LIMIT,
        },
    )
    .unwrap();
    let (files, excluded) = scanner.scan();

    assert_eq!(
        rel_paths(&files),
        sorted(vec!["at_limit.ts", "empty.ts", "under_limit.ts"]),
        "files at/under the limit must be included, over-limit excluded"
    );
    // Exactly one file (65 bytes) is over the boundary.
    assert_eq!(excluded, 1);

    assert_eq!(find(&files, "at_limit.ts").size_bytes, LIMIT);
    assert_eq!(find(&files, "under_limit.ts").size_bytes, 63);
    assert_eq!(find(&files, "empty.ts").size_bytes, 0);
    assert!(!rel_paths(&files).iter().any(|p| p == "over_limit.ts"));
}

#[test]
fn excludes_ignored_directories_and_secret_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    let fixtures: &[(&str, &str)] = &[
        // Excluded dependency/build/tooling directories.
        ("node_modules/pkg/index.js", "module.exports = 1;\n"),
        ("dist/bundle.js", "console.log(1);\n"),
        ("build/out.js", "console.log(1);\n"),
        ("target/debug/app.rs", "fn main() {}\n"),
        (".vscode/settings.json", "{}\n"),
        ("coverage/lcov.info", "SF:src/main.ts\n"),
        // Secret files.
        (".env", "SECRET=1\n"),
        (".env.local", "SECRET=2\n"),
        ("server.key", "key\n"),
        ("cert.pem", "pem\n"),
        ("id_rsa", "rsa\n"),
        ("credentials.json", "{}\n"),
        // Ordinary files that must survive.
        ("src/main.ts", "export const main = 1;\n"),
        ("src/normal.json", "{}\n"),
    ];
    write_fixtures(root, fixtures);

    let scanner = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();
    let (files, excluded) = scanner.scan();

    assert_eq!(
        rel_paths(&files),
        sorted(vec!["src/main.ts", "src/normal.json"])
    );
    assert_eq!(
        excluded, 12,
        "each excluded-directory member and each secret file is counted"
    );
}

#[test]
fn secret_and_ignored_directory_matching_is_case_insensitive_and_prefix_based_where_documented() {
    // This test documents the *actual* semantics of
    // `is_excluded_relative_path` and verifies the scanner applies the same
    // predicate to each filesystem entry. Matching is case-insensitive because
    // macOS/Windows filesystems are case-insensitive by default: `.ENV` names
    // the same file as `.env`, so an exact-case check would leak secrets.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    // (relative path, expected result of is_excluded_relative_path)
    let cases: &[(&str, bool)] = &[
        // Directory components are matched case-insensitively.
        ("NODE_MODULES/kept.js", true),
        // Secret checks are case-insensitive.
        (".ENV", true),
        (".Env.local", true),
        ("server.PEM", true),
        ("server.Key", true),
        ("ID_RSA", true),
        ("credentials.JSON", true),
        // `.env` prefix check is a prefix, not an equality check.
        (".envrc", true),
        (".environment", true),
        (".env.example", true),
        // Embedded-but-not-leading `.env` is allowed.
        ("my.env", false),
        // `id_rsa` uses starts_with, so suffixes are also excluded.
        ("id_rsa_backup.txt", true),
        // `credentials.json` requires an exact basename match.
        ("notes.credentials.json", false),
        ("credentials.json.backup", false),
        // Secret suffix checks must be the final suffix.
        ("cert.p12", true),
        ("archive.P12", true),
        ("store.pfx", true),
        ("vault.PFX", true),
        ("app.key.ts", false),
        ("key.pem.bak", false),
        // Nested exact basename still matches.
        ("src/credentials.json", true),
        // Bare `env` is not `.env`.
        ("env", false),
    ];
    write_fixtures(
        root,
        &cases
            .iter()
            .map(|(rel, _)| (*rel, "x\n"))
            .collect::<Vec<_>>(),
    );

    // Document actual predicate behavior explicitly.
    for (rel, expected_excluded) in cases {
        assert_eq!(
            RepositoryScanner::is_excluded_relative_path(rel),
            *expected_excluded,
            "predicate expectation wrong for {rel:?}"
        );
    }

    let scanner = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();
    let (files, excluded) = scanner.scan();
    let discovered = rel_paths(&files);

    // The scanner must apply exactly the same predicate to filesystem entries.
    let expected_included: Vec<&str> = cases
        .iter()
        .filter(|(_, is_excluded)| !*is_excluded)
        .map(|(rel, _)| *rel)
        .collect();
    assert_eq!(discovered, sorted(expected_included));

    for (rel, expected_excluded) in cases {
        assert_eq!(
            !discovered.iter().any(|p| p == rel),
            *expected_excluded,
            "scanner/predicate mismatch for {rel:?}"
        );
    }

    let expected_excluded_count = cases.iter().filter(|(_, e)| *e).count();
    assert_eq!(excluded, expected_excluded_count);
}

#[cfg(unix)]
#[test]
fn symlink_boundary_blocks_escapes_secrets_dirs_and_loops() {
    use std::os::unix::fs::symlink;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    let base = tempfile::tempdir().unwrap();
    let repo_root = base.path().join("repo");
    let outside_dir = base.path().join("outside");
    fs::create_dir_all(repo_root.join("src/components")).unwrap();
    fs::create_dir_all(&outside_dir).unwrap();

    // Legitimate real files.
    let main_ts = repo_root.join("src/main.ts");
    fs::write(&main_ts, "console.log('hello');\n").unwrap();
    fs::write(
        repo_root.join("src/components/Button.tsx"),
        "export const Button = () => null;\n",
    )
    .unwrap();

    // Secret file inside the repo.
    let secret_file = repo_root.join("src/.env");
    fs::write(&secret_file, "SECRET=1\n").unwrap();

    // File outside the repo root.
    let outside_file = outside_dir.join("private.ts");
    fs::write(&outside_file, "const classified = true;\n").unwrap();

    // Valid internal symlinks, including a multi-hop chain.
    symlink(&main_ts, repo_root.join("src/internal_link.ts")).unwrap();
    symlink(&main_ts, repo_root.join("src/hop1.ts")).unwrap();
    symlink(repo_root.join("src/hop1.ts"), repo_root.join("src/hop2.ts")).unwrap();

    // Symlink escaping the repository root.
    symlink(&outside_file, repo_root.join("src/escape.ts")).unwrap();
    // Symlink to an excluded secret file inside the repo.
    symlink(&secret_file, repo_root.join("src/secret_link.ts")).unwrap();
    // Broken symlink.
    symlink(
        repo_root.join("src/nonexistent.ts"),
        repo_root.join("src/broken.ts"),
    )
    .unwrap();
    // Symlink to a directory (inside) and to a directory (outside).
    symlink(
        repo_root.join("src/components"),
        repo_root.join("src/components_link"),
    )
    .unwrap();
    symlink(&outside_dir, repo_root.join("src/outside_dir_link")).unwrap();
    // Circular symlink loop.
    let loop_a = repo_root.join("src/loop_a.ts");
    let loop_b = repo_root.join("src/loop_b.ts");
    symlink(&loop_b, &loop_a).unwrap();
    symlink(&loop_a, &loop_b).unwrap();

    let scanner = RepositoryScanner::new(&repo_root, ScannerConfig::default()).unwrap();

    // Run the scan on a worker thread so a symlink loop can never hang the
    // whole test binary indefinitely; a hang becomes a clear failure.
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let result = scanner.scan();
        let _ = tx.send((
            result
                .0
                .iter()
                .map(|f| f.relative_path.clone())
                .collect::<Vec<_>>(),
            result.1,
        ));
    });
    let (discovered, excluded) = match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result) => result,
        Err(err) => panic!("scanner did not finish (possible symlink loop hang): {err}"),
    };
    handle.join().unwrap();

    assert_eq!(
        discovered,
        sorted(vec![
            "src/components/Button.tsx",
            "src/hop1.ts",
            "src/hop2.ts",
            "src/internal_link.ts",
            "src/main.ts",
        ]),
        "only real files and valid internal file symlinks may be discovered"
    );

    // Exactly: escaping symlink, secret symlink, broken symlink, two loop
    // members, and the secret file itself. Directory symlinks are skipped
    // before the exclusion counter is touched.
    assert_eq!(
        excluded, 6,
        "unexpected excluded entry count: {discovered:#?}"
    );
}

#[test]
fn repeated_scans_are_deterministic() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    write_fixtures(
        root,
        &[
            ("a.ts", "export const a = 1;\n"),
            ("z.ts", "export const z = 1;\n"),
            ("src/b.ts", "export const b = 1;\n"),
            ("src/deep/nested/c.tsx", "export const C = () => null;\n"),
            ("docs/readme.md", "# Docs\n"),
            ("node_modules/x.js", "module.exports = 1;\n"),
            ("dist/y.js", "console.log(1);\n"),
            (".env", "SECRET=1\n"),
        ],
    );

    let expected = sorted(vec![
        "a.ts",
        "docs/readme.md",
        "src/b.ts",
        "src/deep/nested/c.tsx",
        "z.ts",
    ]);

    let scanner = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();
    let (first, first_excluded) = scanner.scan();
    let (second, second_excluded) = scanner.scan();

    assert_eq!(rel_paths(&first), expected);
    assert_eq!(rel_paths(&first), rel_paths(&second));
    assert_eq!(first_excluded, second_excluded);
    assert_eq!(first_excluded, 3);

    // A fresh scanner over the same fixture must agree as well.
    let fresh = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();
    let (third, third_excluded) = fresh.scan();
    assert_eq!(rel_paths(&third), expected);
    assert_eq!(third_excluded, first_excluded);

    // The scanner sorts ascending by relative path.
    let mut sorted_check = rel_paths(&first);
    sorted_check.sort();
    assert_eq!(rel_paths(&first), sorted_check);
}

#[test]
fn excludes_sensitive_directories_modern_ssh_keys_and_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    // Sensitive files and directories that MUST be excluded.
    let sensitive_fixtures: &[(&str, &str)] = &[
        // Sensitive directories: .ssh, .aws, .gnupg (and case variations)
        (".ssh/id_ed25519", "openssh-key-ed25519\n"),
        (".ssh/id_rsa", "openssh-key-rsa\n"),
        (".ssh/config", "Host *\n  User test\n"),
        (".ssh/known_hosts", "github.com ssh-ed25519 AAAA...\n"),
        (
            ".aws/credentials",
            "[default]\naws_access_key_id = AKIA...\n",
        ),
        (".aws/config", "[default]\nregion = us-east-1\n"),
        (".gnupg/pubring.kbx", "gpg-pubring\n"),
        (".gnupg/secring.gpg", "gpg-secring\n"),
        (".gnupg/trustdb.gpg", "gpg-trustdb\n"),
        // Nested sensitive directories
        ("home/.ssh/id_ecdsa", "openssh-key-ecdsa\n"),
        (
            "deploy/.aws/credentials",
            "[deploy]\naws_access_key_id = AKIA...\n",
        ),
        ("keys/.gnupg/secring.gpg", "gpg-secring\n"),
        // Case-insensitive directory matching in distinct directory to prevent in-place overwrite on macOS APFS
        ("case_dir/.SSH/id_dsa", "openssh-key-dsa\n"),
        ("case_dir/.Aws/credentials", "[default]\nkey = 123\n"),
        ("case_dir/.GnuPG/pubring.kbx", "gpg-pubring\n"),
        // Modern SSH keys (root and subdirectories, with and without extensions)
        ("id_ed25519", "private-ed25519\n"),
        ("id_ed25519.pub", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5...\n"),
        ("id_ed25519_sk", "private-ed25519-sk\n"),
        ("id_ed25519_backup", "private-backup\n"),
        ("id_ecdsa", "private-ecdsa\n"),
        ("id_ecdsa.pub", "ecdsa-sha2-nistp256 AAAA...\n"),
        ("id_ecdsa_sk.pub", "sk-ecdsa-sha2-nistp256 AAAA...\n"),
        ("id_dsa", "private-dsa\n"),
        ("id_dsa.pub", "ssh-dss AAAA...\n"),
        ("identity", "ssh-v1-identity\n"),
        ("identity.pub", "ssh-v1-identity-pub\n"),
        ("secrets/id_ed25519", "nested-ed25519\n"),
        ("secrets/id_ecdsa", "nested-ecdsa\n"),
        ("secrets/id_dsa", "nested-dsa\n"),
        ("secrets/identity", "nested-identity\n"),
        // Case-insensitive file matching in distinct directory to prevent in-place overwrite on macOS APFS
        ("case_files/ID_ED25519", "case-ed25519\n"),
        ("case_files/Id_Ecdsa", "case-ecdsa\n"),
        ("case_files/ID_DSA", "case-dsa\n"),
        ("case_files/IDENTITY", "case-identity\n"),
        // Credential files
        ("credentials", "[default]\nsecret=123\n"),
        ("credentials.json", "{\"apiKey\": \"123\"}\n"),
        ("config/credentials", "secret_key=xyz\n"),
        ("config/credentials.json", "{\"token\": \"xyz\"}\n"),
        ("case_files/CREDENTIALS", "secret\n"),
        ("case_files/Credentials.JSON", "{\"token\": \"xyz\"}\n"),
        // Netrc files
        (".netrc", "machine example.com login user password secret\n"),
        (
            "home/.netrc",
            "machine test.com login user password secret\n",
        ),
        (
            "case_files/.NETRC",
            "machine upper.com login user password secret\n",
        ),
    ];
    write_fixtures(root, sensitive_fixtures);

    // Legitimate files that MUST be preserved and discovered.
    let legitimate_fixtures: &[(&str, &str)] = &[
        ("src/main.ts", "export const main = 1;\n"),
        (
            "src/identity_service.ts",
            "export class IdentityService {}\n",
        ),
        (
            "src/credentials_provider.ts",
            "export class CredentialsProvider {}\n",
        ),
        (
            "src/components/AwsIcon.tsx",
            "export const AwsIcon = () => null;\n",
        ),
        (
            "src/ssh_client.ts",
            "export const connectSsh = () => null;\n",
        ),
        (
            "src/netrc_parser.ts",
            "export const parseNetrc = () => ({});\n",
        ),
        ("docs/setup.md", "# Setup Guide\n"),
        ("package.json", "{\"name\": \"test-app\"}\n"),
    ];
    write_fixtures(root, legitimate_fixtures);

    // Verify predicate behavior directly
    for (rel, _) in sensitive_fixtures {
        assert!(
            RepositoryScanner::is_excluded_relative_path(rel),
            "expected sensitive path {rel:?} to be excluded by predicate"
        );
    }
    for (rel, _) in legitimate_fixtures {
        assert!(
            !RepositoryScanner::is_excluded_relative_path(rel),
            "legitimate path {rel:?} must NOT be excluded by predicate"
        );
    }

    let scanner = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();
    let (files, excluded) = scanner.scan();
    let discovered = rel_paths(&files);

    let expected_included = sorted(legitimate_fixtures.iter().map(|(rel, _)| *rel).collect());
    assert_eq!(
        discovered, expected_included,
        "scanner must discover all legitimate files and strictly exclude all sensitive files"
    );

    // None of the sensitive files must appear in discovered files
    for (rel, _) in sensitive_fixtures {
        assert!(
            !discovered.contains(&rel.to_string()),
            "sensitive file {rel:?} was discovered but must be excluded"
        );
    }

    assert_eq!(
        excluded,
        sensitive_fixtures.len(),
        "excluded count should match exact count of sensitive fixtures"
    );
}

#[cfg(unix)]
#[test]
fn symlinks_to_sensitive_targets_are_excluded() {
    use std::os::unix::fs::symlink;

    let base = tempfile::tempdir().unwrap();
    let repo_root = base.path().join("repo");
    let outside_dir = base.path().join("outside");
    fs::create_dir_all(repo_root.join("src")).unwrap();
    fs::create_dir_all(repo_root.join(".ssh")).unwrap();
    fs::create_dir_all(repo_root.join(".aws")).unwrap();
    fs::create_dir_all(repo_root.join(".gnupg")).unwrap();
    fs::create_dir_all(outside_dir.join(".ssh")).unwrap();
    fs::create_dir_all(outside_dir.join(".aws")).unwrap();

    // 1. Legitimate file & valid internal symlink
    let main_ts = repo_root.join("src/main.ts");
    fs::write(&main_ts, "export const main = 1;\n").unwrap();
    symlink(&main_ts, repo_root.join("src/main_link.ts")).unwrap();

    // 2. Sensitive files inside repository
    let ssh_key = repo_root.join(".ssh/id_ed25519");
    fs::write(&ssh_key, "private-key-content\n").unwrap();

    let aws_cred = repo_root.join(".aws/credentials");
    fs::write(&aws_cred, "aws_secret_access_key = xxx\n").unwrap();

    let gnupg_key = repo_root.join(".gnupg/secring.gpg");
    fs::write(&gnupg_key, "gpg-secret\n").unwrap();

    let id_ecdsa = repo_root.join("src/id_ecdsa");
    fs::write(&id_ecdsa, "ecdsa-secret\n").unwrap();

    let id_dsa = repo_root.join("src/id_dsa");
    fs::write(&id_dsa, "dsa-secret\n").unwrap();

    let identity = repo_root.join("src/identity");
    fs::write(&identity, "identity-secret\n").unwrap();

    let netrc = repo_root.join("src/.netrc");
    fs::write(&netrc, "machine x login y password z\n").unwrap();

    let credentials = repo_root.join("src/credentials");
    fs::write(&credentials, "credentials-secret\n").unwrap();

    let credentials_json = repo_root.join("src/credentials.json");
    fs::write(&credentials_json, "{\"token\": \"xyz\"}\n").unwrap();

    // 3. Sensitive files outside repository
    let outside_ssh = outside_dir.join(".ssh/id_ed25519");
    fs::write(&outside_ssh, "outside-ssh-key\n").unwrap();

    let outside_aws = outside_dir.join(".aws/credentials");
    fs::write(&outside_aws, "outside-aws-cred\n").unwrap();

    let outside_netrc = outside_dir.join(".netrc");
    fs::write(&outside_netrc, "outside-netrc\n").unwrap();

    // 4. Internal symlinks pointing to sensitive directory targets
    symlink(repo_root.join(".ssh"), repo_root.join("src/link_dot_ssh")).unwrap();
    symlink(repo_root.join(".aws"), repo_root.join("src/link_dot_aws")).unwrap();
    symlink(
        repo_root.join(".gnupg"),
        repo_root.join("src/link_dot_gnupg"),
    )
    .unwrap();

    // 5. Internal symlinks pointing to sensitive file targets
    symlink(&ssh_key, repo_root.join("src/link_ssh_key.ts")).unwrap();
    symlink(&aws_cred, repo_root.join("src/link_aws_cred.ts")).unwrap();
    symlink(&gnupg_key, repo_root.join("src/link_gnupg_key.ts")).unwrap();
    symlink(&id_ecdsa, repo_root.join("src/link_id_ecdsa.ts")).unwrap();
    symlink(&id_dsa, repo_root.join("src/link_id_dsa.ts")).unwrap();
    symlink(&identity, repo_root.join("src/link_identity.ts")).unwrap();
    symlink(&netrc, repo_root.join("src/link_netrc.ts")).unwrap();
    symlink(&credentials, repo_root.join("src/link_credentials.ts")).unwrap();
    symlink(
        &credentials_json,
        repo_root.join("src/link_credentials_json.ts"),
    )
    .unwrap();

    // 6. Symlinks escaping repo to external sensitive targets
    symlink(&outside_ssh, repo_root.join("src/escape_ssh.ts")).unwrap();
    symlink(&outside_aws, repo_root.join("src/escape_aws.ts")).unwrap();
    symlink(&outside_netrc, repo_root.join("src/escape_netrc.ts")).unwrap();

    let scanner = RepositoryScanner::new(&repo_root, ScannerConfig::default()).unwrap();
    let (files, excluded) = scanner.scan();
    let discovered = rel_paths(&files);

    // Only legitimate files and legitimate internal symlinks can be discovered
    assert_eq!(
        discovered,
        sorted(vec!["src/main.ts", "src/main_link.ts"]),
        "only legitimate source files and safe internal symlinks must be discovered"
    );

    // Symlinks to sensitive targets must NEVER be discovered
    assert!(!discovered.contains(&"src/link_ssh_key.ts".to_string()));
    assert!(!discovered.contains(&"src/link_aws_cred.ts".to_string()));
    assert!(!discovered.contains(&"src/link_gnupg_key.ts".to_string()));
    assert!(!discovered.contains(&"src/link_id_ecdsa.ts".to_string()));
    assert!(!discovered.contains(&"src/link_id_dsa.ts".to_string()));
    assert!(!discovered.contains(&"src/link_identity.ts".to_string()));
    assert!(!discovered.contains(&"src/link_netrc.ts".to_string()));
    assert!(!discovered.contains(&"src/link_credentials.ts".to_string()));
    assert!(!discovered.contains(&"src/link_credentials_json.ts".to_string()));
    assert!(!discovered.contains(&"src/link_dot_ssh".to_string()));
    assert!(!discovered.contains(&"src/link_dot_aws".to_string()));
    assert!(!discovered.contains(&"src/link_dot_gnupg".to_string()));
    assert!(!discovered.contains(&"src/escape_ssh.ts".to_string()));
    assert!(!discovered.contains(&"src/escape_aws.ts".to_string()));
    assert!(!discovered.contains(&"src/escape_netrc.ts".to_string()));

    // Verify all sensitive items and symlinks pointing to them are counted as excluded
    assert!(
        excluded >= 18,
        "expected at least 18 excluded sensitive entries and symlinks, got {excluded}"
    );
}

#[cfg(unix)]
#[test]
fn scanner_reports_traversal_errors_for_unreadable_directories() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    // 1. Legitimate readable file
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(src_dir.join("main.ts"), "export const main = 1;\n").unwrap();

    // 2. Unreadable directory (0o000)
    let restricted_dir = root.join("restricted");
    fs::create_dir_all(&restricted_dir).unwrap();
    fs::write(
        restricted_dir.join("secret.ts"),
        "export const secret = 42;\n",
    )
    .unwrap();
    fs::set_permissions(&restricted_dir, fs::Permissions::from_mode(0o000)).unwrap();

    // Ensure permissions are restored at test completion so tempdir cleanup succeeds
    struct PermGuard<'a>(&'a Path);
    impl<'a> Drop for PermGuard<'a> {
        fn drop(&mut self) {
            let _ = fs::set_permissions(self.0, fs::Permissions::from_mode(0o755));
        }
    }
    let _guard = PermGuard(&restricted_dir);

    let scanner = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();
    let scan_output = scanner.scan_with_cancellation(|| false);

    // Assert readable files are still discovered resiliently
    assert!(
        scan_output
            .discovered
            .iter()
            .any(|f| f.relative_path == "src/main.ts"),
        "readable files must still be discovered"
    );

    // Assert traversal error was recorded in traversal_errors
    assert!(
        !scan_output.traversal_errors.is_empty(),
        "scanner must capture traversal errors for unreadable directory"
    );
    assert!(
        scan_output.traversal_errors.iter().any(|d| {
            d.to_lowercase().contains("permission denied") || d.contains("restricted")
        }),
        "diagnostic message must identify the restricted directory: {:?}",
        scan_output.traversal_errors
    );
}

#[test]
fn scanner_cooperative_cancellation_aborts_early() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let fixtures = &[
        ("a.ts", "export const a = 1;\n"),
        ("b.ts", "export const b = 2;\n"),
        ("c.ts", "export const c = 3;\n"),
    ];
    write_fixtures(root, fixtures);

    let scanner = RepositoryScanner::new(root, ScannerConfig::default()).unwrap();

    // 1. Pre-cancelled scan returns empty discovered files immediately without panicking
    let res_pre = scanner.scan_with_cancellation(|| true);
    assert_eq!(
        res_pre.discovered.len(),
        0,
        "scan_with_cancellation must abort immediately when pre-cancelled"
    );

    // 2. Uncancelled scan succeeds
    let res_ok = scanner.scan_with_cancellation(|| false);
    assert_eq!(res_ok.discovered.len(), 3);
}
