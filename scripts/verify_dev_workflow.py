#!/usr/bin/env python3
"""
PreBase CLI — Development Build & Decoupling Workflow Verification Suite (A–O)

Verifies:
  A. scripts/build.sh --help & invalid/conflicting flag combinations
  B. Cold scripts/build.sh --dev & stamp creation (frontend + deps stamps)
  C. Warm no-op incremental scripts/build.sh --dev (cache hit, skips rebuild)
  D. Frontend-only edit decoupling (rebuilds dist/, does NOT recompile Rust binary)
  E. --force-frontend bypasses current stamp and rebuilds dist/
  F. --skip-frontend success (with valid dist/) & failure (with missing dist/)
  G. Corrupted / incomplete dist/ self-healing (missing asset & symlink rejection)
  H. Dependency stamp invalidation (frontend/node_modules/.prebase-deps-stamp)
  I. --dev --link --bin-dir <DIR> symlink creation & CARGO_TARGET_DIR override
  J. Runtime dev server serves updated dist/ without recompiling Rust + missing-assets fail-closed
  K. Security boundaries in static_assets.rs (path traversal, symlink escape, API/extension 404, SPA fallback)
  L. scripts/dev.sh argument forwarding & stale server detection/restart
  M. Release build (scripts/build.sh) & build.rs release enforcement (missing dist / symlink panic)
  N. --install vs --link replacement & shell syntax check (scripts/check.sh)
  O. Isolation guarantee (ROOT_DIR git status, ~/.local/bin/prebase, and root node_modules untouched)
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ROOT_DIR = Path(__file__).resolve().parent.parent

IGNORED_COPY_NAMES = {
    ".git",
    "target",
    "node_modules",
    "dist",
    ".prebase",
    "test-results",
}


def mask_credentials(text: str) -> str:
    if not text:
        return text
    text = re.sub(r"bootstrap=[A-Za-z0-9_-]+", "bootstrap=[REDACTED]", text)
    text = re.sub(
        r"prebase_session(?:_\d+)?=[A-Za-z0-9_-]+",
        "prebase_session=[REDACTED]",
        text,
    )
    return text


def sanitized_excepthook(exc_type, exc_value, exc_traceback):
    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    sys.stderr.write(mask_credentials(tb_str))


sys.excepthook = sanitized_excepthook


def log(msg: str) -> None:
    print(f"\x1b[36m[DEV VERIFY]\x1b[0m {mask_credentials(str(msg))}", flush=True)


def pass_msg(msg: str) -> None:
    print(f"\x1b[32m[PASS]\x1b[0m {mask_credentials(str(msg))}", flush=True)


def fail_msg(msg: str) -> None:
    print(f"\x1b[31m[FAIL]\x1b[0m {mask_credentials(str(msg))}", file=sys.stderr, flush=True)


class TestFailure(AssertionError):
    pass


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise TestFailure(msg)


def get_clean_path() -> str:
    user_local_bin = os.path.normpath(os.path.expanduser("~/.local/bin"))
    root_target = os.path.normpath(str(ROOT_DIR / "target"))
    parts = []
    for raw in os.environ.get("PATH", "").split(os.pathsep):
        if not raw:
            continue
        norm = os.path.normpath(raw)
        if norm == user_local_bin or norm.startswith(root_target):
            continue
        if norm not in parts:
            parts.append(norm)
    return os.pathsep.join(parts)


@dataclass
class VerifyContext:
    temp_root: Path
    isolated_repo: Path
    isolated_home: Path
    base_env: dict[str, str]
    dev_built: bool = False
    active_repos: list[Path] = field(default_factory=list)
    active_pids: list[int] = field(default_factory=list)
    root_baseline_git_status: str = ""
    root_baseline_deps_stamp: str | None = None
    root_baseline_local_bin: tuple[bool, bool, str | None] = (False, False, None)

    @property
    def build_sh(self) -> Path:
        return self.isolated_repo / "scripts" / "build.sh"

    @property
    def dev_sh(self) -> Path:
        return self.isolated_repo / "scripts" / "dev.sh"

    @property
    def debug_bin(self) -> Path:
        return self.isolated_repo / "target" / "debug" / "prebase"

    @property
    def release_bin(self) -> Path:
        return self.isolated_repo / "target" / "release" / "prebase"

    @property
    def dist_dir(self) -> Path:
        return self.isolated_repo / "crates" / "prebase-server" / "dist"

    @property
    def frontend_dir(self) -> Path:
        return self.isolated_repo / "frontend"

    @property
    def frontend_stamp(self) -> Path:
        return self.isolated_repo / "target" / ".prebase-frontend-stamp"

    @property
    def deps_stamp(self) -> Path:
        return self.frontend_dir / "node_modules" / ".prebase-deps-stamp"


def run_cmd(
    cmd: list[str],
    cwd: Path,
    env: dict[str, str],
    timeout: int = 300,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def assert_ok(
    res: subprocess.CompletedProcess[str],
    context: str,
) -> None:
    if res.returncode != 0:
        raise TestFailure(
            f"{context} failed (exit {res.returncode}):\n"
            f"--- STDOUT ---\n{mask_credentials(res.stdout)}\n"
            f"--- STDERR ---\n{mask_credentials(res.stderr)}"
        )


def copy_isolated_repo(dest: Path) -> None:
    def ignore_fn(_src: str, names: list[str]) -> set[str]:
        return {n for n in names if n in IGNORED_COPY_NAMES}

    shutil.copytree(ROOT_DIR, dest, symlinks=True, ignore=ignore_fn)

    # Copy frontend/node_modules separately so ROOT_DIR/frontend/node_modules
    # is never mutated by .prebase-deps-stamp writes.
    src_nm = ROOT_DIR / "frontend" / "node_modules"
    dst_nm = dest / "frontend" / "node_modules"
    if src_nm.is_dir():
        if platform.system() == "Darwin":
            # Use APFS copy-on-write clone when available for speed.
            clone = subprocess.run(
                ["cp", "-Rc", str(src_nm), str(dst_nm)],
                capture_output=True,
                text=True,
            )
            if clone.returncode != 0:
                if dst_nm.exists():
                    shutil.rmtree(dst_nm)
                shutil.copytree(src_nm, dst_nm, symlinks=True)
        else:
            shutil.copytree(src_nm, dst_nm, symlinks=True)


def stop_server_for_repo(ctx: VerifyContext, repo: Path) -> None:
    if ctx.debug_bin.is_file():
        subprocess.run(
            [str(ctx.debug_bin), "stop", str(repo)],
            cwd=str(ctx.isolated_repo),
            env=ctx.base_env,
            capture_output=True,
            text=True,
            timeout=15,
        )


def register_server(ctx: VerifyContext, repo: Path, pid: int | None = None) -> None:
    if repo not in ctx.active_repos:
        ctx.active_repos.append(repo)
    if pid is not None and pid not in ctx.active_pids:
        ctx.active_pids.append(pid)


def cleanup_all_servers(ctx: VerifyContext) -> None:
    for repo in ctx.active_repos:
        try:
            stop_server_for_repo(ctx, repo)
        except Exception:
            pass
    for pid in ctx.active_pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        except Exception:
            continue
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except ProcessLookupError:
                break
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass


def query_status_json(ctx: VerifyContext, repo: Path) -> dict:
    res = run_cmd(
        [str(ctx.debug_bin), "status", str(repo), "--json"],
        cwd=ctx.isolated_repo,
        env=ctx.base_env,
        timeout=20,
    )
    assert_ok(res, "prebase status --json")
    return json.loads(res.stdout)


def http_get(port: int, path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, resp_headers, body
    finally:
        conn.close()


def ensure_dev_built(ctx: VerifyContext) -> None:
    if ctx.dev_built and ctx.debug_bin.is_file() and (ctx.dist_dir / "index.html").is_file():
        return
    res = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=600)
    assert_ok(res, "initial build.sh --dev")
    ctx.dev_built = True


def snapshot_local_bin() -> tuple[bool, bool, str | None]:
    p = Path.home() / ".local" / "bin" / "prebase"
    exists = p.exists() or p.is_symlink()
    is_link = p.is_symlink()
    target = os.readlink(p) if is_link else None
    return (exists, is_link, target)


# ---------------------------------------------------------------------------
# Tests A through O
# ---------------------------------------------------------------------------


def test_A_help_and_invalid_flags(ctx: VerifyContext) -> None:
    res = run_cmd([str(ctx.build_sh), "--help"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=30)
    assert_ok(res, "build.sh --help")
    for flag in ("--dev", "--skip-frontend", "--force-frontend", "--link", "--install", "--bin-dir", "--prefix"):
        check(flag in res.stdout, f"--help missing {flag}")

    invalid_cases = [
        (["--dev", "--install"], "cannot be combined with --dev"),
        (["--install", "--link"], "Cannot specify both --install and --link"),
        (["--skip-frontend", "--force-frontend"], "Cannot specify both --skip-frontend and --force-frontend"),
        (["--bin-dir", "/tmp/a", "--prefix", "/tmp/b"], "Cannot specify both --bin-dir and --prefix"),
        (["--definitely-unknown-flag"], "Unknown option"),
    ]
    for args, expected_err in invalid_cases:
        r = run_cmd([str(ctx.build_sh), *args], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=30)
        check(r.returncode != 0, f"Expected non-zero exit for {args}, got 0")
        combined = r.stderr + r.stdout
        check(expected_err in combined, f"Expected '{expected_err}' for {args}, got:\n{combined}")


def test_B_cold_dev_build_and_stamps(ctx: VerifyContext) -> None:
    res = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=600)
    assert_ok(res, "cold build.sh --dev")
    ctx.dev_built = True

    check(ctx.debug_bin.is_file(), f"Missing debug binary at {ctx.debug_bin}")
    check(os.access(ctx.debug_bin, os.X_OK), "Debug binary is not executable")

    ver = run_cmd([str(ctx.debug_bin), "--version"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=15)
    assert_ok(ver, "debug prebase --version")
    check("prebase" in ver.stdout.lower(), f"Unexpected --version output: {ver.stdout}")

    index_html = ctx.dist_dir / "index.html"
    check(index_html.is_file() and index_html.stat().st_size > 0, "dist/index.html missing or empty")
    for p in ctx.dist_dir.rglob("*"):
        check(not p.is_symlink(), f"Unexpected symlink inside dist/: {p}")

    check(ctx.frontend_stamp.is_file() and len(ctx.frontend_stamp.read_text().strip()) == 64, "Invalid .prebase-frontend-stamp")
    check(ctx.deps_stamp.is_file() and len(ctx.deps_stamp.read_text().strip()) == 64, "Invalid .prebase-deps-stamp")


def test_C_warm_noop_incremental(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    index_html = ctx.dist_dir / "index.html"
    before_index_stat = index_html.stat()
    before_bin_stat = ctx.debug_bin.stat()
    before_stamp = ctx.frontend_stamp.read_text()

    res = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=180)
    assert_ok(res, "warm no-op build.sh --dev")

    check(
        "Frontend assets: current (skipping rebuild)" in res.stdout,
        f"Expected frontend skip message, got:\n{res.stdout}",
    )
    after_index_stat = index_html.stat()
    after_bin_stat = ctx.debug_bin.stat()
    check(after_index_stat.st_mtime_ns == before_index_stat.st_mtime_ns, "dist/index.html mtime changed on warm no-op")
    check(ctx.frontend_stamp.read_text() == before_stamp, ".prebase-frontend-stamp changed on warm no-op")
    check(after_bin_stat.st_mtime_ns == before_bin_stat.st_mtime_ns, "debug binary mtime changed on warm no-op")


def test_D_frontend_edit_decoupled_from_rust(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    index_src = ctx.frontend_dir / "index.html"
    original_html = index_src.read_text()
    before_bin_stat = ctx.debug_bin.stat()
    before_stamp = ctx.frontend_stamp.read_text()

    marker = "<!-- DEV_VERIFY_DECOUPLE_MARKER -->"
    try:
        index_src.write_text(original_html.replace("</body>", f"{marker}\n</body>"))
        res = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=300)
        assert_ok(res, "build.sh --dev after frontend edit")

        check("Frontend assets: building..." in res.stdout, f"Expected frontend rebuild, got:\n{res.stdout}")
        check(ctx.frontend_stamp.read_text() != before_stamp, ".prebase-frontend-stamp did not update")
        built_html = (ctx.dist_dir / "index.html").read_text()
        check(marker in built_html, "Edited frontend marker did not propagate to dist/index.html")

        after_bin_stat = ctx.debug_bin.stat()
        check(
            after_bin_stat.st_mtime_ns == before_bin_stat.st_mtime_ns
            and "Compiling " not in res.stderr,
            f"Rust debug binary was recompiled/relinked on a frontend-only edit!\n"
            f"before_mtime={before_bin_stat.st_mtime_ns}, after_mtime={after_bin_stat.st_mtime_ns}\n"
            f"cargo stderr:\n{mask_credentials(res.stderr)}",
        )
    finally:
        index_src.write_text(original_html)

    # Rebuild cleanly so subsequent tests start with unmodified frontend/index.html
    restore = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=300)
    assert_ok(restore, "restore clean frontend after test D")


def test_E_force_frontend_bypass(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    index_html = ctx.dist_dir / "index.html"
    before_mtime = index_html.stat().st_mtime_ns
    time.sleep(0.02)

    res = run_cmd(
        [str(ctx.build_sh), "--dev", "--force-frontend"],
        cwd=ctx.isolated_repo,
        env=ctx.base_env,
        timeout=300,
    )
    assert_ok(res, "build.sh --dev --force-frontend")
    check("Frontend assets: building..." in res.stdout, f"Expected forced frontend rebuild, got:\n{res.stdout}")
    check("skipping rebuild" not in res.stdout, "--force-frontend should not skip rebuild")
    check(index_html.stat().st_mtime_ns != before_mtime, "dist/index.html was not replaced on --force-frontend")


def test_F_skip_frontend_success_and_failure(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    res_ok = run_cmd(
        [str(ctx.build_sh), "--dev", "--skip-frontend"],
        cwd=ctx.isolated_repo,
        env=ctx.base_env,
        timeout=180,
    )
    assert_ok(res_ok, "build.sh --dev --skip-frontend with valid dist")
    check("Frontend assets: skipped (--skip-frontend)" in res_ok.stdout, "Missing --skip-frontend log")

    # Remove dist/index.html and verify --skip-frontend fails closed
    index_html = ctx.dist_dir / "index.html"
    backup = index_html.read_bytes()
    try:
        index_html.unlink()
        res_fail = run_cmd(
            [str(ctx.build_sh), "--dev", "--skip-frontend"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=60,
        )
        check(res_fail.returncode != 0, "Expected --skip-frontend to fail when dist/index.html is missing")
        check(
            "valid frontend assets were not found" in (res_fail.stderr + res_fail.stdout),
            f"Unexpected error message for missing dist:\n{res_fail.stderr}",
        )
    finally:
        index_html.write_bytes(backup)


def test_G_corrupted_dist_self_healing(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)

    # Case 1: Delete a referenced asset from dist/assets while keeping stamp intact
    assets_dir = ctx.dist_dir / "assets"
    asset_files = sorted(assets_dir.glob("*")) if assets_dir.is_dir() else []
    check(len(asset_files) > 0, f"Expected built files in {assets_dir}")
    victim = asset_files[0]
    victim.unlink()

    res1 = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=300)
    assert_ok(res1, "self-heal missing dist asset")
    check("Frontend assets: building..." in res1.stdout, "build.sh should rebuild when referenced asset is missing")
    check(victim.is_file(), f"Missing asset {victim.name} was not restored")

    # Case 2: Symlink planted inside dist/ while stamp is intact
    evil_link = ctx.dist_dir / "evil_symlink"
    evil_link.symlink_to("/etc/hosts")
    res2 = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=300)
    assert_ok(res2, "self-heal symlink in dist")
    check("Frontend assets: building..." in res2.stdout, "build.sh should rebuild when symlink exists in dist/")
    check(not evil_link.exists() and not evil_link.is_symlink(), "Symlink inside dist/ was not purged")


def test_H_deps_stamp_invalidation(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    check(ctx.deps_stamp.is_file(), "Expected .prebase-deps-stamp to exist")

    # Use an offline-safe npm shim that records `npm ci` calls and delegates everything else to real npm.
    real_npm = shutil.which("npm", path=ctx.base_env["PATH"])
    check(real_npm is not None, "npm not found on PATH")

    with tempfile.TemporaryDirectory(prefix="pb_npm_shim_") as shim_dir:
        shim_path = Path(shim_dir)
        log_file = shim_path / "npm_ci.log"
        npm_shim = shim_path / "npm"
        npm_shim.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
if [[ "${{1:-}}" == "ci" ]]; then
  echo "CALLED:$*" >> "{log_file}"
  exit 0
fi
exec "{real_npm}" "$@"
"""
        )
        npm_shim.chmod(0o755)

        env = ctx.base_env.copy()
        env["PATH"] = f"{shim_dir}{os.pathsep}{env['PATH']}"

        ctx.deps_stamp.write_text("stale-deps-hash\n")
        res = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=env, timeout=180)
        assert_ok(res, "build.sh --dev with stale deps stamp")
        check("Installing frontend dependencies..." in res.stdout, "Expected dependency reinstall on stale stamp")
        check(log_file.is_file() and "CALLED:ci" in log_file.read_text(), "npm ci was not invoked")
        new_stamp = ctx.deps_stamp.read_text().strip()
        check(len(new_stamp) == 64 and new_stamp != "stale-deps-hash", "deps stamp was not updated")


def test_I_dev_link_and_cargo_target_dir(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    with tempfile.TemporaryDirectory(prefix="pb_target_override_") as custom_target, tempfile.TemporaryDirectory(
        prefix="pb_bin_dir_"
    ) as custom_bin:
        env = ctx.base_env.copy()
        env["CARGO_TARGET_DIR"] = custom_target

        res = run_cmd(
            [str(ctx.build_sh), "--dev", "--link", "--bin-dir", custom_bin],
            cwd=ctx.isolated_repo,
            env=env,
            timeout=600,
        )
        assert_ok(res, "build.sh --dev --link --bin-dir with CARGO_TARGET_DIR")

        linked_bin = Path(custom_bin) / "prebase"
        expected_target_bin = Path(custom_target).resolve() / "debug" / "prebase"
        check(linked_bin.is_symlink(), f"Expected symlink at {linked_bin}")
        check(linked_bin.resolve() == expected_target_bin, f"Symlink target mismatch: {linked_bin.resolve()} != {expected_target_bin}")
        check((Path(custom_target) / ".prebase-frontend-stamp").is_file(), "Frontend stamp not written to CARGO_TARGET_DIR")

        ver = run_cmd([str(linked_bin), "--version"], cwd=ctx.isolated_repo, env=env, timeout=15)
        assert_ok(ver, "linked prebase --version")


def test_J_runtime_serves_updated_dist_and_missing_assets_fail(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    index_src = ctx.frontend_dir / "index.html"
    original_html = index_src.read_text()

    try:
        register_server(ctx, ctx.isolated_repo)
        start_res = run_cmd(
            [str(ctx.debug_bin), "map", str(ctx.isolated_repo), "--detach", "--no-open"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=60,
        )
        assert_ok(start_res, "start dev server for test J")

        status = query_status_json(ctx, ctx.isolated_repo)
        check(status.get("active") is True, f"Expected active server, got: {status}")
        port = int(status["session"]["port"])
        pid = int(status["session"]["pid"])
        register_server(ctx, ctx.isolated_repo, pid)

        marker = "<!-- RUNTIME_DIST_RELOAD_MARKER -->"
        index_src.write_text(original_html.replace("</body>", f"{marker}\n</body>"))
        before_bin_mtime = ctx.debug_bin.stat().st_mtime_ns

        rebuild = run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=300)
        assert_ok(rebuild, "rebuild frontend while dev server runs")
        check(ctx.debug_bin.stat().st_mtime_ns == before_bin_mtime, "Rust binary changed during runtime frontend update")

        code, headers, body = http_get(port, "/")
        check(code == 200, f"GET / returned {code}")
        check("text/html" in headers.get("content-type", ""), f"Unexpected Content-Type: {headers.get('content-type')}")
        check(marker.encode("utf-8") in body, "Running dev server did not serve updated dist/index.html!")

        # Stop server and verify fail-closed when dist/index.html is missing
        stop_server_for_repo(ctx, ctx.isolated_repo)
        dist_index = ctx.dist_dir / "index.html"
        saved = dist_index.read_bytes()
        try:
            dist_index.unlink()
            fail_start = run_cmd(
                [str(ctx.debug_bin), "map", str(ctx.isolated_repo), "--detach", "--no-open"],
                cwd=ctx.isolated_repo,
                env=ctx.base_env,
                timeout=30,
            )
            check(fail_start.returncode != 0, "Expected server start to fail when dist/index.html is missing")
            check(
                "PreBase frontend assets are missing" in (fail_start.stderr + fail_start.stdout),
                f"Unexpected error when dist/index.html missing:\n{fail_start.stderr}\n{fail_start.stdout}",
            )
        finally:
            dist_index.write_bytes(saved)
    finally:
        stop_server_for_repo(ctx, ctx.isolated_repo)
        index_src.write_text(original_html)
        run_cmd([str(ctx.build_sh), "--dev"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=300)


def test_K_static_assets_security_boundaries(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    leak_link = ctx.dist_dir / "leak.txt"
    try:
        register_server(ctx, ctx.isolated_repo)
        start_res = run_cmd(
            [str(ctx.debug_bin), "map", str(ctx.isolated_repo), "--detach", "--no-open"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=60,
        )
        assert_ok(start_res, "start dev server for test K")
        status = query_status_json(ctx, ctx.isolated_repo)
        port = int(status["session"]["port"])
        register_server(ctx, ctx.isolated_repo, int(status["session"]["pid"]))

        # 1. Path traversal rejected
        code, _, _ = http_get(port, "/../Cargo.toml")
        check(code == 400, f"Expected 400 for /../Cargo.toml, got {code}")

        # 2. Symlink inside dist/ rejected at runtime by is_safe_asset_path
        leak_link.symlink_to("/etc/hosts")
        code, _, body = http_get(port, "/leak.txt")
        check(code == 404, f"Expected 404 for symlinked /leak.txt, got {code} (body={body[:80]!r})")

        # 3. Missing static asset extension returns 404 (not SPA index.html)
        code, headers, _ = http_get(port, "/nonexistent-bundle.js")
        check(code == 404, f"Expected 404 for missing .js asset, got {code}")
        check("text/html" not in headers.get("content-type", ""), "Missing .js must not return text/html")

        # 4. API route never falls back to index.html
        code, headers, _ = http_get(port, "/api/v1/nonexistent")
        check(code in (401, 404), f"Expected 401/404 for /api/v1/nonexistent, got {code}")
        check("text/html" not in headers.get("content-type", ""), "API route must not return text/html")

        # 5. SPA navigation route without extension falls back to index.html
        code, headers, body = http_get(port, "/workspace/explore/some-route")
        check(code == 200, f"Expected 200 for SPA route, got {code}")
        check("text/html" in headers.get("content-type", ""), f"Expected text/html for SPA route, got {headers.get('content-type')}")
        check(b"<html" in body.lower(), "SPA route did not return index.html")
    finally:
        if leak_link.is_symlink() or leak_link.exists():
            leak_link.unlink()
        stop_server_for_repo(ctx, ctx.isolated_repo)


def test_L_dev_sh_forwarding_and_stale_restart(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    try:
        # 1. Argument forwarding (--version)
        ver = run_cmd([str(ctx.dev_sh), "--version"], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=180)
        assert_ok(ver, "dev.sh --version")
        check("prebase" in ver.stdout.lower(), f"dev.sh --version output unexpected: {ver.stdout}")

        # 2. Launch server via dev.sh
        register_server(ctx, ctx.isolated_repo)
        start1 = run_cmd(
            [str(ctx.dev_sh), "map", str(ctx.isolated_repo), "--detach", "--no-open", "--skip-frontend"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=180,
        )
        assert_ok(start1, "dev.sh initial launch")
        s1 = query_status_json(ctx, ctx.isolated_repo)
        check(s1.get("active") is True, "Server not active after dev.sh launch")
        pid1 = int(s1["session"]["pid"])
        startup1 = int(s1["session"]["startup_time"])
        register_server(ctx, ctx.isolated_repo, pid1)

        # 3. Diagnostic subcommand (status) should NOT stop the server even if Rust source was touched & rebuilt
        time.sleep(1.1)
        os.utime(ctx.isolated_repo / "crates" / "prebase-cli" / "src" / "main.rs", None)
        status_via_dev = run_cmd(
            [str(ctx.dev_sh), "status", str(ctx.isolated_repo), "--json", "--skip-frontend"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=180,
        )
        assert_ok(status_via_dev, "dev.sh status --json")
        check("Stopping stale PreBase server" not in status_via_dev.stdout, "dev.sh status must skip stale check")
        s_mid = query_status_json(ctx, ctx.isolated_repo)
        check(int(s_mid["session"]["pid"]) == pid1, "dev.sh status unexpectedly restarted server")

        # 4. Launch again via dev.sh -> detects bin_mtime > startup_time and restarts server
        start2 = run_cmd(
            [str(ctx.dev_sh), "map", str(ctx.isolated_repo), "--detach", "--no-open", "--skip-frontend"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=180,
        )
        assert_ok(start2, "dev.sh stale restart launch")
        check(
            "Stopping stale PreBase server" in start2.stdout,
            f"Expected stale server restart message, got:\n{start2.stdout}",
        )
        s2 = query_status_json(ctx, ctx.isolated_repo)
        pid2 = int(s2["session"]["pid"])
        startup2 = int(s2["session"]["startup_time"])
        register_server(ctx, ctx.isolated_repo, pid2)
        check(pid2 != pid1, f"Expected new server PID after stale restart, still {pid2}")
        check(startup2 >= startup1, f"Expected newer startup_time, got {startup2} < {startup1}")
    finally:
        stop_server_for_repo(ctx, ctx.isolated_repo)


def test_M_release_build_and_build_rs_enforcement(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    # 1. Verify build.rs panics in release profile when dist/index.html is missing
    index_html = ctx.dist_dir / "index.html"
    saved = index_html.read_bytes()
    try:
        index_html.unlink()
        res_missing = run_cmd(
            ["cargo", "check", "--release", "--locked", "-p", "prebase-server"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=300,
        )
        check(res_missing.returncode != 0, "Release cargo check must fail when dist/index.html is missing")
        check(
            "Release build requires frontend assets" in (res_missing.stderr + res_missing.stdout),
            f"Unexpected build.rs error:\n{res_missing.stderr}",
        )
    finally:
        index_html.write_bytes(saved)

    # 2. Verify build.rs panics in release profile when a symlink is inside dist/
    evil_link = ctx.dist_dir / "release_evil_link"
    try:
        evil_link.symlink_to("/etc/hosts")
        res_sym = run_cmd(
            ["cargo", "check", "--release", "--locked", "-p", "prebase-server"],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=300,
        )
        check(res_sym.returncode != 0, "Release cargo check must fail when symlink is in dist/")
        check(
            "Refusing to embed symlink" in (res_sym.stderr + res_sym.stdout),
            f"Unexpected build.rs symlink error:\n{res_sym.stderr}",
        )
    finally:
        if evil_link.is_symlink() or evil_link.exists():
            evil_link.unlink()

    # 3. Full release build via scripts/build.sh
    res_rel = run_cmd([str(ctx.build_sh)], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=900)
    assert_ok(res_rel, "release scripts/build.sh")
    check(ctx.release_bin.is_file(), f"Missing release binary at {ctx.release_bin}")


def test_N_install_vs_link_and_shell_syntax(ctx: VerifyContext) -> None:
    ensure_dev_built(ctx)
    # Check shell syntax of all scripts/*.sh
    scripts = sorted((ctx.isolated_repo / "scripts").glob("*.sh"))
    check(len(scripts) > 0, "No scripts/*.sh found")
    for s in scripts:
        r = run_cmd(["bash", "-n", str(s)], cwd=ctx.isolated_repo, env=ctx.base_env, timeout=15)
        assert_ok(r, f"bash -n {s.name}")

    # Verify --dev --link then --install replaces symlink with regular binary
    with tempfile.TemporaryDirectory(prefix="pb_install_bin_") as bin_dir_str:
        bin_dir = Path(bin_dir_str)
        target_bin = bin_dir / "prebase"

        r_link = run_cmd(
            [str(ctx.build_sh), "--dev", "--link", "--skip-frontend", "--bin-dir", bin_dir_str],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=180,
        )
        assert_ok(r_link, "build.sh --dev --link --bin-dir")
        check(target_bin.is_symlink(), "Expected symlink after --link")

        r_inst = run_cmd(
            [str(ctx.build_sh), "--install", "--skip-frontend", "--bin-dir", bin_dir_str],
            cwd=ctx.isolated_repo,
            env=ctx.base_env,
            timeout=900,
        )
        assert_ok(r_inst, "build.sh --install --bin-dir")
        check(target_bin.is_file() and not target_bin.is_symlink(), "Expected regular file after --install")


def test_O_root_isolation_intact(ctx: VerifyContext) -> None:
    # Verify ROOT_DIR git status, root deps stamp, and ~/.local/bin/prebase were never mutated.
    git_res = run_cmd(["git", "status", "--short"], cwd=ROOT_DIR, env=os.environ.copy(), timeout=15)
    assert_ok(git_res, "git status --short on ROOT_DIR")
    check(
        git_res.stdout == ctx.root_baseline_git_status,
        f"ROOT_DIR git status changed!\nBefore:\n{ctx.root_baseline_git_status}\nAfter:\n{git_res.stdout}",
    )

    root_deps_stamp = ROOT_DIR / "frontend" / "node_modules" / ".prebase-deps-stamp"
    after_deps = root_deps_stamp.read_text() if root_deps_stamp.is_file() else None
    check(
        after_deps == ctx.root_baseline_deps_stamp,
        "ROOT_DIR/frontend/node_modules/.prebase-deps-stamp was mutated!",
    )

    check(
        snapshot_local_bin() == ctx.root_baseline_local_bin,
        "~/.local/bin/prebase was mutated!",
    )


TESTS: dict[str, tuple[str, Callable[[VerifyContext], None]]] = {
    "A": ("build.sh --help & invalid flag combinations", test_A_help_and_invalid_flags),
    "B": ("Cold build.sh --dev & stamp creation", test_B_cold_dev_build_and_stamps),
    "C": ("Warm no-op incremental build.sh --dev", test_C_warm_noop_incremental),
    "D": ("Frontend-only edit decoupling (no Rust recompile)", test_D_frontend_edit_decoupled_from_rust),
    "E": ("--force-frontend bypass", test_E_force_frontend_bypass),
    "F": ("--skip-frontend success & failure modes", test_F_skip_frontend_success_and_failure),
    "G": ("Corrupted / incomplete dist/ self-healing", test_G_corrupted_dist_self_healing),
    "H": ("Dependency stamp invalidation", test_H_deps_stamp_invalidation),
    "I": ("--dev --link --bin-dir & CARGO_TARGET_DIR override", test_I_dev_link_and_cargo_target_dir),
    "J": ("Runtime dev server serves updated dist/ & missing-assets fail-closed", test_J_runtime_serves_updated_dist_and_missing_assets_fail),
    "K": ("static_assets.rs security boundaries", test_K_static_assets_security_boundaries),
    "L": ("dev.sh forwarding & stale server restart", test_L_dev_sh_forwarding_and_stale_restart),
    "M": ("Release build & build.rs release enforcement", test_M_release_build_and_build_rs_enforcement),
    "N": ("--install vs --link & scripts/*.sh syntax", test_N_install_vs_link_and_shell_syntax),
    "O": ("ROOT_DIR & ~/.local/bin/prebase isolation guarantee", test_O_root_isolation_intact),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify PreBase dev build & decoupling workflow (A-O).")
    parser.add_argument(
        "--only",
        type=str,
        default="",
        help="Comma-separated list of test IDs to run (e.g. A,B,C,D).",
    )
    parser.add_argument(
        "--keep-temp",
        action="store_true",
        help="Keep temporary isolated workspace after completion for inspection.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.only.strip():
        selected = [item.strip().upper() for item in args.only.split(",") if item.strip()]
        unknown = [item for item in selected if item not in TESTS]
        if unknown:
            fail_msg(f"Unknown test ID(s): {', '.join(unknown)}. Valid: {', '.join(TESTS.keys())}")
            return 2
    else:
        selected = list(TESTS.keys())

    # Capture root baselines before touching anything
    git_res = run_cmd(["git", "status", "--short"], cwd=ROOT_DIR, env=os.environ.copy(), timeout=15)
    baseline_git = git_res.stdout if git_res.returncode == 0 else ""
    root_deps_stamp_path = ROOT_DIR / "frontend" / "node_modules" / ".prebase-deps-stamp"
    baseline_deps = root_deps_stamp_path.read_text() if root_deps_stamp_path.is_file() else None
    baseline_local_bin = snapshot_local_bin()

    temp_root = Path(tempfile.mkdtemp(prefix="prebase_dev_verify_"))
    ctx: VerifyContext | None = None
    failures: list[tuple[str, str]] = []

    try:
        isolated_repo = temp_root / "repo"
        isolated_home = temp_root / "home"
        isolated_home.mkdir(parents=True, exist_ok=True)

        log(f"Creating isolated workspace at {temp_root}...")
        copy_isolated_repo(isolated_repo)

        env = os.environ.copy()
        env["HOME"] = str(isolated_home)
        env["PATH"] = get_clean_path()
        env["CARGO_HOME"] = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))
        env["RUSTUP_HOME"] = os.environ.get("RUSTUP_HOME", os.path.expanduser("~/.rustup"))
        env.pop("PREBASE_BIN_DIR", None)
        env.pop("PREBASE_PREFIX", None)
        env.pop("CARGO_TARGET_DIR", None)

        ctx = VerifyContext(
            temp_root=temp_root,
            isolated_repo=isolated_repo,
            isolated_home=isolated_home,
            base_env=env,
            root_baseline_git_status=baseline_git,
            root_baseline_deps_stamp=baseline_deps,
            root_baseline_local_bin=baseline_local_bin,
        )

        for test_id in selected:
            label, fn = TESTS[test_id]
            log(f"[{test_id}] {label}...")
            try:
                fn(ctx)
                pass_msg(f"[{test_id}] {label}")
            except Exception as exc:
                msg = mask_credentials(str(exc))
                fail_msg(f"[{test_id}] {label}: {msg}")
                failures.append((test_id, msg))
    finally:
        if ctx is not None:
            cleanup_all_servers(ctx)
        if args.keep_temp:
            log(f"Keeping temporary workspace: {temp_root}")
        else:
            shutil.rmtree(temp_root, ignore_errors=True)

    print("", flush=True)
    if failures:
        fail_msg(f"{len(failures)}/{len(selected)} test(s) failed:")
        for tid, msg in failures:
            print(f"  - [{tid}] {msg}", file=sys.stderr, flush=True)
        return 1

    pass_msg(f"All {len(selected)} selected test(s) passed ({', '.join(selected)}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
