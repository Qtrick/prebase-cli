#!/usr/bin/env bash
set -euo pipefail

# PreBase CLI — Fast Development Build & Launch Wrapper
# Builds only changed frontend/Rust components in dev mode, stops any stale
# background server for the target repository if the dev binary was rebuilt,
# and launches target/debug/prebase with all forwarded arguments.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

BUILD_ARGS=(--dev)
APP_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --force-frontend|--skip-frontend|--no-frontend)
      BUILD_ARGS+=("$arg")
      ;;
    *)
      APP_ARGS+=("$arg")
      ;;
  esac
done

"$ROOT_DIR/scripts/build.sh" "${BUILD_ARGS[@]}"

if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
  if [[ "$CARGO_TARGET_DIR" = /* ]]; then
    TARGET_ROOT="$CARGO_TARGET_DIR"
  else
    TARGET_ROOT="$ROOT_DIR/$CARGO_TARGET_DIR"
  fi
else
  TARGET_ROOT="$ROOT_DIR/target"
fi

BIN="$TARGET_ROOT/debug/prebase"

# Determine whether this invocation launches/reuses a server and which repo path it targets.
skip_stale_check=false
target_repo="."
for arg in "${APP_ARGS[@]+"${APP_ARGS[@]}"}"; do
  case "$arg" in
    -h|--help|-V|--version|status|stop|analyze|files|search|inspect|deps|dependents|path)
      skip_stale_check=true
      break
      ;;
    -*)
      ;;
    *)
      if [[ -d "$arg" ]]; then
        target_repo="$arg"
      fi
      ;;
  esac
done

if [[ "$skip_stale_check" == "false" ]] && command -v python3 >/dev/null 2>&1; then
  bin_mtime="$(stat -f %m "$BIN" 2>/dev/null || stat -c %Y "$BIN" 2>/dev/null || echo 0)"
  status_json="$("$BIN" status "$target_repo" --json 2>/dev/null || true)"
  if [[ -n "$status_json" ]]; then
    should_restart="$(
      python3 - "$status_json" "$bin_mtime" <<'PY' 2>/dev/null || echo "0"
import json, sys
try:
    data = json.loads(sys.argv[1])
    bin_mtime = int(sys.argv[2])
    sess = data.get("session") or {}
    if data.get("active") and int(sess.get("startup_time", 0)) < bin_mtime:
        print("1")
    else:
        print("0")
except Exception:
    print("0")
PY
    )"
    if [[ "$should_restart" == "1" ]]; then
      echo "--> Stopping stale PreBase server for '$target_repo' so the updated dev binary is used..."
      "$BIN" stop "$target_repo" >/dev/null 2>&1 || true
    fi
  fi
fi

echo "==> Launching development workspace..."
exec "$BIN" "${APP_ARGS[@]+"${APP_ARGS[@]}"}"
