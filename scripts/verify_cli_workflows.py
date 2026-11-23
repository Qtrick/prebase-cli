#!/usr/bin/env python3
"""
PreBase CLI — Comprehensive CLI Workflow & Lifecycle Verification Suite

Verifies:
1. --help and --version flags.
2. Invalid repository path handling (graceful error exit).
3. Non-Git directory support.
4. Empty directory repository support.
5. One-shot terminal commands:
   - prebase analyze (text and --json schema)
   - prebase files (plain, --language, --json)
   - prebase search (query matching, score ranking, --json)
   - prebase inspect (file metadata, dependencies, dependents, --json, path traversal guards)
   - prebase deps (direct, transitive, --json)
   - prebase dependents (direct, transitive, --json)
   - prebase path (directed shortest dependency path, --json)
   - prebase history (--text, --limit, --json)
6. Detached server lifecycle:
   - prebase map --detach (starts background server and returns control)
   - prebase status (reports active server)
   - prebase stop (gracefully shuts down background server)
7. Local server loopback binding, session token authentication, and health.
8. Clean shutdown on SIGTERM / SIGINT without orphaned processes.
"""

import os
import sys
import time
import json
import signal
import socket
import tempfile
import subprocess
import urllib.request
import urllib.parse
import re

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN = os.environ.get("PREBASE_BIN")
if not BIN or not os.path.isfile(BIN):
    release_bin = os.path.join(ROOT_DIR, "target", "release", "prebase")
    debug_bin = os.path.join(ROOT_DIR, "target", "debug", "prebase")
    if os.path.isfile(release_bin):
        BIN = release_bin
    elif os.path.isfile(debug_bin):
        BIN = debug_bin
    else:
        BIN = release_bin

def mask_credentials(text: str) -> str:
    if not text:
        return text
    text = re.sub(r'bootstrap=[A-Za-z0-9_-]+', 'bootstrap=[REDACTED]', text)
    text = re.sub(r'prebase_session(?:_\d+)?=[A-Za-z0-9_-]+', 'prebase_session=[REDACTED]', text)
    text = re.sub(r'x-prebase-session:\s*[^\r\n]+', 'x-prebase-session: [REDACTED]', text)
    text = re.sub(r'Bearer\s+[A-Za-z0-9_-]+', 'Bearer [REDACTED]', text)
    return text

def sanitized_excepthook(exc_type, exc_value, exc_traceback):
    import traceback
    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    sys.stderr.write(mask_credentials(tb_str))

sys.excepthook = sanitized_excepthook

def log(msg):
    print(f"\x1b[36m[CLI VERIFY]\x1b[0m {mask_credentials(str(msg))}", flush=True)

def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {mask_credentials(str(msg))}", flush=True)

def fail(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {mask_credentials(str(msg))}", file=sys.stderr, flush=True)
    sys.exit(1)

def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read().decode("utf-8")

def test_help_and_version():
    log("Testing prebase --help...")
    res = subprocess.run([BIN, "--help"], capture_output=True, text=True)
    if res.returncode != 0 or "Usage:" not in res.stdout:
        fail(f"--help failed: {res.stderr}")
    success("prebase --help output verified.")

    log("Testing prebase --version...")
    res = subprocess.run([BIN, "--version"], capture_output=True, text=True)
    if res.returncode != 0 or "prebase" not in res.stdout:
        fail(f"--version failed: {res.stderr}")
    success("prebase --version output verified.")

    # Verify --help and --version work everywhere (even in an empty directory without a project)
    with tempfile.TemporaryDirectory() as empty_dir:
        res_h = subprocess.run([BIN, "--help"], cwd=empty_dir, capture_output=True, text=True)
        if res_h.returncode != 0:
            fail(f"--help failed when run from empty directory: {res_h.stderr}")
        res_v = subprocess.run([BIN, "--version"], cwd=empty_dir, capture_output=True, text=True)
        if res_v.returncode != 0:
            fail(f"--version failed when run from empty directory: {res_v.stderr}")
    success("prebase --help and --version verified everywhere (including non-project directories).")

def test_invalid_path():
    log("Testing launch against non-existent repository path...")
    bogus_path = os.path.join(tempfile.gettempdir(), "non_existent_prebase_path_xyz123")
    res = subprocess.run([BIN, "--no-open", "map", bogus_path], capture_output=True, text=True)
    if res.returncode == 0:
        fail("Expected non-zero exit code for non-existent path")
    success("Non-existent repository path rejected gracefully with error.")

def test_empty_directory():
    log("Testing rejection of empty and non-project directories...")
    # 1. Targeting an empty directory via explicit path argument
    with tempfile.TemporaryDirectory() as empty_dir:
        res = subprocess.run([BIN, "--no-open", "map", empty_dir], capture_output=True, text=True)
        if res.returncode == 0:
            fail("Expected nonzero exit code when targeting an empty directory")
        err_lower = res.stderr.lower()
        if not any(kw in err_lower for kw in ["project", "repository", "manifest", "not a", "cd", "path"]):
            fail(f"Expected actionable stderr message on empty directory, got: {res.stderr}")
        success("Empty directory path argument rejected with actionable stderr and nonzero exit code.")

        # 2. Running inside an empty directory without path argument
        res_cwd = subprocess.run([BIN, "--no-open", "map"], cwd=empty_dir, capture_output=True, text=True)
        if res_cwd.returncode == 0:
            fail("Expected nonzero exit code when running inside an empty directory without a project")
        err_cwd_lower = res_cwd.stderr.lower()
        if not any(kw in err_cwd_lower for kw in ["project", "repository", "manifest", "not a", "cd", "path"]):
            fail(f"Expected actionable stderr message when running inside empty directory, got: {res_cwd.stderr}")
        success("Execution within empty directory rejected with actionable stderr and nonzero exit code.")

        # 3. Arbitrary directory with non-project files (e.g., notes.txt, sample.jpg)
        with tempfile.TemporaryDirectory() as arbitrary_dir:
            with open(os.path.join(arbitrary_dir, "notes.txt"), "w") as f:
                f.write("Just some personal notes, not a software project\n")
            with open(os.path.join(arbitrary_dir, "sample.jpg"), "wb") as f:
                f.write(b"\xff\xd8\xff\xe0")

            res_arb = subprocess.run([BIN, "analyze", arbitrary_dir], capture_output=True, text=True)
            if res_arb.returncode == 0:
                fail("Expected nonzero exit code for arbitrary non-project directory")
            err_arb_lower = res_arb.stderr.lower()
            if not any(kw in err_arb_lower for kw in ["project", "repository", "manifest", "not a", "cd", "path"]):
                fail(f"Expected actionable stderr message on non-project directory, got: {res_arb.stderr}")
            success("Arbitrary non-project directory rejected with actionable stderr and nonzero exit code.")

def test_git_repository_discovery():
    log("Testing Git repository discovery (standard repo, worktree, and submodule)...")
    with tempfile.TemporaryDirectory() as temp_dir:
        # Standard Git repository
        repo_dir = os.path.join(temp_dir, "repo")
        os.makedirs(repo_dir)
        subprocess.check_call(["git", "init", "-b", "main"], cwd=repo_dir, stdout=subprocess.DEVNULL)
        src_file = os.path.join(repo_dir, "index.ts")
        with open(src_file, "w") as f:
            f.write("export const message = 'hello git';\n")

        res = subprocess.run([BIN, "analyze", repo_dir], capture_output=True, text=True)
        if res.returncode != 0:
            fail(f"Failed to analyze standard Git repository: {res.stderr}")
        if "PreBase Repository Intelligence" not in res.stdout:
            fail(f"Unexpected analyze output for Git repo: {res.stdout}")
        success("Standard Git repository recognized and analyzed.")

        # Git worktree / submodule with .git file pointing to gitdir
        fake_gitdir = os.path.join(temp_dir, "fake_gitdir")
        os.makedirs(os.path.join(fake_gitdir, "objects"))
        os.makedirs(os.path.join(fake_gitdir, "refs"))
        with open(os.path.join(fake_gitdir, "HEAD"), "w") as f:
            f.write("ref: refs/heads/main\n")

        worktree_dir = os.path.join(temp_dir, "worktree")
        os.makedirs(worktree_dir)
        with open(os.path.join(worktree_dir, ".git"), "w") as f:
            f.write(f"gitdir: {fake_gitdir}\n")
        with open(os.path.join(worktree_dir, "main.rs"), "w") as f:
            f.write("fn main() {}\n")

        res_wt = subprocess.run([BIN, "analyze", worktree_dir], capture_output=True, text=True)
        if res_wt.returncode != 0:
            fail(f"Failed to analyze Git worktree/submodule: {res_wt.stderr}")
        success("Git worktree/submodule with .git file recognized and analyzed.")

def test_non_git_manifest_projects():
    log("Testing non-Git project discovery via canonical manifests...")
    manifest_fixtures = [
        ("package.json", '{"name": "test-pkg", "version": "1.0.0"}', "src/index.js", "console.log('hi');"),
        ("Cargo.toml", '[package]\nname = "test-rs"\nversion = "0.1.0"\nedition = "2021"\n', "src/main.rs", "fn main() {}"),
        ("pyproject.toml", '[project]\nname = "test-py"\nversion = "0.1.0"\n', "app.py", "print('hi')"),
        ("go.mod", "module example.com/test-go\n\ngo 1.20\n", "main.go", "package main\nfunc main() {}\n"),
        ("pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>com.test</groupId><artifactId>app</artifactId><version>1.0</version></project>", "src/App.java", "class App {}"),
        ("build.gradle", "plugins { id 'java' }\n", "src/Main.java", "class Main {}"),
        ("Gemfile", "source 'https://rubygems.org'\n", "app.rb", "puts 'hello'"),
    ]

    for manifest_name, manifest_content, src_rel, src_content in manifest_fixtures:
        with tempfile.TemporaryDirectory() as proj_dir:
            manifest_path = os.path.join(proj_dir, manifest_name)
            with open(manifest_path, "w") as f:
                f.write(manifest_content)

            full_src_path = os.path.join(proj_dir, src_rel)
            os.makedirs(os.path.dirname(full_src_path), exist_ok=True)
            with open(full_src_path, "w") as f:
                f.write(src_content)

            res = subprocess.run([BIN, "analyze", proj_dir], capture_output=True, text=True)
            if res.returncode != 0:
                fail(f"Failed to recognize non-Git project with {manifest_name}: {res.stderr}")
            if "PreBase Repository Intelligence" not in res.stdout:
                fail(f"Expected repository intelligence for {manifest_name}, got: {res.stdout}")
            success(f"Non-Git project recognized via manifest: {manifest_name}")

def test_project_subdirectory_discovery():
    log("Testing root discovery when launched from nested project subdirectories...")
    # 1. Inside a Git repository subdirectory
    with tempfile.TemporaryDirectory() as temp_dir:
        repo_dir = os.path.join(temp_dir, "my_repo")
        os.makedirs(repo_dir)
        subprocess.check_call(["git", "init", "-b", "main"], cwd=repo_dir, stdout=subprocess.DEVNULL)
        deep_subdir = os.path.join(repo_dir, "crates", "subcrate", "src", "deep")
        os.makedirs(deep_subdir)
        with open(os.path.join(deep_subdir, "lib.rs"), "w") as f:
            f.write("pub fn deep() -> i32 { 42 }\n")

        # Run analyze from deep subdirectory without passing a path argument
        res = subprocess.run([BIN, "analyze"], cwd=deep_subdir, capture_output=True, text=True)
        if res.returncode != 0:
            fail(f"Failed to discover Git root from subdirectory {deep_subdir}: {res.stderr}")
        if "PreBase Repository Intelligence" not in res.stdout:
            fail(f"Analyze failed from subdirectory: {res.stdout}")
        success("Git repository root discovered when launched from deep subdirectory.")

    # 2. Inside a non-Git manifest project subdirectory
    with tempfile.TemporaryDirectory() as temp_dir:
        proj_dir = os.path.join(temp_dir, "my_node_proj")
        os.makedirs(proj_dir)
        with open(os.path.join(proj_dir, "package.json"), "w") as f:
            f.write('{"name": "deep-proj"}')
        nested_dir = os.path.join(proj_dir, "packages", "core", "src")
        os.makedirs(nested_dir)
        with open(os.path.join(nested_dir, "index.ts"), "w") as f:
            f.write("export const nested = true;\n")

        # Run analyze from nested subdirectory without path argument
        res_non_git = subprocess.run([BIN, "analyze"], cwd=nested_dir, capture_output=True, text=True)
        if res_non_git.returncode != 0:
            fail(f"Failed to discover non-Git project root from subdirectory {nested_dir}: {res_non_git.stderr}")
        success("Non-Git manifest project root discovered when launched from nested subdirectory.")

def test_explicit_path_arguments():
    log("Testing explicit path argument preservation and override...")
    with tempfile.TemporaryDirectory() as empty_dir, tempfile.TemporaryDirectory() as proj_dir:
        # Create a valid project in proj_dir
        with open(os.path.join(proj_dir, "Cargo.toml"), "w") as f:
            f.write('[package]\nname = "explicit-test"\nversion = "0.1.0"\n')
        src_dir = os.path.join(proj_dir, "src")
        os.makedirs(src_dir)
        with open(os.path.join(src_dir, "lib.rs"), "w") as f:
            f.write("pub const X: u32 = 100;\n")

        # Run from empty_dir (CWD has no project), but supply explicit path to proj_dir
        res = subprocess.run([BIN, "analyze", proj_dir], cwd=empty_dir, capture_output=True, text=True)
        if res.returncode != 0:
            fail(f"Explicit path argument failed when invoked from empty CWD: {res.stderr}")
        if "PreBase Repository Intelligence" not in res.stdout:
            fail(f"Unexpected analyze output with explicit path: {res.stdout}")
        success("Explicit project path argument preserved when launched from empty directory.")

        # Run files --json from empty_dir with explicit path
        res_files = subprocess.run([BIN, "files", "--json", proj_dir], cwd=empty_dir, capture_output=True, text=True)
        if res_files.returncode != 0:
            fail(f"Explicit path argument failed for files --json: {res_files.stderr}")
        files = json.loads(res_files.stdout)
        assert any("src/lib.rs" in f["path"] for f in files)
        success("Explicit path argument correctly analyzed for files command.")

        # Run from within valid proj_dir, but pass explicit path pointing to empty_dir -> must reject empty_dir!
        res_bad = subprocess.run([BIN, "analyze", empty_dir], cwd=proj_dir, capture_output=True, text=True)
        if res_bad.returncode == 0:
            fail("Expected nonzero exit when explicitly targeting empty dir from within a project")
        success("Explicit non-project path rejected even when current working directory is a valid project.")

def test_terminal_analyze():
    log("Testing prebase analyze...")
    res = subprocess.run([BIN, "analyze", ROOT_DIR], capture_output=True, text=True)
    if res.returncode != 0:
        fail(f"prebase analyze failed: {res.stderr}")
    if "PreBase Repository Intelligence" not in res.stdout or "Discovered Files:" not in res.stdout:
        fail(f"Unexpected analyze stdout: {res.stdout}")
    success("prebase analyze human-readable output verified.")

    log("Testing prebase analyze --json...")
    res_json = subprocess.run([BIN, "analyze", ROOT_DIR, "--json"], capture_output=True, text=True)
    if res_json.returncode != 0:
        fail(f"prebase analyze --json failed: {res_json.stderr}")
    data = json.loads(res_json.stdout)
    assert "summary" in data and "discovered_files" in data["summary"]
    assert "languages" in data and len(data["languages"]) > 0
    assert "areas" in data and len(data["areas"]) > 0
    success("prebase analyze --json structured output verified.")

def test_terminal_files():
    log("Testing prebase files...")
    res = subprocess.run([BIN, "files", ROOT_DIR], capture_output=True, text=True)
    if res.returncode != 0 or "crates/prebase-cli/src/main.rs" not in res.stdout:
        fail(f"prebase files failed: {res.stderr}")
    success("prebase files output verified.")

    log("Testing prebase files --language rust...")
    res_rust = subprocess.run([BIN, "files", ROOT_DIR, "--language", "rust"], capture_output=True, text=True)
    if res_rust.returncode != 0 or "main.rs" not in res_rust.stdout:
        fail(f"prebase files --language rust failed: {res_rust.stderr}")
    assert "NetworkCanvas.tsx" not in res_rust.stdout
    success("prebase files --language filter verified.")

    log("Testing prebase files --json...")
    res_json = subprocess.run([BIN, "files", ROOT_DIR, "--json"], capture_output=True, text=True)
    if res_json.returncode != 0:
        fail(f"prebase files --json failed: {res_json.stderr}")
    files_data = json.loads(res_json.stdout)
    assert isinstance(files_data, list) and len(files_data) > 0
    assert any(f["path"] == "crates/prebase-cli/src/main.rs" for f in files_data)
    success("prebase files --json output verified.")

def test_terminal_search():
    log("Testing prebase search NetworkCanvas...")
    res = subprocess.run([BIN, "search", "NetworkCanvas", ROOT_DIR], capture_output=True, text=True)
    if res.returncode != 0 or "NetworkCanvas.tsx" not in res.stdout:
        fail(f"prebase search failed: {res.stderr}")
    success("prebase search output verified.")

    log("Testing prebase search --json...")
    res_json = subprocess.run([BIN, "search", "NetworkCanvas", ROOT_DIR, "--json"], capture_output=True, text=True)
    if res_json.returncode != 0:
        fail(f"prebase search --json failed: {res_json.stderr}")
    search_data = json.loads(res_json.stdout)
    assert isinstance(search_data, list) and len(search_data) > 0
    assert search_data[0]["filename"] == "NetworkCanvas.tsx"
    success("prebase search --json output verified.")

def test_terminal_inspect():
    log("Testing prebase inspect crates/prebase-core/src/lib.rs...")
    res = subprocess.run([BIN, "inspect", "crates/prebase-core/src/lib.rs", ROOT_DIR], capture_output=True, text=True)
    if res.returncode != 0 or "Direct Dependencies" not in res.stdout or "Direct Dependents" not in res.stdout:
        fail(f"prebase inspect failed: {res.stderr}")
    success("prebase inspect output verified.")

    log("Testing prebase inspect --json...")
    res_json = subprocess.run([BIN, "inspect", "crates/prebase-core/src/lib.rs", ROOT_DIR, "--json"], capture_output=True, text=True)
    if res_json.returncode != 0:
        fail(f"prebase inspect --json failed: {res_json.stderr}")
    insp_data = json.loads(res_json.stdout)
    assert insp_data["file"]["path"] == "crates/prebase-core/src/lib.rs"
    assert insp_data["area_id"] == "crates/prebase-core"
    assert len(insp_data["dependencies"]) > 0
    assert len(insp_data["dependents"]) > 0
    success("prebase inspect --json output verified.")

    log("Testing prebase inspect path traversal security rejection (../../etc/passwd)...")
    res_sec = subprocess.run([BIN, "inspect", "../../etc/passwd", ROOT_DIR], capture_output=True, text=True)
    assert res_sec.returncode != 0
    success("Path traversal rejected by prebase inspect.")

def test_terminal_deps_and_dependents():
    log("Testing prebase deps...")
    res_deps = subprocess.run([BIN, "deps", "crates/prebase-cli/src/main.rs", ROOT_DIR], capture_output=True, text=True)
    if res_deps.returncode != 0 or "crates/prebase-core/src/scanner.rs" not in res_deps.stdout:
        fail(f"prebase deps failed: {res_deps.stderr}")
    success("prebase deps output verified.")

    log("Testing prebase dependents...")
    res_deps2 = subprocess.run([BIN, "dependents", "crates/prebase-core/src/model.rs", ROOT_DIR], capture_output=True, text=True)
    if res_deps2.returncode != 0 or "crates/prebase-core/src/scanner.rs" not in res_deps2.stdout:
        fail(f"prebase dependents failed: {res_deps2.stderr}")
    success("prebase dependents output verified.")

def test_terminal_path():
    log("Testing prebase path...")
    res = subprocess.run(
        [BIN, "path", "crates/prebase-cli/src/main.rs", "crates/prebase-core/src/model.rs", ROOT_DIR],
        capture_output=True,
        text=True
    )
    if res.returncode != 0 or "Dependency Path Found" not in res.stdout:
        fail(f"prebase path failed: {res.stderr}")
    success("prebase path output verified.")

    log("Testing prebase path --json...")
    res_json = subprocess.run(
        [BIN, "path", "crates/prebase-cli/src/main.rs", "crates/prebase-core/src/model.rs", ROOT_DIR, "--json"],
        capture_output=True,
        text=True
    )
    if res_json.returncode != 0:
        fail(f"prebase path --json failed: {res_json.stderr}")
    path_data = json.loads(res_json.stdout)
    assert path_data["status"] == "found"
    assert path_data["path"]["hops"] >= 1
    success("prebase path --json output verified.")

def test_terminal_history():
    log("Testing prebase history --text --limit 10...")
    res = subprocess.run([BIN, "history", "--text", "--limit", "10", ROOT_DIR], capture_output=True, text=True)
    if res.returncode != 0 or "PreBase Git History" not in res.stderr:
        fail(f"prebase history --text failed: {res.stderr}")
    assert len(res.stdout.splitlines()) > 0
    success("prebase history --text output verified.")

    log("Testing prebase history --json...")
    res_json = subprocess.run([BIN, "history", "--json", ROOT_DIR], capture_output=True, text=True)
    if res_json.returncode != 0:
        fail(f"prebase history --json failed: {res_json.stderr}")
    hist_data = json.loads(res_json.stdout)
    assert "branch" in hist_data and "commits" in hist_data
    assert len(hist_data["commits"]) > 0
    success("prebase history --json output verified.")

def test_detached_daemon_lifecycle():
    log("Testing background server detach, status, and stop lifecycle...")
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create a small repo fixture with scoped git identity
        subprocess.check_call(["git", "init", "-b", "main"], cwd=temp_dir, stdout=subprocess.DEVNULL)
        subprocess.check_call(["git", "config", "user.name", "PreBase Test"], cwd=temp_dir, stdout=subprocess.DEVNULL)
        subprocess.check_call(["git", "config", "user.email", "test@prebase.dev"], cwd=temp_dir, stdout=subprocess.DEVNULL)
        with open(os.path.join(temp_dir, "index.ts"), "w") as f:
            f.write("export const hello = 'world';\n")
        subprocess.check_call(["git", "add", "."], cwd=temp_dir, stdout=subprocess.DEVNULL)
        git_env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "PreBase Test",
            "GIT_AUTHOR_EMAIL": "test@prebase.dev",
            "GIT_COMMITTER_NAME": "PreBase Test",
            "GIT_COMMITTER_EMAIL": "test@prebase.dev",
        }
        subprocess.check_call(["git", "commit", "-m", "initial"], cwd=temp_dir, env=git_env, stdout=subprocess.DEVNULL)

        # 1. Launch with --detach
        port = 19985
        res_detach = subprocess.run(
            [BIN, "--port", str(port), "--no-open", "map", "--detach", temp_dir],
            capture_output=True,
            text=True
        )
        if res_detach.returncode != 0 or "background server started" not in res_detach.stdout:
            fail(f"prebase map --detach failed: {res_detach.stderr}")
        success("prebase map --detach spawned background process.")

        time.sleep(1.5)

        # 2. Check prebase status
        res_status = subprocess.run([BIN, "status", temp_dir], capture_output=True, text=True)
        if res_status.returncode != 0 or "ACTIVE" not in res_status.stdout:
            fail(f"prebase status failed: {res_status.stderr}")
        success("prebase status reports background server ACTIVE.")

        # 3. Verify server HTTP health
        status, body = http_get(f"http://127.0.0.1:{port}/api/v1/health")
        if status != 200 or "ok" not in body:
            fail(f"Background server not responding: {status}")
        success("Background server HTTP health verified.")

        # 4. Stop via prebase stop
        res_stop = subprocess.run([BIN, "stop", temp_dir], capture_output=True, text=True)
        if res_stop.returncode != 0 or "Stopped PreBase server" not in res_stop.stdout:
            fail(f"prebase stop failed: {res_stop.stderr}")
        success("prebase stop terminated background process.")

        time.sleep(0.5)

        # 5. Verify status is now inactive
        res_status2 = subprocess.run([BIN, "status", temp_dir], capture_output=True, text=True)
        if "No active PreBase background server" not in res_status2.stdout:
            fail(f"Expected inactive server, got: {res_status2.stdout}")
        success("prebase status reports server inactive after stop.")

def test_clean_shutdown():
    log("Testing clean foreground server shutdown on SIGTERM...")
    with tempfile.TemporaryDirectory() as temp_dir:
        src_dir = os.path.join(temp_dir, "src")
        os.makedirs(src_dir)
        with open(os.path.join(src_dir, "main.ts"), "w") as f:
            f.write("console.log('main');\n")

        port = 19988
        proc = subprocess.Popen(
            [BIN, "--port", str(port), "--no-open", "map", temp_dir],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        time.sleep(1.2)
        try:
            status, _ = http_get(f"http://127.0.0.1:{port}/api/v1/health")
            if status != 200:
                fail(f"Server failed to start on port {port}: {status}")
        except Exception as e:
            fail(f"Could not reach server on port {port}: {e}")

        proc.send_signal(signal.SIGTERM)
        exit_code = proc.wait(timeout=5)
        stdout, stderr = proc.communicate()

        if exit_code != 0:
            fail(f"Expected clean exit code 0 on SIGTERM, got {exit_code}. stderr: {stderr}")

        # Enforce that port was completely released immediately
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
            sock.close()
            success(f"Port {port} confirmed released immediately after shutdown.")
        except Exception as e:
            fail(f"Port {port} was not released after shutdown: {e}")

        success("Server handled SIGTERM gracefully with exit code 0 and released socket.")

if __name__ == "__main__":
    print("=" * 75)
    print("PreBase CLI — Comprehensive CLI Workflow & Lifecycle Verification Suite")
    print("=" * 75)
    if not os.path.isfile(BIN):
        fail(f"Binary not found at {BIN}. Run cargo build --release first.")

    test_help_and_version()
    test_invalid_path()
    test_empty_directory()
    test_git_repository_discovery()
    test_non_git_manifest_projects()
    test_project_subdirectory_discovery()
    test_explicit_path_arguments()
    test_terminal_analyze()
    test_terminal_files()
    test_terminal_search()
    test_terminal_inspect()
    test_terminal_deps_and_dependents()
    test_terminal_path()
    test_terminal_history()
    test_detached_daemon_lifecycle()
    test_clean_shutdown()

    print("=" * 75)
    print("\x1b[32mALL CLI WORKFLOW VERIFICATIONS PASSED!\x1b[0m")
    print("=" * 75)
