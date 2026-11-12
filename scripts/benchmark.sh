#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT_DIR/target/release/prebase"

if [ ! -f "$BIN" ]; then
    echo "==> Release binary not found. Building release binary first..."
    cargo build --release --bin prebase
fi

BENCH_DIR=$(mktemp -d -t prebase-bench-XXXXXX)
trap 'rm -rf "$BENCH_DIR"' EXIT

echo "==> Running PreBase Automated Performance Benchmark (Real Verification)"
echo "    Benchmark scratch directory: $BENCH_DIR"

run_benchmark() {
    local COUNT=$1
    local REPO_DIR="$BENCH_DIR/repo_${COUNT}"
    local LOG_FILE="$BENCH_DIR/prebase_${COUNT}.log"
    local PORT=$(( 19000 + COUNT ))
    local TOPOLOGY=${2:-"modular_cycle"}
    local REPO_DIR="$BENCH_DIR/repo_${COUNT}_${TOPOLOGY}"
    local LOG_FILE="$BENCH_DIR/prebase_${COUNT}_${TOPOLOGY}.log"
    local PORT=$(( 19000 + (COUNT % 1000) + (RANDOM % 500) ))
    mkdir -p "$REPO_DIR/src"

    echo ""
    echo "--------------------------------------------------------"
    echo " Benchmark Tier: ${COUNT} TypeScript Files"
    echo " Benchmark Tier: ${COUNT} TypeScript Files [Topology: ${TOPOLOGY}]"
    echo "--------------------------------------------------------"

    # 1. Generate synthetic modular repository
    # 1. Generate synthetic repository based on requested topology
    git init -q "$REPO_DIR"
    git -C "$REPO_DIR" config user.email "bench@prebase.dev"
    git -C "$REPO_DIR" config user.name "Benchmarker"

    for i in $(seq 1 "$COUNT"); do
        local NEXT=$(( (i % COUNT) + 1 ))
        cat <<EOF > "$REPO_DIR/src/module_${i}.ts"
    case "$TOPOLOGY" in
        "deep_chain")
            # Linear chain: 1 -> 2 -> 3 -> ... -> N
            for i in $(seq 1 "$COUNT"); do
                if [ "$i" -lt "$COUNT" ]; then
                    local NEXT=$(( i + 1 ))
                    cat <<EOF > "$REPO_DIR/src/module_${i}.ts"
import { helper_${NEXT} } from './module_${NEXT}';
export function helper_${i}() { return ${i} + helper_${NEXT}(); }
EOF
                else
                    cat <<EOF > "$REPO_DIR/src/module_${i}.ts"
export function helper_${i}() { return ${i}; }
EOF
                fi
            done
            cat <<EOF > "$REPO_DIR/src/index.ts"
import { helper_1 } from './module_1';
console.log(helper_1());
EOF
            ;;

export function helper_${i}() {
    return ${i} + helper_${NEXT}();
}
        "dense_hub")
            # Dense connectivity: each module imports up to 3 peer modules
            for i in $(seq 1 "$COUNT"); do
                local N1=$(( (i % COUNT) + 1 ))
                local N2=$(( ((i + 1) % COUNT) + 1 ))
                local N3=$(( ((i + 2) % COUNT) + 1 ))
                cat <<EOF > "$REPO_DIR/src/module_${i}.ts"
import { helper_${N1} } from './module_${N1}';
import { helper_${N2} } from './module_${N2}';
import { helper_${N3} } from './module_${N3}';
export function helper_${i}() { return ${i} + helper_${N1}() + helper_${N2}() + helper_${N3}(); }
EOF
    done
            done
            cat <<EOF > "$REPO_DIR/src/index.ts"
import { helper_1 } from './module_1';
console.log(helper_1());
EOF
            ;;

    # Entry file
    cat <<EOF > "$REPO_DIR/src/index.ts"
        "sparse_areas")
            # Disconnected sparse areas in separate directories
            mkdir -p "$REPO_DIR/src/area_a" "$REPO_DIR/src/area_b" "$REPO_DIR/src/area_c"
            local PER_AREA=$(( COUNT / 3 ))
            for i in $(seq 1 "$PER_AREA"); do
                cat <<EOF > "$REPO_DIR/src/area_a/mod_a_${i}.ts"
export function func_a_${i}() { return ${i}; }
EOF
                cat <<EOF > "$REPO_DIR/src/area_b/mod_b_${i}.ts"
export function func_b_${i}() { return ${i}; }
EOF
                cat <<EOF > "$REPO_DIR/src/area_c/mod_c_${i}.ts"
export function func_c_${i}() { return ${i}; }
EOF
            done
            cat <<EOF > "$REPO_DIR/src/index.ts"
import { func_a_1 } from './area_a/mod_a_1';
import { func_b_1 } from './area_b/mod_b_1';
import { func_c_1 } from './area_c/mod_c_1';
console.log(func_a_1() + func_b_1() + func_c_1());
EOF
            ;;

        *)
            # Default modular cycle
            for i in $(seq 1 "$COUNT"); do
                local NEXT=$(( (i % COUNT) + 1 ))
                cat <<EOF > "$REPO_DIR/src/module_${i}.ts"
import { helper_${NEXT} } from './module_${NEXT}';
export function helper_${i}() { return ${i} + helper_${NEXT}(); }
EOF
            done
            cat <<EOF > "$REPO_DIR/src/index.ts"
import { helper_1 } from './module_1';
console.log(helper_1());
EOF
            ;;
    esac

    git -C "$REPO_DIR" add .
    git -C "$REPO_DIR" commit -q -m "chore: initial commit with ${COUNT} files"
    git -C "$REPO_DIR" commit -q -m "chore: initial commit with ${COUNT} files [${TOPOLOGY}]"

    # Create commits to test git integration
    for c in 1 2 3 4 5; do
    # Create commits to verify git integration
    for c in 1 2 3; do
        echo "// revision ${c}" >> "$REPO_DIR/src/index.ts"
        git -C "$REPO_DIR" add "$REPO_DIR/src/index.ts"
        git -C "$REPO_DIR" commit -q -m "feat: commit iteration ${c}"
    done

    # 2. Launch PreBase server with specified port, recording launch timestamp
    local LAUNCH_START_MS
    LAUNCH_START_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')
    "$BIN" --port "$PORT" --no-open --no-watch "$REPO_DIR" > "$LOG_FILE" 2>&1 &
    local PREBASE_PID=$!

    # 3. Poll /api/v1/health until server is listening
    local SERVER_READY=0
    for _ in $(seq 1 50); do
        if curl -s -f "http://127.0.0.1:$PORT/api/v1/health" > /dev/null 2>&1; then
            SERVER_READY=1
            break
        fi
        sleep 0.05
    done

    if [ "$SERVER_READY" -ne 1 ]; then
        echo "    ERROR: PreBase server failed to start within 5s."
        cat "$LOG_FILE"
        kill -9 "$PREBASE_PID" 2>/dev/null || true
        exit 1
    fi

    local HTTP_READY_MS
    HTTP_READY_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')
    local STARTUP_LATENCY_MS=$(( HTTP_READY_MS - LAUNCH_START_MS ))

    # 4. Extract bootstrap token from startup log
    local BOOTSTRAP_TOKEN=""
    for _ in $(seq 1 20); do
        if grep -q "bootstrap=" "$LOG_FILE"; then
            BOOTSTRAP_TOKEN=$(grep -o 'bootstrap=[^& ]*' "$LOG_FILE" | head -n 1 | cut -d= -f2)
            break
        fi
        sleep 0.05
    done

    if [ -z "$BOOTSTRAP_TOKEN" ]; then
        echo "    ERROR: Could not extract bootstrap token from log."
        cat "$LOG_FILE"
        kill -9 "$PREBASE_PID" 2>/dev/null || true
        exit 1
    fi

    # 5. Exchange bootstrap token for session token (explicit expose_token for CLI benchmark tool)
    local SESSION_RESP
    SESSION_RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/api/v1/auth/session" \
        -H "Content-Type: application/json" \
        -d "{\"bootstrap_token\":\"$BOOTSTRAP_TOKEN\",\"expose_token\":true}")
    local SESSION_TOKEN
    SESSION_TOKEN=$(echo "$SESSION_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("session_token", ""))')

    if [ -z "$SESSION_TOKEN" ]; then
        echo "    ERROR: Failed to obtain session token: $SESSION_RESP"
        kill -9 "$PREBASE_PID" 2>/dev/null || true
        exit 1
    fi

    # 6. Poll /api/v1/status until indexing_status is "Ready"
    local INDEX_READY=0
    local MAX_POLL=450 # 45 seconds timeout
    local ANALYSIS_DURATION_MS="0"
    for _ in $(seq 1 $MAX_POLL); do
        local STATUS_JSON
        STATUS_JSON=$(curl -s "http://127.0.0.1:$PORT/api/v1/status" -H "x-prebase-session: $SESSION_TOKEN" || echo "{}")
        local CURR_STATUS
        CURR_STATUS=$(echo "$STATUS_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("indexing_status", ""))' 2>/dev/null || echo "")

        if [ "$CURR_STATUS" = "Ready" ]; then
            INDEX_READY=1
            ANALYSIS_DURATION_MS=$(echo "$STATUS_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("analysis_duration_ms", 0))' 2>/dev/null || echo "0")
            break
        elif [ "$CURR_STATUS" = "Failed" ]; then
            echo "    ERROR: Repository indexing failed according to backend status."
            cat "$LOG_FILE"
            kill -9 "$PREBASE_PID" 2>/dev/null || true
            exit 1
        fi
        sleep 0.05
    done

    local END_INDEX_MS
    END_INDEX_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')
    local TOTAL_WALLCLOCK_MS=$(( END_INDEX_MS - LAUNCH_START_MS ))

    if [ "$INDEX_READY" -ne 1 ]; then
        echo "    ERROR: Indexing did not reach Ready status within 45s timeout."
        kill -9 "$PREBASE_PID" 2>/dev/null || true
        exit 1
    fi

    # 7. Verify published network snapshot node count
    local NETWORK_JSON
    NETWORK_JSON=$(curl -s "http://127.0.0.1:$PORT/api/v1/network" -H "x-prebase-session: $SESSION_TOKEN")
    local NODE_COUNT
    NODE_COUNT=$(echo "$NETWORK_JSON" | python3 -c 'import sys, json; print(len(json.load(sys.stdin).get("nodes", [])))' 2>/dev/null || echo 0)
    local EXPECTED_NODES=$(( COUNT + 1 ))

    if [ "$NODE_COUNT" -ne "$EXPECTED_NODES" ]; then
        echo "    ERROR: Node count mismatch: got $NODE_COUNT, expected $EXPECTED_NODES"
        kill -9 "$PREBASE_PID" 2>/dev/null || true
        exit 1
    fi

    # 8. Clean graceful shutdown via SIGTERM
    # 8. Clean graceful shutdown via SIGTERM and record shutdown duration
    local SHUTDOWN_START_MS
    SHUTDOWN_START_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')
    kill -15 "$PREBASE_PID" 2>/dev/null || true
    wait "$PREBASE_PID" 2>/dev/null || true
    local SHUTDOWN_END_MS
    SHUTDOWN_END_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')
    local SHUTDOWN_DURATION_MS=$(( SHUTDOWN_END_MS - SHUTDOWN_START_MS ))

    echo "    Files Indexed:            ${NODE_COUNT} nodes (Expected: ${EXPECTED_NODES})"
    echo "    Files Indexed:            ${NODE_COUNT} nodes"
    echo "    Startup Latency:          ${STARTUP_LATENCY_MS} ms (spawn to HTTP ready)"
    echo "    Backend Indexing Time:    ${ANALYSIS_DURATION_MS} ms (Tree-sitter AST & dependency resolution)"
    echo "    Backend AST Analysis:     ${ANALYSIS_DURATION_MS} ms (Tree-sitter AST & dependency resolution)"
    echo "    Total Wallclock Time:     ${TOTAL_WALLCLOCK_MS} ms (spawn to graph Ready)"
    echo "    Shutdown Duration:        ${SHUTDOWN_DURATION_MS} ms (SIGTERM to exit)"
    echo "    Status:                   PASSED (Strict Correctness & Authoritative Metrics)"
}

run_benchmark 100
run_benchmark 500
run_benchmark 1000
run_benchmark 100 "modular_cycle"
run_benchmark 100 "deep_chain"
run_benchmark 500 "dense_hub"
run_benchmark 500 "sparse_areas"
run_benchmark 1000 "modular_cycle"

echo ""
echo "========================================================"
echo " All Performance Benchmarks Verified Successfully!"
echo "========================================================"
