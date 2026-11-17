use prebase_core::{safe_read_file_to_string, SafeReadError};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tempfile::tempdir;

#[test]
fn test_safe_read_rejects_external_symlinks_relative_and_absolute() {
    let temp_base = tempdir().expect("failed to create temp base");
    let base_path = temp_base.path().canonicalize().unwrap();

    let repo_root = base_path.join("repo");
    let outside_root = base_path.join("outside");
    fs::create_dir_all(&repo_root).unwrap();
    fs::create_dir_all(&outside_root).unwrap();

    let outside_secret = outside_root.join("secret.env");
    fs::write(&outside_secret, "DATABASE_PASSWORD=supersecret\n").unwrap();

    // 1. Direct absolute symlink to outside file
    #[cfg(unix)]
    {
        let abs_link = repo_root.join("abs_link.ts");
        std::os::unix::fs::symlink(&outside_secret, &abs_link).unwrap();

        let res = safe_read_file_to_string(&repo_root, "abs_link.ts", 1024);
        assert!(
            matches!(res, Err(SafeReadError::EscapesRoot(_))),
            "Direct absolute symlink to outside file must fail with EscapesRoot, got: {res:?}"
        );
    }

    // 2. Relative symlink traversing outside repository root (e.g. ../../outside)
    #[cfg(unix)]
    {
        let sub_dir = repo_root.join("src/nested");
        fs::create_dir_all(&sub_dir).unwrap();
        let rel_link = sub_dir.join("rel_link.ts");

        // From repo/src/nested -> ../../../outside/secret.env
        let rel_target = std::path::Path::new("../../../outside/secret.env");
        std::os::unix::fs::symlink(rel_target, &rel_link).unwrap();

        let res = safe_read_file_to_string(&repo_root, "src/nested/rel_link.ts", 1024);
        assert!(
            matches!(res, Err(SafeReadError::EscapesRoot(_))),
            "Relative symlink traversing out of repo must fail with EscapesRoot, got: {res:?}"
        );
    }

    // 3. Directory symlink escaping repository root (e.g. repo/ext_dir -> outside_root)
    #[cfg(unix)]
    {
        let dir_link = repo_root.join("ext_dir");
        std::os::unix::fs::symlink(&outside_root, &dir_link).unwrap();

        let res = safe_read_file_to_string(&repo_root, "ext_dir/secret.env", 1024);
        assert!(
            matches!(
                res,
                Err(SafeReadError::EscapesRoot(_)) | Err(SafeReadError::Forbidden(_))
            ),
            "Reading through directory symlink escaping repo root must fail closed, got: {res:?}"
        );
    }

    // 4. Broken symlink pointing to nonexistent outside target
    #[cfg(unix)]
    {
        let broken_link = repo_root.join("broken_link.ts");
        let nonexistent = outside_root.join("nonexistent.ts");
        std::os::unix::fs::symlink(&nonexistent, &broken_link).unwrap();

        let res = safe_read_file_to_string(&repo_root, "broken_link.ts", 1024);
        assert!(
            matches!(
                res,
                Err(SafeReadError::NotFound(_)) | Err(SafeReadError::EscapesRoot(_))
            ),
            "Broken symlink pointing outside repo must fail closed, got: {res:?}"
        );
    }

    // 5. Circular symlink (symlink loop)
    #[cfg(unix)]
    {
        let loop_a = repo_root.join("loop_a.ts");
        let loop_b = repo_root.join("loop_b.ts");
        std::os::unix::fs::symlink(&loop_b, &loop_a).unwrap();
        std::os::unix::fs::symlink(&loop_a, &loop_b).unwrap();

        let res = safe_read_file_to_string(&repo_root, "loop_a.ts", 1024);
        assert!(res.is_err(), "Symlink loop must fail closed, got: {res:?}");
    }
}

/// Verifies that symlinks pointing to sensitive/excluded files within the repository fail closed.
#[test]
fn test_safe_read_rejects_symlinks_to_sensitive_files() {
    let repo_dir = tempdir().expect("failed to create repo tempdir");
    let repo_root = repo_dir.path().canonicalize().unwrap();

    let env_file = repo_root.join(".env");
    fs::write(&env_file, "AWS_SECRET_KEY=AKIAIOSFODNN7EXAMPLE\n").unwrap();

    #[cfg(unix)]
    {
        let link_file = repo_root.join("innocent_looking.ts");
        std::os::unix::fs::symlink(&env_file, &link_file).unwrap();

        let res = safe_read_file_to_string(&repo_root, "innocent_looking.ts", 1024);
        assert!(
            matches!(res, Err(SafeReadError::Forbidden(_))),
            "Symlink to internal .env file must be rejected with Forbidden, got: {res:?}"
        );
    }
}

/// Tests TOCTOU / file substitution mitigation:
/// A concurrent thread rapidly flips a symlink target between a valid repository file
/// and a secret file outside the repository.
///
/// Under NO circumstances should `safe_read_file_to_string` EVER return the contents
/// of the external secret file. It must either return the valid internal content or fail closed.
#[cfg(unix)]
#[test]
fn test_safe_read_toctou_symlink_substitution_mitigation() {
    let repo_dir = tempdir().expect("failed to create repo tempdir");
    let outside_dir = tempdir().expect("failed to create outside tempdir");

    let repo_root = repo_dir.path().canonicalize().unwrap();
    let outside_root = outside_dir.path().canonicalize().unwrap();

    let valid_internal = repo_root.join("valid.ts");
    let valid_content = "export const safe = true;\n";
    fs::write(&valid_internal, valid_content).unwrap();

    let outside_secret = outside_root.join("secret.txt");
    let secret_content = "FORBIDDEN_EXT_SECRET_LEAK_1234567890\n";
    fs::write(&outside_secret, secret_content).unwrap();

    let target_link = repo_root.join("racing_target.ts");
    // Initially link to valid_internal
    std::os::unix::fs::symlink(&valid_internal, &target_link).unwrap();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_clone = stop_flag.clone();
    let link_path = target_link.clone();
    let valid_path = valid_internal.clone();
    let secret_path = outside_secret.clone();

    // Background thread rapidly swaps symlink target using atomic symlink replacement via rename
    let swapper = thread::spawn(move || {
        let temp_link = link_path.with_extension("tmp");
        let mut toggle = false;
        while !stop_clone.load(Ordering::Relaxed) {
            let target = if toggle { &valid_path } else { &secret_path };
            let _ = fs::remove_file(&temp_link);
            if std::os::unix::fs::symlink(target, &temp_link).is_ok() {
                let _ = fs::rename(&temp_link, &link_path);
            }
            toggle = !toggle;
            thread::yield_now();
        }
        let _ = fs::remove_file(&temp_link);
    });

    let mut leak_count = 0;
    let mut safe_reads = 0;
    let mut blocked_reads = 0;

    for _ in 0..500 {
        match safe_read_file_to_string(&repo_root, "racing_target.ts", 1024) {
            Ok(content) => {
                if content.contains("FORBIDDEN_EXT_SECRET") {
                    leak_count += 1;
                } else if content == valid_content {
                    safe_reads += 1;
                }
            }
            Err(_) => {
                blocked_reads += 1;
            }
        }
    }

    stop_flag.store(true, Ordering::Relaxed);
    let _ = swapper.join();

    assert_eq!(
        leak_count, 0,
        "CRITICAL SECURITY FAILURE: safe_read_file_to_string leaked external secret content during TOCTOU race!"
    );
    assert!(
        safe_reads + blocked_reads > 0,
        "Expected at least some operations to succeed or fail cleanly"
    );
}

/// Verifies file identity check prevents swapped object attacks:
/// Even if a path resolves inside the repository root, if the file object identity
/// (device/inode on Unix) of the open file descriptor does not match the file at the
/// path on disk (simulating an in-place swap after opening), the reader must fail closed.
#[cfg(unix)]
#[test]
fn test_safe_read_file_identity_check_detects_swapped_file() {
    use prebase_core::{validate_descriptor_identity, SafeReadError};
    use std::os::unix::fs::MetadataExt;

    let repo_dir = tempdir().expect("failed to create repo tempdir");
    let repo_root = repo_dir.path().canonicalize().unwrap();

    let file_a = repo_root.join("object_a.ts");
    let file_b = repo_root.join("object_b.ts");

    fs::write(&file_a, "content of object A\n").unwrap();
    fs::write(&file_b, "content of object B\n").unwrap();

    let meta_a = fs::metadata(&file_a).unwrap();
    let meta_b = fs::metadata(&file_b).unwrap();

    // Verify file_a and file_b have distinct inodes
    assert_ne!(
        meta_a.ino(),
        meta_b.ino(),
        "Fixtures file_a and file_b must have distinct inodes"
    );

    // 1. Open descriptor to file_a
    let open_fd = fs::File::open(&file_a).expect("file_a must open");

    // 2. Validate descriptor identity matches disk before swap
    assert!(
        validate_descriptor_identity(&open_fd, &file_a).is_ok(),
        "Descriptor identity must match path on disk before swap"
    );

    // 3. Perform atomic in-place file replacement: rename file_b onto file_a.
    // The open_fd descriptor still points to original file A's inode,
    // but the filesystem directory entry at file_a now points to file B's inode!
    fs::rename(&file_b, &file_a).expect("atomic rename must succeed");

    // 4. Validate descriptor identity MUST now detect the identity mismatch and fail closed!
    let swap_result = validate_descriptor_identity(&open_fd, &file_a);
    assert!(
        matches!(swap_result, Err(SafeReadError::ContainmentFailed(_))),
        "validate_descriptor_identity must reject swapped file with ContainmentFailed, got {swap_result:?}"
    );

    // 5. Test symlink replacement detection:
    // Create a symlink to file_a and verify validate_descriptor_identity rejects it as EscapesRoot
    let link_path = repo_root.join("symlink_to_a.ts");
    std::os::unix::fs::symlink(&file_a, &link_path).unwrap();
    let sym_result = validate_descriptor_identity(&open_fd, &link_path);
    assert!(
        matches!(sym_result, Err(SafeReadError::EscapesRoot(_))),
        "validate_descriptor_identity must reject symlink path with EscapesRoot, got {sym_result:?}"
    );
}

/// Verifies that chained symlinks (A -> B -> C -> /outside/secret) and broken symlink chains fail closed.
#[test]
fn test_safe_read_rejects_symlink_chains_escaping_root() {
    let temp_base = tempdir().expect("failed to create temp base");
    let base_path = temp_base.path().canonicalize().unwrap();

    let repo_root = base_path.join("repo");
    let outside_root = base_path.join("outside");
    fs::create_dir_all(&repo_root).unwrap();
    fs::create_dir_all(&outside_root).unwrap();

    let outside_secret = outside_root.join("secret.txt");
    fs::write(&outside_secret, "OUTSIDE_CHAIN_SECRET\n").unwrap();

    #[cfg(unix)]
    {
        // Chain: hop1.ts -> hop2.ts -> outside_secret
        let hop2 = repo_root.join("hop2.ts");
        let hop1 = repo_root.join("hop1.ts");

        std::os::unix::fs::symlink(&outside_secret, &hop2).unwrap();
        std::os::unix::fs::symlink(&hop2, &hop1).unwrap();

        let res = safe_read_file_to_string(&repo_root, "hop1.ts", 1024);
        assert!(
            matches!(res, Err(SafeReadError::EscapesRoot(_))),
            "Chained symlink escaping repo root must fail with EscapesRoot, got: {res:?}"
        );

        // Broken chain: hop_broken_1 -> hop_broken_2 -> nonexistent
        let hop_broken_2 = repo_root.join("hop_broken_2.ts");
        let hop_broken_1 = repo_root.join("hop_broken_1.ts");
        std::os::unix::fs::symlink(outside_root.join("nonexistent_file"), &hop_broken_2).unwrap();
        std::os::unix::fs::symlink(&hop_broken_2, &hop_broken_1).unwrap();

        let res_broken = safe_read_file_to_string(&repo_root, "hop_broken_1.ts", 1024);
        assert!(
            matches!(
                res_broken,
                Err(SafeReadError::NotFound(_)) | Err(SafeReadError::EscapesRoot(_))
            ),
            "Broken symlink chain must fail closed, got: {res_broken:?}"
        );
    }
}

/// Tests TOCTOU race where a file is rapidly swapped between an allowed file and an internal secret file (.env).
/// Under no circumstances should `safe_read_file_to_string` leak the secret file content.
#[cfg(unix)]
#[test]
fn test_safe_read_toctou_internal_sensitive_substitution_mitigation() {
    let repo_dir = tempdir().expect("failed to create repo tempdir");
    let repo_root = repo_dir.path().canonicalize().unwrap();

    let valid_internal = repo_root.join("valid.ts");
    let valid_content = "export const public = true;\n";
    fs::write(&valid_internal, valid_content).unwrap();

    let secret_env = repo_root.join(".env");
    let secret_content = "INTERNAL_SECRET_TOKEN=xyz987654321\n";
    fs::write(&secret_env, secret_content).unwrap();

    let target_link = repo_root.join("racing_internal.ts");
    std::os::unix::fs::symlink(&valid_internal, &target_link).unwrap();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_clone = stop_flag.clone();
    let link_path = target_link.clone();
    let valid_path = valid_internal.clone();
    let secret_path = secret_env.clone();

    let swapper = thread::spawn(move || {
        let temp_link = link_path.with_extension("tmp");
        let mut toggle = false;
        while !stop_clone.load(Ordering::Relaxed) {
            let target = if toggle { &valid_path } else { &secret_path };
            let _ = fs::remove_file(&temp_link);
            if std::os::unix::fs::symlink(target, &temp_link).is_ok() {
                let _ = fs::rename(&temp_link, &link_path);
            }
            toggle = !toggle;
            thread::yield_now();
        }
        let _ = fs::remove_file(&temp_link);
    });

    let mut leak_count = 0;
    for _ in 0..500 {
        if let Ok(content) = safe_read_file_to_string(&repo_root, "racing_internal.ts", 1024) {
            if content.contains("INTERNAL_SECRET_TOKEN") {
                leak_count += 1;
            }
        }
    }

    stop_flag.store(true, Ordering::Relaxed);
    let _ = swapper.join();

    assert_eq!(
        leak_count, 0,
        "CRITICAL SECURITY FAILURE: safe_read_file_to_string leaked internal .env secret content during TOCTOU race!"
    );
}
