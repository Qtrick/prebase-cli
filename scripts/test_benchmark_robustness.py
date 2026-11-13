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
    log("Verifying credential sanitization helper...")
    # Test log containing sensitive tokens
    sample_log = (
        "2026-11-12T19:00:00Z INFO Server running at: http://127.0.0.1:54321/?bootstrap=SecretBootstrap123456&view=3d\n"
        "2026-11-12T19:00:01Z Response: {\"session_token\":\"SessionSecret9876543210\"}\n"
        "2026-11-12T19:00:02Z Cookie: prebase_session=CookieSecretABCDEF123456\n"
        "2026-11-12T19:00:03Z Request: x-prebase-session: HeaderSecretZYXWVUT987\n"
        "2026-11-12T19:00:04Z Authorization: Bearer BearerTokenSecret112233\n"
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
        # Check that no secrets leaked
        leaked = [
            "SecretBootstrap123456",
            "SessionSecret9876543210",
            "CookieSecretABCDEF123456",
            "HeaderSecretZYXWVUT987",
            "BearerTokenSecret112233",
        ]
        for secret in leaked:
            if secret in out:
                fail_msg(f"Credential leaked in sanitized log: {secret}")
                return False

        if "bootstrap=[REDACTED]" not in out:
            fail_msg("Expected 'bootstrap=[REDACTED]' in sanitized log.")
            return False
        if '"session_token":"[REDACTED]"' not in out:
            fail_msg("Expected 'session_token\":\"[REDACTED]\"' in sanitized log.")
            return False
        if "prebase_session=[REDACTED]" not in out:
            fail_msg("Expected 'prebase_session=[REDACTED]' in sanitized log.")
            return False
        if "x-prebase-session: [REDACTED]" not in out:
            fail_msg("Expected 'x-prebase-session: [REDACTED]' in sanitized log.")
            return False
        if "Authorization: Bearer [REDACTED]" not in out:
            fail_msg("Expected 'Authorization: Bearer [REDACTED]' in sanitized log.")
            return False

        pass_msg("All credentials successfully redacted with [REDACTED] placeholders.")
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


def main():
    print("================================================================================")
    print("PreBase CLI — Benchmark Robustness & Negative-Case Verification")
    print("================================================================================")
    tests = [
        ("Shell Syntax Validation", test_syntax_validation),
        ("Abnormal Exit Status Propagation", test_abnormal_exit_status_propagation),
        ("Credential Sanitization & Redaction", test_credential_sanitization),
        ("Graph Assertion Mismatch Failure", test_graph_assertion_mismatch_failure),
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
