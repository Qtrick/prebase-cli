#!/usr/bin/env python3
"""
PreBase CLI — Comprehensive Installation & Symlink Verification Suite

Verifies:
1. Copied installation (--install) to user bin directory.
2. Development symlink (--link) to release binary.
3. Rebuilds and re-linking updating/refreshing the symlink safely.
4. PATH missing detection and actionable shell configuration guidance (.zshrc, .bashrc).
5. PATH shadowing detection when another executable takes precedence.
6. Custom --bin-dir <DIR> (exact destination) and --prefix <PREFIX> (destination in <PREFIX>/bin).
7. Invoking 'prebase' by bare command name in isolated temporary HOME/PATH subprocesses.
"""

import os
import sys
import stat
import shutil
import tempfile
import subprocess
import re

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INSTALL_SH = os.path.join(ROOT_DIR, "scripts", "install.sh")
BUILD_SH = os.path.join(ROOT_DIR, "scripts", "build.sh")
RELEASE_BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")

def mask_credentials(text: str) -> str:
    if not text:
        return text
    text = re.sub(r'bootstrap=[A-Za-z0-9_-]+', 'bootstrap=[REDACTED]', text)
    text = re.sub(r'prebase_session(?:_\d+)?=[A-Za-z0-9_-]+', 'prebase_session=[REDACTED]', text)
    return text

def sanitized_excepthook(exc_type, exc_value, exc_traceback):
    import traceback
    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    sys.stderr.write(mask_credentials(tb_str))

sys.excepthook = sanitized_excepthook

def log(msg):
    print(f"\x1b[36m[INSTALL VERIFY]\x1b[0m {mask_credentials(str(msg))}", flush=True)

def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {mask_credentials(str(msg))}", flush=True)

def fail(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {mask_credentials(str(msg))}", file=sys.stderr, flush=True)
    sys.exit(1)

def get_base_system_path():
    """
    Returns a clean base PATH containing standard system binaries and tools
    (cargo, npm, node, git, bash, sh) but excluding any user ~/.local/bin or existing prebase.
    """
    existing_paths = os.environ.get("PATH", "").split(os.pathsep)
    clean = []
    user_local_bin = os.path.expanduser("~/.local/bin")
    for p in existing_paths:
        p_norm = os.path.normpath(p)
        if p_norm == user_local_bin:
            continue
        if "prebase" in p_norm and os.path.join(ROOT_DIR, "target") in p_norm:
            continue
        if p_norm and p_norm not in clean:
            clean.append(p_norm)
    return os.pathsep.join(clean)

def make_isolated_env(temp_home: str, bin_dir: str = None, include_bin_in_path: bool = True, shadow_bin_dir: str = None):
    base_path = get_base_system_path()
    path_components = []
    if shadow_bin_dir:
        path_components.append(shadow_bin_dir)
    if include_bin_in_path and bin_dir:
        path_components.append(bin_dir)
    path_components.append(base_path)

    env = os.environ.copy()
    env["HOME"] = temp_home
    env["PATH"] = os.pathsep.join(path_components)
    env.pop("PREBASE_PREFIX", None)
    # Preserve cargo/rustup caches so test subprocesses reuse pre-built toolchains
    env["CARGO_HOME"] = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))
    env["RUSTUP_HOME"] = os.environ.get("RUSTUP_HOME", os.path.expanduser("~/.rustup"))
    return env

def test_copied_installation():
    log("Testing copied installation (--install)...")
    with tempfile.TemporaryDirectory(prefix="pb_test_home_install_") as temp_home:
        dest_bin = os.path.join(temp_home, ".local", "bin")
        env = make_isolated_env(temp_home, bin_dir=dest_bin, include_bin_in_path=True)

        res = subprocess.run(
            [INSTALL_SH, "--install", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res.returncode != 0:
            fail(f"install.sh --install failed (exit {res.returncode}):\n{res.stderr}\n{res.stdout}")

        installed_file = os.path.join(dest_bin, "prebase")
        if not os.path.exists(installed_file):
            fail(f"Installed executable not found at {installed_file}")

        if os.path.islink(installed_file):
            fail(f"Expected copied regular executable, but found symlink at {installed_file}")

        mode = os.stat(installed_file).st_mode
        if not (mode & stat.S_IXUSR):
            fail(f"Installed file {installed_file} is not executable by user (mode: {oct(mode)})")

        # Invoke bare command name in isolated env
        res_bare = subprocess.run(
            ["prebase", "--version"],
            env=env,
            cwd=temp_home,
            capture_output=True,
            text=True
        )
        if res_bare.returncode != 0 or "prebase" not in res_bare.stdout:
            fail(f"Bare command invocation 'prebase --version' failed: {res_bare.stderr}")

        success(f"Copied installation verified: regular executable installed at {installed_file} and invokable as bare 'prebase'.")

def test_development_symlink():
    log("Testing development symlink (--link)...")
    with tempfile.TemporaryDirectory(prefix="pb_test_home_link_") as temp_home:
        dest_bin = os.path.join(temp_home, ".local", "bin")
        env = make_isolated_env(temp_home, bin_dir=dest_bin, include_bin_in_path=True)

        res = subprocess.run(
            [INSTALL_SH, "--link", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res.returncode != 0:
            fail(f"install.sh --link failed (exit {res.returncode}):\n{res.stderr}\n{res.stdout}")

        installed_file = os.path.join(dest_bin, "prebase")
        if not os.path.exists(installed_file):
            fail(f"Symlinked executable not found at {installed_file}")

        if not os.path.islink(installed_file):
            fail(f"Expected symbolic link at {installed_file}, but found regular file")

        link_target = os.readlink(installed_file)
        canonical_target = os.path.realpath(installed_file)
        canonical_release = os.path.realpath(RELEASE_BIN)

        if canonical_target != canonical_release:
            fail(f"Symlink points to {link_target} (resolves {canonical_target}), expected {canonical_release}")

        # Invoke bare command name in isolated env
        res_bare = subprocess.run(
            ["prebase", "--version"],
            env=env,
            cwd=temp_home,
            capture_output=True,
            text=True
        )
        if res_bare.returncode != 0 or "prebase" not in res_bare.stdout:
            fail(f"Bare command invocation 'prebase --version' via symlink failed: {res_bare.stderr}")

        success(f"Development symlink verified: symlink at {installed_file} -> {link_target} invokable as bare 'prebase'.")

def test_rebuild_updating_symlink():
    log("Testing rebuilds updating/refreshing the symlink safely...")
    with tempfile.TemporaryDirectory(prefix="pb_test_home_refresh_") as temp_home:
        dest_bin = os.path.join(temp_home, ".local", "bin")
        os.makedirs(dest_bin, exist_ok=True)
        installed_file = os.path.join(dest_bin, "prebase")

        # 1. Start with a broken or stale symlink
        os.symlink("/nonexistent/target/path/prebase", installed_file)
        assert os.path.islink(installed_file)

        env = make_isolated_env(temp_home, bin_dir=dest_bin, include_bin_in_path=True)

        res = subprocess.run(
            [INSTALL_SH, "--link", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res.returncode != 0:
            fail(f"Updating stale symlink failed:\n{res.stderr}\n{res.stdout}")

        if not os.path.islink(installed_file) or not os.path.exists(installed_file):
            fail("Expected valid symlink after update of stale symlink")

        canonical_target = os.path.realpath(installed_file)
        if canonical_target != os.path.realpath(RELEASE_BIN):
            fail(f"Symlink resolved to unexpected target: {canonical_target}")

        # 2. Transition from symlink to copied install (--install)
        res_install = subprocess.run(
            [INSTALL_SH, "--install", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_install.returncode != 0:
            fail(f"Overwriting symlink with --install failed:\n{res_install.stderr}\n{res_install.stdout}")
        if os.path.islink(installed_file):
            fail("Expected regular copied file after --install, but still found symlink")

        # 3. Transition from copied file back to symlink (--link)
        res_relink = subprocess.run(
            [INSTALL_SH, "--link", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_relink.returncode != 0:
            fail(f"Overwriting regular file with --link failed:\n{res_relink.stderr}\n{res_relink.stdout}")
        if not os.path.islink(installed_file):
            fail("Expected symlink after --link over existing regular file")

        # 4. Idempotent re-run of --link
        res_idempotent = subprocess.run(
            [INSTALL_SH, "--link", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_idempotent.returncode != 0:
            fail(f"Idempotent --link failed:\n{res_idempotent.stderr}")

        # Final bare command verification
        res_bare = subprocess.run(["prebase", "--version"], env=env, cwd=temp_home, capture_output=True, text=True)
        if res_bare.returncode != 0:
            fail(f"Bare invocation failed after symlink update: {res_bare.stderr}")

        success("Rebuild and symlink updates verified (stale repair, copied->link, link->copied transitions).")

def test_path_missing_detection():
    log("Testing PATH missing detection and actionable shell configuration guidance...")
    with tempfile.TemporaryDirectory(prefix="pb_test_home_path_missing_") as temp_home:
        dest_bin = os.path.join(temp_home, ".local", "bin")
        # Ensure dest_bin is strictly excluded from PATH
        env = make_isolated_env(temp_home, bin_dir=dest_bin, include_bin_in_path=False)

        res = subprocess.run(
            [INSTALL_SH, "--install", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res.returncode != 0:
            fail(f"install.sh failed under missing PATH:\n{res.stderr}\n{res.stdout}")

        combined_output = res.stdout + "\n" + res.stderr
        output_lower = combined_output.lower()

        # Must report that destination is not in PATH
        if "not" not in output_lower or "path" not in output_lower:
            fail(f"Expected PATH warning in installer output, got:\n{combined_output}")

        # Must include actionable shell configuration instructions for both zsh and bash
        if ".zshrc" not in combined_output or ".bashrc" not in combined_output:
            fail(f"Expected shell config guidance referencing .zshrc and .bashrc, got:\n{combined_output}")

        if "export PATH=" not in combined_output:
            fail(f"Expected 'export PATH=' instruction in output, got:\n{combined_output}")

        success("PATH missing detection and actionable .zshrc / .bashrc instructions verified.")

def test_path_shadowing_detection():
    log("Testing PATH shadowing detection...")
    with tempfile.TemporaryDirectory(prefix="pb_test_home_shadow_") as temp_home, \
         tempfile.TemporaryDirectory(prefix="pb_test_shadow_bin_") as shadow_bin_dir:

        # Create mock shadowing executable
        shadow_prebase = os.path.join(shadow_bin_dir, "prebase")
        with open(shadow_prebase, "w") as f:
            f.write("#!/bin/sh\necho 'shadow-mock-prebase 0.0.0'\n")
        os.chmod(shadow_prebase, 0o755)

        dest_bin = os.path.join(temp_home, ".local", "bin")
        # Set PATH so shadow_bin_dir is before dest_bin
        env = make_isolated_env(temp_home, bin_dir=dest_bin, include_bin_in_path=True, shadow_bin_dir=shadow_bin_dir)

        res = subprocess.run(
            [INSTALL_SH, "--install", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res.returncode != 0:
            fail(f"install.sh failed with shadow PATH:\n{res.stderr}\n{res.stdout}")

        combined_output = res.stdout + "\n" + res.stderr
        output_lower = combined_output.lower()

        # Installer should detect that command resolution resolves to the shadowing binary
        if not ("shadow" in output_lower or "another" in output_lower or "precedence" in output_lower or shadow_bin_dir.lower() in output_lower):
            fail(f"Expected PATH shadowing warning in installer output, got:\n{combined_output}")

        # Verify bare prebase invokes the shadowing mock when shadow_bin_dir is earlier
        res_bare = subprocess.run(["prebase"], env=env, cwd=temp_home, capture_output=True, text=True)
        if "shadow-mock-prebase" not in res_bare.stdout:
            fail(f"Expected bare prebase to invoke shadow mock, got: {res_bare.stdout}")

        success("PATH shadowing detection verified.")

def test_custom_bin_dir_and_prefix():
    log("Testing custom --bin-dir and --prefix options...")
    with tempfile.TemporaryDirectory(prefix="pb_test_custom_") as temp_base:
        # 1. Test --bin-dir <DIR> (exact executable destination)
        custom_bin = os.path.join(temp_base, "my_custom_tools")
        env_bin = make_isolated_env(temp_base, bin_dir=custom_bin, include_bin_in_path=True)

        res_bin = subprocess.run(
            [INSTALL_SH, "--install", "--bin-dir", custom_bin, "--skip-frontend"],
            env=env_bin,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_bin.returncode != 0:
            fail(f"--bin-dir installation failed:\n{res_bin.stderr}\n{res_bin.stdout}")

        expected_bin_file = os.path.join(custom_bin, "prebase")
        if not os.path.isfile(expected_bin_file):
            fail(f"Executable not found directly at {expected_bin_file}")

        # Subdirectory bin/ must not be erroneously created when --bin-dir was given
        if os.path.exists(os.path.join(custom_bin, "bin", "prebase")):
            fail("Found unexpected nested bin/ directory when using --bin-dir")

        res_bare_bin = subprocess.run(["prebase", "--version"], env=env_bin, cwd=temp_base, capture_output=True, text=True)
        if res_bare_bin.returncode != 0 or "prebase" not in res_bare_bin.stdout:
            fail(f"Bare invocation failed for --bin-dir: {res_bare_bin.stderr}")
        success("Custom --bin-dir option verified (exact directory).")

        # 2. Test --prefix <PREFIX> (destination in <PREFIX>/bin)
        custom_prefix = os.path.join(temp_base, "opt_prebase")
        custom_prefix_bin = os.path.join(custom_prefix, "bin")
        env_prefix = make_isolated_env(temp_base, bin_dir=custom_prefix_bin, include_bin_in_path=True)

        res_prefix = subprocess.run(
            [INSTALL_SH, "--install", "--prefix", custom_prefix, "--skip-frontend"],
            env=env_prefix,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_prefix.returncode != 0:
            fail(f"--prefix installation failed:\n{res_prefix.stderr}\n{res_prefix.stdout}")

        expected_prefix_file = os.path.join(custom_prefix_bin, "prebase")
        if not os.path.isfile(expected_prefix_file):
            fail(f"Executable not found at {expected_prefix_file}")

        res_bare_prefix = subprocess.run(["prebase", "--version"], env=env_prefix, cwd=temp_base, capture_output=True, text=True)
        if res_bare_prefix.returncode != 0 or "prebase" not in res_bare_prefix.stdout:
            fail(f"Bare invocation failed for --prefix: {res_bare_prefix.stderr}")
        success("Custom --prefix option verified (installs to <PREFIX>/bin).")

def test_build_sh_workflows():
    log("Testing scripts/build.sh integration (--install, --link, and build-only)...")
    with tempfile.TemporaryDirectory(prefix="pb_test_build_sh_") as temp_home:
        dest_bin = os.path.join(temp_home, ".local", "bin")
        env = make_isolated_env(temp_home, bin_dir=dest_bin, include_bin_in_path=True)

        # 1. Plain build.sh without install/link flags: should build only, not touch dest_bin
        res_plain = subprocess.run(
            [BUILD_SH, "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_plain.returncode != 0:
            fail(f"build.sh build-only failed:\n{res_plain.stderr}\n{res_plain.stdout}")

        if os.path.exists(os.path.join(dest_bin, "prebase")):
            fail("Plain build.sh should not install to user bin directory")
        success("scripts/build.sh build-only mode verified (does not pollute user bin).")

        # 2. build.sh --install
        res_install = subprocess.run(
            [BUILD_SH, "--install", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_install.returncode != 0:
            fail(f"build.sh --install failed:\n{res_install.stderr}\n{res_install.stdout}")

        installed_file = os.path.join(dest_bin, "prebase")
        if not os.path.isfile(installed_file) or os.path.islink(installed_file):
            fail(f"Expected copied file from build.sh --install at {installed_file}")
        success("scripts/build.sh --install verified.")

        # 3. build.sh --link
        res_link = subprocess.run(
            [BUILD_SH, "--link", "--skip-frontend"],
            env=env,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res_link.returncode != 0:
            fail(f"build.sh --link failed:\n{res_link.stderr}\n{res_link.stdout}")

        if not os.path.islink(installed_file):
            fail(f"Expected symlink from build.sh --link at {installed_file}")
        success("scripts/build.sh --link verified.")

if __name__ == "__main__":
    print("=" * 75)
    print("PreBase CLI — Comprehensive Installation & Symlink Verification Suite")
    print("=" * 75)

    test_copied_installation()
    test_development_symlink()
    test_rebuild_updating_symlink()
    test_path_missing_detection()
    test_path_shadowing_detection()
    test_custom_bin_dir_and_prefix()
    test_build_sh_workflows()

    print("=" * 75)
    print("\x1b[32mALL INSTALLATION WORKFLOW VERIFICATIONS PASSED!\x1b[0m")
    print("=" * 75)
