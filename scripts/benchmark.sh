#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${PREBASE_BIN:-$ROOT_DIR/target/release/prebase}"

if [ ! -f "$BIN" ]; then
    if [ -n "${PREBASE_BIN:-}" ]; then
        echo "==> ERROR: Specified PREBASE_BIN not found: $BIN" >&2
        exit 1
    fi
    echo "==> Release binary not found. Building release binary first..."
    cargo build --release --bin prebase
fi

BENCH_DIR=$(mktemp -d -t prebase-bench-XXXXXX)
PREBASE_PID=""
BENCHMARK_COMPLETED=0
TIERS_EXECUTED=0
if [ "${PREBASE_EXTENDED_BENCHMARKS:-0}" = "1" ] || [ "${1:-}" = "--extended" ]; then
    EXPECTED_TOTAL_TIERS=8
else
    EXPECTED_TOTAL_TIERS=5
fi

# Redact credentials and sensitive tokens from logs before printing diagnostics
sanitize_log() {
    local file="$1"
    if [ -f "$file" ]; then
        sed -E \
            -e 's/bootstrap=[a-zA-Z0-9_.~%+-]+/bootstrap=[REDACTED]/g' \
            -e 's/auth_token=[a-zA-Z0-9_.~%+-]+/auth_token=[REDACTED]/g' \
            -e 's/"?session_token"?[[:space:]]*:[[:space:]]*"[^"]+"/"session_token": "[REDACTED]"/g' \
            -e 's/prebase_session(_[0-9]+)?=[a-zA-Z0-9_.~%+-]+/prebase_session\1=[REDACTED]/g' \
            -e 's/([xX]-[pP]rebase-[sS]ession):[[:space:]]*[a-zA-Z0-9_.~%+-]+/\1: [REDACTED]/g' \
            -e 's/([aA]uthorization):[[:space:]]*([bB]earer)[[:space:]]+[a-zA-Z0-9_.~%+-]+/\1: \2 [REDACTED]/g' \
            "$file"
    fi
}

# Gracefully terminate PreBase process with bounded wait and fallback to SIGKILL
terminate_prebase_process() {
    local pid="${1:-}"
    local grace_s="${2:-2.0}"

    if [ -z "$pid" ]; then
        return 0
    fi

    if kill -0 "$pid" 2>/dev/null; then
        kill -15 "$pid" 2>/dev/null || true
        # Poll up to grace period in 0.05s increments (e.g. 40 * 0.05s = 2.0s)
        local poll_count
        poll_count=$(python3 -c "import math; print(max(1, int(float('$grace_s') / 0.05)))" 2>/dev/null || echo 40)
        for _ in $(seq 1 "$poll_count"); do
            if ! kill -0 "$pid" 2>/dev/null; then
                break
            fi
            sleep 0.05
        done

        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        wait "$pid" 2>/dev/null || true
    fi
}

cleanup() {
    local original_status=$?

    # Release any active PreBase child process with bounded wait
    if [ -n "${PREBASE_PID:-}" ]; then
        terminate_prebase_process "$PREBASE_PID" 2.0
        PREBASE_PID=""
    fi

    # Remove temporary scratch workspace
    if [ -n "${BENCH_DIR:-}" ] && [ -d "$BENCH_DIR" ]; then
        rm -rf "$BENCH_DIR"
    fi 2>/dev/null || rm -rf "$BENCH_DIR" 2>/dev/null || true

    # Ensure abnormal or premature termination produces a non-zero exit code
    if [ "$BENCHMARK_COMPLETED" -ne 1 ]; then
        echo "==> ERROR: Benchmark terminated abnormally before completing all benchmark tiers (executed: ${TIERS_EXECUTED}/${EXPECTED_TOTAL_TIERS})." >&2
        if [ "$original_status" -eq 0 ]; then
            original_status=1
        fi
    fi

    exit "$original_status"
}

# Clean up on normal exit, failures, and interrupts alike.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> Running PreBase Automated Performance Benchmark (Real Verification)"
echo "    Benchmark scratch directory: $BENCH_DIR"

create_fixture() {
    local COUNT=$1
    local TOPOLOGY=$2
    local REPO_DIR=$3

    mkdir -p "$REPO_DIR/src"

    git init -q -b main "$REPO_DIR"
    git -C "$REPO_DIR" config user.email "bench@prebase.dev"
    git -C "$REPO_DIR" config user.name "Benchmarker"

    python3 - "$COUNT" "$TOPOLOGY" "$REPO_DIR" << 'PYEOF'
import sys, os

count = int(sys.argv[1])
topology = sys.argv[2]
repo_dir = sys.argv[3]
src_dir = os.path.join(repo_dir, "src")

if topology == "deep_chain":
    for i in range(1, count + 1):
        path = os.path.join(src_dir, f"module_{i}.ts")
        if i < count:
            nxt = i + 1
            content = f"import {{ helper_{nxt} }} from './module_{nxt}';\nexport function helper_{i}() {{ return {i} + helper_{nxt}(); }}\n"
        else:
            content = f"export function helper_{i}() {{ return {i}; }}\n"
        with open(path, "w") as f:
            f.write(content)
    with open(os.path.join(src_dir, "index.ts"), "w") as f:
        f.write("import { helper_1 } from './module_1';\nconsole.log(helper_1());\n")

elif topology == "dense_hub":
    for i in range(1, count + 1):
        n1 = (i % count) + 1
        n2 = ((i + 1) % count) + 1
        n3 = ((i + 2) % count) + 1
        content = (
            f"import {{ helper_{n1} }} from './module_{n1}';\n"
            f"import {{ helper_{n2} }} from './module_{n2}';\n"
            f"import {{ helper_{n3} }} from './module_{n3}';\n"
            f"export function helper_{i}() {{ return {i} + helper_{n1}() + helper_{n2}() + helper_{n3}(); }}\n"
        )
        with open(os.path.join(src_dir, f"module_{i}.ts"), "w") as f:
            f.write(content)
    with open(os.path.join(src_dir, "index.ts"), "w") as f:
        f.write("import { helper_1 } from './module_1';\nconsole.log(helper_1());\n")

elif topology == "sparse_areas":
    for area in ["area_a", "area_b", "area_c"]:
        os.makedirs(os.path.join(src_dir, area), exist_ok=True)
    per_area = count // 3
    for i in range(1, per_area + 1):
        for area, pfx in [("area_a", "a"), ("area_b", "b"), ("area_c", "c")]:
            with open(os.path.join(src_dir, area, f"mod_{pfx}_{i}.ts"), "w") as f:
                f.write(f"export function func_{pfx}_{i}() {{ return {i}; }}\n")
    with open(os.path.join(src_dir, "index.ts"), "w") as f:
        f.write(
            "import { func_a_1 } from './area_a/mod_a_1';\n"
            "import { func_b_1 } from './area_b/mod_b_1';\n"
            "import { func_c_1 } from './area_c/mod_c_1';\n"
            "console.log(func_a_1() + func_b_1() + func_c_1());\n"
        )

else:
    for i in range(1, count + 1):
        nxt = (i % count) + 1
        content = f"import {{ helper_{nxt} }} from './module_{nxt}';\nexport function helper_{i}() {{ return {i} + helper_{nxt}(); }}\n"
        with open(os.path.join(src_dir, f"module_{i}.ts"), "w") as f:
            f.write(content)
    with open(os.path.join(src_dir, "index.ts"), "w") as f:
        f.write("import { helper_1 } from './module_1';\nconsole.log(helper_1());\n")
PYEOF

    git -C "$REPO_DIR" add .
    git -C "$REPO_DIR" commit -q -m "chore: initial commit with ${COUNT} files [${TOPOLOGY}]"

    # Create additional commits to verify git integration
    for c in 1 2 3; do
        echo "// revision ${c}" >> "$REPO_DIR/src/index.ts"
        git -C "$REPO_DIR" add "$REPO_DIR/src/index.ts"
        git -C "$REPO_DIR" commit -q -m "feat: commit iteration ${c}"
    done
}

run_benchmark() {
    local COUNT=$1
    local TOPOLOGY=${2:-"modular_cycle"}
    local REPO_DIR="$BENCH_DIR/repo_${COUNT}_${TOPOLOGY}"
    local LOG_FILE="$BENCH_DIR/prebase_${COUNT}_${TOPOLOGY}.log"

    echo ""
    echo "--------------------------------------------------------"
    echo " Benchmark Tier: ${COUNT} TypeScript Files [Topology: ${TOPOLOGY}]"
    echo "--------------------------------------------------------"

    # 1. Generate synthetic repository based on requested topology
    create_fixture "$COUNT" "$TOPOLOGY" "$REPO_DIR"

    # Expected node and edge counts according to topology
    local EXPECTED_NODES
    local EXPECTED_EDGES
    case "$TOPOLOGY" in
        "deep_chain")
            EXPECTED_NODES=$(( COUNT + 1 ))
            EXPECTED_EDGES=$(( COUNT ))
            ;;
        "dense_hub")
            EXPECTED_NODES=$(( COUNT + 1 ))
            EXPECTED_EDGES=$(( (COUNT * 3) + 1 ))
            ;;
        "sparse_areas")
            local PER_AREA=$(( COUNT / 3 ))
            EXPECTED_NODES=$(( (PER_AREA * 3) + 1 ))
            EXPECTED_EDGES=3
            ;;
        *)
            EXPECTED_NODES=$(( COUNT + 1 ))
            EXPECTED_EDGES=$(( COUNT + 1 ))
            ;;
    esac

    # 2. Launch PreBase server with dynamic ephemeral port (--port 0)
    local LAUNCH_START_MS
    LAUNCH_START_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
    "$BIN" --port 0 --no-open --no-watch "$REPO_DIR" > "$LOG_FILE" 2>&1 &
    PREBASE_PID=$!

    # 3. Poll log for bound port and bootstrap token
    local BOUND_PORT=""
    local BOOTSTRAP_TOKEN=""
    local MAX_POLL="${MAX_PORT_POLL:-100}"
    if ! [[ "$MAX_POLL" =~ ^[0-9]+$ ]] || [ "$MAX_POLL" -lt 1 ]; then
        MAX_POLL=100
    fi
    for _ in $(seq 1 "$MAX_POLL"); do
        if grep -q "bootstrap=" "$LOG_FILE" 2>/dev/null && grep -q "http://127.0.0.1:" "$LOG_FILE" 2>/dev/null; then
            BOUND_PORT=$(grep -o 'http://127.0.0.1:[0-9]*' "$LOG_FILE" | head -n 1 | cut -d: -f3)
            BOOTSTRAP_TOKEN=$(grep -o 'bootstrap=[^& ]*' "$LOG_FILE" | head -n 1 | cut -d= -f2)
            if [ -n "$BOUND_PORT" ] && [ -n "$BOOTSTRAP_TOKEN" ]; then
                break
            fi
        fi
        sleep 0.05
    done

    if [ -z "$BOUND_PORT" ] || [ -z "$BOOTSTRAP_TOKEN" ]; then
        echo "    ERROR: PreBase server failed to start or print server URL within 5s."
        sanitize_log "$LOG_FILE"
        terminate_prebase_process "$PREBASE_PID" 1.0
        PREBASE_PID=""
        exit 1
    fi

    # 4. Poll /api/v1/health until HTTP listener is ready
    local SERVER_READY=0
    for _ in $(seq 1 50); do
        if curl -s -f "http://127.0.0.1:$BOUND_PORT/api/v1/health" > /dev/null 2>&1; then
            SERVER_READY=1
            break
        fi
        sleep 0.05
    done

    if [ "$SERVER_READY" -ne 1 ]; then
        echo "    ERROR: PreBase health endpoint not responding on port $BOUND_PORT."
        sanitize_log "$LOG_FILE"
        terminate_prebase_process "$PREBASE_PID" 1.0
        PREBASE_PID=""
        exit 1
    fi

    local HTTP_READY_MS
    HTTP_READY_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
    local STARTUP_LATENCY_MS=$(( HTTP_READY_MS - LAUNCH_START_MS ))

    # 5. Exchange bootstrap token for session token (expose_token enabled for CLI benchmark)
    local SESSION_RESP
    SESSION_RESP=$(curl -s -X POST "http://127.0.0.1:$BOUND_PORT/api/v1/auth/session" \
        -H "Content-Type: application/json" \
        -d "{\"bootstrap_token\":\"$BOOTSTRAP_TOKEN\",\"expose_token\":true}")
    local SESSION_TOKEN
    SESSION_TOKEN=$(echo "$SESSION_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("session_token", ""))' 2>/dev/null || echo "")

    if [ -z "$SESSION_TOKEN" ]; then
        echo "    ERROR: Failed to obtain session token."
        sanitize_log "$LOG_FILE"
        terminate_prebase_process "$PREBASE_PID" 1.0
        PREBASE_PID=""
        exit 1
    fi

    # 6. Poll /api/v1/status until indexing_status is "Ready"
    local INDEX_READY=0
    local MAX_POLL=450 # 45 seconds timeout
    local ANALYSIS_DURATION_MS="0"
    for _ in $(seq 1 $MAX_POLL); do
        local STATUS_JSON
        STATUS_JSON=$(curl -s "http://127.0.0.1:$BOUND_PORT/api/v1/status" -H "x-prebase-session: $SESSION_TOKEN" || echo "{}")
        local CURR_STATUS
        CURR_STATUS=$(echo "$STATUS_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("indexing_status", ""))' 2>/dev/null || echo "")

        if [ "$CURR_STATUS" = "Ready" ]; then
            INDEX_READY=1
            ANALYSIS_DURATION_MS=$(echo "$STATUS_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("analysis_duration_ms", 0))' 2>/dev/null || echo "0")
            break
        elif [ "$CURR_STATUS" = "Failed" ]; then
            echo "    ERROR: Repository indexing failed according to backend status."
            sanitize_log "$LOG_FILE"
            terminate_prebase_process "$PREBASE_PID" 1.0
            PREBASE_PID=""
            exit 1
        fi
        sleep 0.05
    done

    local END_INDEX_MS
    END_INDEX_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
    local TOTAL_WALLCLOCK_MS=$(( END_INDEX_MS - LAUNCH_START_MS ))

    if [ "$INDEX_READY" -ne 1 ]; then
        echo "    ERROR: Indexing did not reach Ready status within 45s timeout."
        sanitize_log "$LOG_FILE"
        terminate_prebase_process "$PREBASE_PID" 1.0
        PREBASE_PID=""
        exit 1
    fi

    # 7. Verify published network snapshot node and edge counts
    local NETWORK_JSON
    NETWORK_JSON=$(curl -s "http://127.0.0.1:$BOUND_PORT/api/v1/network" -H "x-prebase-session: $SESSION_TOKEN")
    local NODE_COUNT
    NODE_COUNT=$(echo "$NETWORK_JSON" | python3 -c 'import sys, json; print(len(json.load(sys.stdin).get("nodes", [])))' 2>/dev/null || echo 0)
    local EDGE_COUNT
    EDGE_COUNT=$(echo "$NETWORK_JSON" | python3 -c 'import sys, json; print(len(json.load(sys.stdin).get("edges", [])))' 2>/dev/null || echo 0)

    # Correctness gate: a Ready status with the wrong graph is a strict failure.
    if [ "$NODE_COUNT" -ne "$EXPECTED_NODES" ] || [ "$EDGE_COUNT" -ne "$EXPECTED_EDGES" ]; then
        echo ""
        echo "    FAILURE: benchmark correctness assertion failed."
        echo "      Fixture:       ${COUNT} files [${TOPOLOGY}]"
        echo "      Nodes:         expected ${EXPECTED_NODES}, actual ${NODE_COUNT}"
        echo "      Relationships: expected ${EXPECTED_EDGES}, actual ${EDGE_COUNT}"
        echo "      Log:"
        sanitize_log "$LOG_FILE"
        terminate_prebase_process "$PREBASE_PID" 1.0
        PREBASE_PID=""
        exit 1
    fi

    # 8. Clean graceful shutdown via SIGTERM with bounded timeout and record shutdown duration
    local SHUTDOWN_START_MS
    SHUTDOWN_START_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
    terminate_prebase_process "$PREBASE_PID" 3.0
    local SHUTDOWN_END_MS
    SHUTDOWN_END_MS=$(python3 -c 'import time; print(int(time.monotonic() * 1000))')
    local SHUTDOWN_DURATION_MS=$(( SHUTDOWN_END_MS - SHUTDOWN_START_MS ))
    PREBASE_PID=""

    echo "    Files Indexed:            ${NODE_COUNT} nodes / ${EDGE_COUNT} relationships (expected ${EXPECTED_NODES}/${EXPECTED_EDGES})"
    echo "    Startup Latency:          ${STARTUP_LATENCY_MS} ms (spawn to HTTP ready)"
    echo "    Backend AST Analysis:     ${ANALYSIS_DURATION_MS} ms (Tree-sitter AST & dependency resolution)"
    echo "    Total Wallclock Time:     ${TOTAL_WALLCLOCK_MS} ms (spawn to graph Ready)"
    echo "    Shutdown Duration:        ${SHUTDOWN_DURATION_MS} ms (SIGTERM to exit)"
    echo "    Status:                   PASSED (Strict Correctness & Authoritative Metrics)"

    TIERS_EXECUTED=$(( TIERS_EXECUTED + 1 ))
}

# Run all 5 required baseline benchmark tiers
run_benchmark 100 "modular_cycle"
run_benchmark 100 "deep_chain"
run_benchmark 500 "dense_hub"
run_benchmark 500 "sparse_areas"
run_benchmark 1000 "modular_cycle"

# Extended Scalability Workloads (2.5k, 5k, 10k files)
if [ "${PREBASE_EXTENDED_BENCHMARKS:-0}" = "1" ] || [ "${1:-}" = "--extended" ]; then
    echo ""
    echo "========================================================"
    echo " Running Extended Scalability Workloads (2.5k, 5k, 10k)"
    echo "========================================================"
    run_benchmark 2500 "modular_cycle"
    run_benchmark 5000 "sparse_areas"
    run_benchmark 10000 "modular_cycle"
fi

if [ "$TIERS_EXECUTED" -ne "$EXPECTED_TOTAL_TIERS" ]; then
    echo "==> ERROR: Completed $TIERS_EXECUTED tiers, expected $EXPECTED_TOTAL_TIERS" >&2
    exit 1
fi

BENCHMARK_COMPLETED=1

echo ""
echo "========================================================"
echo " All ${TIERS_EXECUTED} Performance Benchmarks Verified Successfully!"
echo "========================================================"
