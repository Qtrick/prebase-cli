#!/usr/bin/env python3
"""
PreBase CLI — Benchmark Robustness and Negative-Case Test Suite

Validates that scripts/benchmark.sh adheres to strict failure propagation and security contracts:
  1. Early syntax errors are detected with non-zero exit code (bash -n).
  2. Runtime abnormal termination propagates non-zero exit status on both Linux and macOS.
  3. Graph count assertion mismatches abort with non-zero exit status.
  4. Credential sanitization redacts bootstrap tokens, session tokens, and auth headers from logs.
  5. Child processes and temporary directories are reliably cleaned up without orphaned sockets.
"""

import os
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCHMARK_SH = os.path.join(ROOT_DIR, "scripts", "benchmark.sh")


def log(msg):
    print(f"\x1b[36m[BENCH-TEST]\x1b[0m {msg}", flush=True)


def pass_msg(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {msg}", flush=True)


def fail_msg(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {msg}", file=sys.stderr, flush=True)


def test_syntax_validation():
    log("Verifying bash -n syntax validation...")
    proc = subprocess.run(["bash", "-n", BENCHMARK_SH], capture_output=True, text=True)
    if proc.returncode != 0:
        fail_msg(f"scripts/benchmark.sh failed bash -n: {proc.stderr}")
        return False
    pass_msg("scripts/benchmark.sh syntax is valid.")

    # Negative test: intentionally corrupt syntax and verify non-zero exit code (exact CI reproduction)
    corrupt_script = "echo 'start'\nif true; then\n  else\n  echo bad\nfi\n"
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(corrupt_script)
        corrupt_path = f.name
    try:
        proc_corrupt = subprocess.run(["bash", "-n", corrupt_path], capture_output=True, text=True)
        if proc_corrupt.returncode == 0:
            fail_msg("Expected syntax corruption to fail bash -n, but it returned 0.")
            return False
        pass_msg(f"Syntax corruption correctly rejected with exit code {proc_corrupt.returncode}.")
    finally:
        if os.path.exists(corrupt_path):
            os.remove(corrupt_path)
    return True


def test_abnormal_exit_status_propagation():
    log("Verifying exit status preservation on macOS/Linux trap handlers...")
    # Simulate a benchmark script that terminates prematurely before setting BENCHMARK_COMPLETED=1
    with open(BENCHMARK_SH, "r") as f:
        content = f.read()

    # Create a stub script that fails midway
    stub_content = content.replace(
        'run_benchmark 100 "modular_cycle"',
        'echo "Simulating premature failure"\nexit 1',
    )

    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(stub_content)
        stub_path = f.name
    os.chmod(stub_path, 0o755)

    try:
        proc = subprocess.run(["/bin/bash", stub_path], capture_output=True, text=True)
        if proc.returncode == 0:
            fail_msg("Premature exit was masked! Script returned exit code 0.")
            return False
        pass_msg(f"Premature exit correctly produced non-zero exit code: {proc.returncode}")
    finally:
        if os.path.exists(stub_path):
            os.remove(stub_path)
    return True


def test_credential_sanitization():
    log("Verifying credential sanitization helper across full security boundary...")
    # Comprehensive sample log covering all credential formats, port partitions, spacing, and multi-secret lines
    sample_log = (
        # 1. Bootstrap tokens in URLs
        "2026-11-12T19:00:00Z INFO Server running at: http://127.0.0.1:19881/?bootstrap=DummyBootstrapToken999&view=3d\n"
        # 2. Port-suffixed session cookies (isolated)
        "2026-11-12T19:00:01Z Cookie: prebase_session_19881=DummySecret123\n"
        # 3. Port-suffixed session cookies in multi-cookie header
        "2026-11-12T19:00:02Z Cookie: a=b; prebase_session_19881=DummyMultiCookieSecret123; c=d\n"
        # 4. Legacy unsuffixed cookies
        "2026-11-12T19:00:03Z Cookie: prebase_session=DummySecretLegacy\n"
        # 5. JSON tokens with various whitespace patterns
        "2026-11-12T19:00:04Z Response: {\"session_token\": \"DummySecret456\"}\n"
        "2026-11-12T19:00:05Z Response: {\"session_token\" : \"DummySecretSpaceBoth\"}\n"
        "2026-11-12T19:00:06Z Response: {\"session_token\":\"DummySecretCompact\"}\n"
        # 6. Session headers (title case and lower case)
        "2026-11-12T19:00:07Z Request: X-Prebase-Session: DummyHeaderToken111\n"
        "2026-11-12T19:00:08Z Request: x-prebase-session: DummyHeaderToken222\n"
        # 7. Authorization headers (Bearer uppercase and bearer lowercase)
        "2026-11-12T19:00:09Z Authorization: Bearer DummyBearer333\n"
        "2026-11-12T19:00:10Z authorization: bearer DummyBearer444\n"
        # 8. Multiple secrets on one line
        "2026-11-12T19:00:11Z Multi: prebase_session_19881=MultiCookieSecret999 x-prebase-session: MultiHeaderSecret888 Authorization: Bearer MultiBearerSecret777 bootstrap=MultiBootstrapSecret666\n"
        # 9. Complex tokens containing dots, tildes, and special base64url characters
        "2026-11-12T19:00:12Z Complex: Cookie: prebase_session_8080=Secret.With.Dots~And-Dashes; X-Prebase-Session: Header.With.Tildes~123 Authorization: Bearer Bearer.With.Dots.And~Tildes_99 bootstrap=Bootstrap.With.Special~Chars_88\n"
    )

    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
        f.write(sample_log)
        log_path = f.name

    # Extract the exact sanitize_log function from scripts/benchmark.sh
    with open(BENCHMARK_SH, "r") as f:
        bench_text = f.read()

    func_match = re.search(r"(sanitize_log\(\)\s*\{[\s\S]*?\n\})", bench_text)
    if not func_match:
        fail_msg("Could not extract sanitize_log function from scripts/benchmark.sh")
        return False
    sanitize_func = func_match.group(1)

    test_script = f"""#!/usr/bin/env bash
set -e
{sanitize_func}
sanitize_log "{log_path}"
"""
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(test_script)
        script_path = f.name
    os.chmod(script_path, 0o755)

    try:
        proc = subprocess.run(["/bin/bash", script_path], capture_output=True, text=True)
        out = proc.stdout

        # Check for any leaked secret tokens
        secrets_to_check = [
            "DummyBootstrapToken999",
            "DummySecret123",
            "DummyMultiCookieSecret123",
            "DummySecretLegacy",
            "DummySecret456",
            "DummySecretSpaceBoth",
            "DummySecretCompact",
            "DummyHeaderToken111",
            "DummyHeaderToken222",
            "DummyBearer333",
            "DummyBearer444",
            "MultiCookieSecret999",
            "MultiHeaderSecret888",
            "MultiBearerSecret777",
            "MultiBootstrapSecret666",
            "Secret.With.Dots~And-Dashes",
            "Header.With.Tildes~123",
            "Bearer.With.Dots.And~Tildes_99",
            "Bootstrap.With.Special~Chars_88",
        ]
        leaked = [secret for secret in secrets_to_check if secret in out]
        if leaked:
            for secret in leaked:
                fail_msg(f"Credential leaked in sanitized log: {secret}")
            return False

        # Verify expected redacted placeholders are present
        if "bootstrap=[REDACTED]" not in out:
            fail_msg("Expected 'bootstrap=[REDACTED]' in sanitized log.")
            return False
        if "prebase_session_19881=[REDACTED]" not in out:
            fail_msg("Expected 'prebase_session_19881=[REDACTED]' in sanitized log.")
            return False
        if "prebase_session=[REDACTED]" not in out:
            fail_msg("Expected 'prebase_session=[REDACTED]' in sanitized log.")
            return False

        session_matches = re.findall(r'"session_token"\s*:\s*"\[REDACTED\]"', out)
        if len(session_matches) < 3:
            fail_msg(f"Expected 3 redacted session_token entries, found {len(session_matches)} in sanitized log.")
            return False

        if "X-Prebase-Session: [REDACTED]" not in out:
            fail_msg("Expected 'X-Prebase-Session: [REDACTED]' in sanitized log.")
            return False
        if "x-prebase-session: [REDACTED]" not in out:
            fail_msg("Expected 'x-prebase-session: [REDACTED]' in sanitized log.")
            return False
        if "Authorization: Bearer [REDACTED]" not in out:
            fail_msg("Expected 'Authorization: Bearer [REDACTED]' in sanitized log.")
            return False
        if "authorization: bearer [REDACTED]" not in out and "authorization: Bearer [REDACTED]" not in out:
            fail_msg("Expected 'authorization: bearer [REDACTED]' in sanitized log.")
            return False

        pass_msg("All credentials across all formats and boundaries successfully redacted.")
    finally:
        if os.path.exists(log_path):
            os.remove(log_path)
        if os.path.exists(script_path):
            os.remove(script_path)
    return True


def test_graph_assertion_mismatch_failure():
    log("Verifying graph assertion mismatch aborts with non-zero exit code...")
    # Inject an impossible assertion expectation
    with open(BENCHMARK_SH, "r") as f:
        content = f.read()

    # Ensure ROOT_DIR points to real repo instead of /tmp
    mismatch_content = content.replace(
        'ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"',
        f'ROOT_DIR="{ROOT_DIR}"',
    )
    # Modify expected nodes to be impossible (e.g. 999999)
    mismatch_content = mismatch_content.replace(
        'EXPECTED_NODES=$(( COUNT + 1 ))',
        'EXPECTED_NODES=999999',
    )
    # Only run the first tier (100) for fast test
    mismatch_content = re.sub(
        r'run_benchmark 100 "modular_cycle"[\s\S]*?run_benchmark 1000 "modular_cycle"',
        'run_benchmark 100 "modular_cycle"',
        mismatch_content,
    )

    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(mismatch_content)
        mismatch_path = f.name
    os.chmod(mismatch_path, 0o755)

    try:
        proc = subprocess.run(["/bin/bash", mismatch_path], capture_output=True, text=True)
        if proc.returncode == 0:
            fail_msg("Assertion mismatch did NOT cause non-zero exit code!")
            return False
        if "FAILURE: benchmark correctness assertion failed" not in proc.stdout:
            fail_msg(f"Expected failure diagnostic message, got stdout: {proc.stdout}")
            return False
        pass_msg(f"Assertion mismatch correctly detected and failed with exit code {proc.returncode}.")
    finally:
        if os.path.exists(mismatch_path):
            os.remove(mismatch_path)
    return True


def test_terminate_prebase_process():
    log("Verifying terminate_prebase_process helper across process states...")
    with open(BENCHMARK_SH, "r") as f:
        bench_text = f.read()

    func_match = re.search(r"(terminate_prebase_process\(\)\s*\{[\s\S]*?\n\})", bench_text)
    if not func_match:
        fail_msg("Could not extract terminate_prebase_process function from scripts/benchmark.sh")
        return False
    term_func = func_match.group(1)

    # Subtest 1: Stub process that exits cleanly on SIGTERM (verify bounded completion and process reaped)
    ready_file_clean = tempfile.mktemp()
    test_clean_script = f"""#!/usr/bin/env bash
set -e
{term_func}

python3 -c "import time, sys
open(sys.argv[1], 'w').write('ready\\n')
time.sleep(60)
" "{ready_file_clean}" &
CHILD_PID=$!

while [ ! -f "{ready_file_clean}" ]; do sleep 0.01; done

if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "ERROR: Child not running" >&2
    exit 1
fi

START_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
terminate_prebase_process "$CHILD_PID" 2.0
END_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
DURATION_MS=$(( END_MS - START_MS ))

if kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "ERROR: Child still running after terminate_prebase_process" >&2
    exit 1
fi

echo "CLEAN_SUCCESS duration_ms=$DURATION_MS"
"""
    try:
        proc = subprocess.run(["/bin/bash", "-c", test_clean_script], capture_output=True, text=True, timeout=10)
        if proc.returncode != 0:
            fail_msg(f"terminate_prebase_process failed on clean SIGTERM exit: {proc.stderr}")
            return False
        m = re.search(r"CLEAN_SUCCESS duration_ms=(\d+)", proc.stdout)
        if not m:
            fail_msg(f"Expected clean success output, got: {proc.stdout}")
            return False
        duration_ms = int(m.group(1))
        if duration_ms > 1500:
            fail_msg(f"terminate_prebase_process took too long on clean SIGTERM exit: {duration_ms}ms")
            return False
        pass_msg(f"terminate_prebase_process reaped clean child within {duration_ms}ms.")
    finally:
        if os.path.exists(ready_file_clean):
            os.remove(ready_file_clean)

    # Subtest 2: Stub process that traps and ignores SIGTERM (verify bounded timeout, fallback to SIGKILL, process reaped, no hang!)
    ready_file_ignore = tempfile.mktemp()
    test_ignore_script = f"""#!/usr/bin/env bash
set -e
{term_func}

python3 -c "import signal, time, sys
signal.signal(signal.SIGTERM, signal.SIG_IGN)
open(sys.argv[1], 'w').write('ready\\n')
while True:
    time.sleep(1)
" "{ready_file_ignore}" &
CHILD_PID=$!

while [ ! -f "{ready_file_ignore}" ]; do sleep 0.01; done

if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "ERROR: Child not running" >&2
    exit 1
fi

START_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
terminate_prebase_process "$CHILD_PID" 0.3
END_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
DURATION_MS=$(( END_MS - START_MS ))

if kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "ERROR: Stub ignoring SIGTERM was not killed by fallback SIGKILL" >&2
    exit 1
fi

echo "SIGKILL_SUCCESS duration_ms=$DURATION_MS"
"""
    try:
        proc = subprocess.run(["/bin/bash", "-c", test_ignore_script], capture_output=True, text=True, timeout=10)
        if proc.returncode != 0:
            fail_msg(f"terminate_prebase_process failed on unresponsive child: {proc.stderr}")
            return False
        m = re.search(r"SIGKILL_SUCCESS duration_ms=(\d+)", proc.stdout)
        if not m:
            fail_msg(f"Expected SIGKILL fallback success output, got: {proc.stdout}")
            return False
        duration_ms = int(m.group(1))
        # Grace period is 0.3s (300ms); duration should be ~300ms to ~1500ms (bounded, no hang!)
        if duration_ms < 200 or duration_ms > 2500:
            fail_msg(f"terminate_prebase_process SIGKILL duration unexpected: {duration_ms}ms")
            return False
        pass_msg(f"terminate_prebase_process fell back to SIGKILL for unresponsive child within {duration_ms}ms without hanging.")
    finally:
        if os.path.exists(ready_file_ignore):
            os.remove(ready_file_ignore)

    # Subtest 3: Stub process that has already exited before termination (verify clean return without error)
    test_already_exited_script = f"""#!/usr/bin/env bash
set -e
{term_func}

true &
CHILD_PID=$!
wait "$CHILD_PID" 2>/dev/null || true

# Child has already exited: terminate_prebase_process must return 0 immediately
terminate_prebase_process "$CHILD_PID" 1.0

# Non-existent PID must return 0
terminate_prebase_process "999999" 1.0

# Empty/unset PID must return 0
terminate_prebase_process "" 1.0
terminate_prebase_process

echo "ALREADY_EXITED_SUCCESS"
"""
    proc = subprocess.run(["/bin/bash", "-c", test_already_exited_script], capture_output=True, text=True, timeout=5)
    if proc.returncode != 0:
        fail_msg(f"terminate_prebase_process failed for already-exited/empty PID: {proc.stderr}")
        return False
    if "ALREADY_EXITED_SUCCESS" not in proc.stdout:
        fail_msg(f"Expected already-exited success output, got: {proc.stdout}")
        return False
    pass_msg("terminate_prebase_process safely and cleanly handled already-exited and empty PIDs.")

    return True


def test_server_startup_failure_cleanup():
    log("Verifying benchmark cleanup on server startup failure/port timeout...")
    mock_pid_file = tempfile.mktemp()
    mock_bin = tempfile.mktemp(suffix=".sh")
    with open(mock_bin, "w") as f:
        f.write(f"""#!/usr/bin/env bash
echo "$$" > "{mock_pid_file}"
# Simulate server that starts but hangs/fails to bind port or print URL
sleep 30
""")
    os.chmod(mock_bin, 0o755)

    env = os.environ.copy()
    env["PREBASE_BIN"] = mock_bin
    env["MAX_PORT_POLL"] = "6"

    child_pid = None
    bench_dir = None
    try:
        proc = subprocess.run(
            ["/bin/bash", BENCHMARK_SH],
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
        )
        # 1. Verify non-zero exit code
        if proc.returncode == 0:
            fail_msg("Expected non-zero exit code on server startup failure, got 0.")
            return False

        # 2. Extract scratch directory and verify cleanup
        m_dir = re.search(r"Benchmark scratch directory:\s*(\S+)", proc.stdout)
        if not m_dir:
            fail_msg(f"Could not locate scratch directory in benchmark output: {proc.stdout}")
            return False
        bench_dir = m_dir.group(1)
        if os.path.exists(bench_dir):
            fail_msg(f"Benchmark scratch directory was NOT cleaned up: {bench_dir}")
            return False

        # 3. Verify child process was reaped and is no longer running
        if not os.path.exists(mock_pid_file):
            fail_msg("Mock server was never executed or failed to write PID file.")
            return False
        child_pid = int(open(mock_pid_file).read().strip())
        child_alive = True
        try:
            os.kill(child_pid, 0)
        except OSError:
            child_alive = False
        if child_alive:
            fail_msg(f"Child process (PID {child_pid}) was orphaned and left running!")
            return False

        # 4. Verify diagnostic error was logged
        if "PreBase server failed to start or print server URL" not in proc.stdout:
            fail_msg(f"Expected startup failure diagnostic in output, got: {proc.stdout}")
            return False

        pass_msg(f"Server startup failure cleanly propagated exit code {proc.returncode}, terminated child process, and removed scratch directory.")
        return True
    finally:
        if child_pid:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except OSError:
                pass
        if bench_dir and os.path.exists(bench_dir):
            import shutil
            shutil.rmtree(bench_dir, ignore_errors=True)
        if os.path.exists(mock_pid_file):
            os.remove(mock_pid_file)
        if os.path.exists(mock_bin):
            os.remove(mock_bin)


def _run_benchmark_signal_test(sig, expected_rc, sig_name):
    log(f"Verifying benchmark lifecycle cleanup when {sig_name} is sent to in-flight run...")
    mock_pid_file = tempfile.mktemp()
    mock_bin = tempfile.mktemp(suffix=".sh")
    with open(mock_bin, "w") as f:
        f.write(f"""#!/usr/bin/env bash
echo "$$" > "{mock_pid_file}"
while true; do
    sleep 0.1
done
""")
    os.chmod(mock_bin, 0o755)

    env = os.environ.copy()
    env["PREBASE_BIN"] = mock_bin

    child_pid = None
    bench_dir = None
    proc = subprocess.Popen(
        ["/bin/bash", BENCHMARK_SH],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )

    try:
        # Wait for mock server child to start and record PID
        for _ in range(60):
            if os.path.exists(mock_pid_file):
                break
            time.sleep(0.05)

        if not os.path.exists(mock_pid_file):
            fail_msg("Mock server failed to write PID file in time.")
            return False

        child_pid = int(open(mock_pid_file).read().strip())

        # Verify child process is actively running before sending signal
        try:
            os.kill(child_pid, 0)
        except OSError:
            fail_msg(f"Child process {child_pid} was not alive prior to signal.")
            return False

        # Send signal to in-flight benchmark process
        proc.send_signal(sig)
        stdout, stderr = proc.communicate(timeout=8)

        # 1. Verify exact expected exit code (130 for INT, 143 for TERM)
        if proc.returncode != expected_rc:
            fail_msg(f"Expected exit code {expected_rc} on {sig_name}, got {proc.returncode}. stderr: {stderr}")
            return False

        # 2. Extract scratch directory and verify removal
        m_dir = re.search(r"Benchmark scratch directory:\s*(\S+)", stdout)
        if not m_dir:
            fail_msg(f"Could not locate scratch directory in output: {stdout}")
            return False
        bench_dir = m_dir.group(1)
        if os.path.exists(bench_dir):
            fail_msg(f"Benchmark scratch directory was NOT removed on {sig_name}: {bench_dir}")
            return False

        # 3. Verify child process was terminated and reaped
        child_alive = True
        try:
            os.kill(child_pid, 0)
        except OSError:
            child_alive = False
        if child_alive:
            fail_msg(f"Child process {child_pid} remained orphaned after {sig_name}!")
            return False

        pass_msg(f"{sig_name} correctly exited with code {expected_rc}, terminated child PID {child_pid}, and removed scratch workspace.")
        return True
    finally:
        if child_pid:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except OSError:
                pass
        if proc.poll() is None:
            proc.kill()
        if bench_dir and os.path.exists(bench_dir):
            import shutil
            shutil.rmtree(bench_dir, ignore_errors=True)
        if os.path.exists(mock_pid_file):
            os.remove(mock_pid_file)
        if os.path.exists(mock_bin):
            os.remove(mock_bin)


def test_benchmark_sigint_lifecycle():
    return _run_benchmark_signal_test(signal.SIGINT, 130, "SIGINT")


def test_benchmark_sigterm_lifecycle():
    return _run_benchmark_signal_test(signal.SIGTERM, 143, "SIGTERM")


def main():
    print("================================================================================")
    print("PreBase CLI — Benchmark Robustness & Negative-Case Verification")
    print("================================================================================")
    tests = [
        ("Shell Syntax Validation", test_syntax_validation),
        ("Abnormal Exit Status Propagation", test_abnormal_exit_status_propagation),
        ("Credential Sanitization & Redaction", test_credential_sanitization),
        ("Graph Assertion Mismatch Failure", test_graph_assertion_mismatch_failure),
        ("Process Termination Helper Lifecycle", test_terminate_prebase_process),
        ("Server Startup Failure Cleanup", test_server_startup_failure_cleanup),
        ("SIGINT Interrupt Lifecycle Handling", test_benchmark_sigint_lifecycle),
        ("SIGTERM Termination Lifecycle Handling", test_benchmark_sigterm_lifecycle),
    ]

    all_passed = True
    for name, test_fn in tests:
        try:
            if not test_fn():
                all_passed = False
                fail_msg(f"Test '{name}' failed.")
                break
        except Exception as e:
            fail_msg(f"Test '{name}' encountered unexpected exception: {e}")
            all_passed = False
            break

    print("================================================================================")
    if all_passed:
        print("\x1b[32mALL BENCHMARK ROBUSTNESS & SECURITY CHECKS PASSED!\x1b[0m")
        print("================================================================================")
        sys.exit(0)
    else:
        print("\x1b[31mBENCHMARK ROBUSTNESS CHECKS FAILED!\x1b[0m", file=sys.stderr)
        print("================================================================================")
        sys.exit(1)


if __name__ == "__main__":
    main()
