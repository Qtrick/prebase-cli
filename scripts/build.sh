#!/usr/bin/env bash
set -euo pipefail

# PreBase CLI — Build and Installation Script
# Supports:
#   ./scripts/build.sh                   (build only: frontend + release binary)
#   ./scripts/build.sh --dev             (fast incremental dev build: frontend + debug binary)
#   ./scripts/build.sh --install         (build + install standalone release binary)
#   ./scripts/build.sh --link            (build + create/update release symlink)
#   ./scripts/build.sh --dev --link      (build + create/update development symlink)
#
# Custom directories:
#   --bin-dir <DIR>      Exact destination directory for the executable (<DIR>/prebase)
#   --prefix <PREFIX>    Root prefix directory for installation (<PREFIX>/bin/prebase)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ORIGINAL_PATH="${PREBASE_CALLER_PATH:-$PATH}"

# Ensure toolchain paths (cargo, node, npm) are accessible for the build process
for tool_dir in "${CARGO_HOME:-$HOME/.cargo}/bin" "$HOME/.cargo/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
  if [[ -d "$tool_dir" && ":$PATH:" != *":$tool_dir:"* ]]; then
    PATH="$tool_dir:$PATH"
  fi
done

MODE="build"
PROFILE="release"
BIN_DIR=""
PREFIX=""
BUILD_FRONTEND=true
FORCE_FRONTEND=false

usage() {
  cat <<'EOF'
PreBase CLI — Build & Installation Utility

Usage:
  scripts/build.sh [OPTIONS]

Modes:
  (default)           Build frontend distribution and Rust release binary without installing
  --dev               Build using Cargo's fast incremental dev profile (target/debug/prebase)
  --install           Build and install the release binary to user bin directory
  --link              Build and create/update a symlink to the built binary
                      (target/release/prebase by default, or target/debug/prebase with --dev)

Directory Options:
  --bin-dir <DIR>     Exact destination directory for the executable (installs to <DIR>/prebase).
                      Example: --bin-dir /usr/local/bin
  --prefix <PREFIX>   Root prefix directory (installs to <PREFIX>/bin/prebase).
                      Example: --prefix /usr/local (installs to /usr/local/bin/prebase)

Build Flags:
  --skip-frontend     Skip compiling frontend distribution (use existing validated assets)
  --force-frontend    Bypass frontend freshness check and rebuild frontend assets
  -h, --help          Display this help message and exit

Environment Variables:
  PREBASE_BIN_DIR     Default destination directory for executable (overrides default, overridden by flags)
  PREBASE_PREFIX      Default root prefix (overrides default, overridden by flags)
  CARGO_TARGET_DIR    Optional Cargo target directory override

Default target directory: $HOME/.local/bin
EOF
  exit 0
}

# Parse command line options
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)
      PROFILE="dev"
      shift 1
      ;;
    --install)
      if [[ "$MODE" == "link" ]]; then
        echo "Error: Cannot specify both --install and --link." >&2
        exit 1
      fi
      MODE="install"
      shift 1
      ;;
    --link)
      if [[ "$MODE" == "install" ]]; then
        echo "Error: Cannot specify both --install and --link." >&2
        exit 1
      fi
      MODE="link"
      shift 1
      ;;
    --bin-dir)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: --bin-dir requires a directory argument." >&2
        exit 1
      fi
      if [[ -n "$PREFIX" ]]; then
        echo "Error: Cannot specify both --bin-dir and --prefix." >&2
        exit 1
      fi
      BIN_DIR="$2"
      shift 2
      ;;
    --bin-dir=*)
      if [[ -n "$PREFIX" ]]; then
        echo "Error: Cannot specify both --bin-dir and --prefix." >&2
        exit 1
      fi
      BIN_DIR="${1#*=}"
      shift 1
      ;;
    --prefix)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: --prefix requires a directory argument." >&2
        exit 1
      fi
      if [[ -n "$BIN_DIR" ]]; then
        echo "Error: Cannot specify both --bin-dir and --prefix." >&2
        exit 1
      fi
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      if [[ -n "$BIN_DIR" ]]; then
        echo "Error: Cannot specify both --bin-dir and --prefix." >&2
        exit 1
      fi
      PREFIX="${1#*=}"
      shift 1
      ;;
    --skip-frontend|--no-frontend)
      if [[ "$FORCE_FRONTEND" == "true" ]]; then
        echo "Error: Cannot specify both --skip-frontend and --force-frontend." >&2
        exit 1
      fi
      BUILD_FRONTEND=false
      shift 1
      ;;
    --force-frontend)
      if [[ "$BUILD_FRONTEND" == "false" ]]; then
        echo "Error: Cannot specify both --skip-frontend and --force-frontend." >&2
        exit 1
      fi
      FORCE_FRONTEND=true
      shift 1
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run 'scripts/build.sh --help' for usage." >&2
      exit 1
      ;;
  esac
done

if [[ "$PROFILE" == "dev" && "$MODE" == "install" ]]; then
  echo "Error: --install packages a standalone release binary and cannot be combined with --dev. Use --dev --link instead." >&2
  exit 1
fi

# Expand tilde in directory paths if passed quoted
if [[ -n "$BIN_DIR" ]]; then
  BIN_DIR="${BIN_DIR/#\~/$HOME}"
fi
if [[ -n "$PREFIX" ]]; then
  PREFIX="${PREFIX/#\~/$HOME}"
fi

# Determine destination directory
DEST_DIR=""
if [[ -n "$BIN_DIR" ]]; then
  DEST_DIR="$BIN_DIR"
elif [[ -n "$PREFIX" ]]; then
  DEST_DIR="$PREFIX/bin"
elif [[ -n "${PREBASE_BIN_DIR:-}" ]]; then
  DEST_DIR="${PREBASE_BIN_DIR/#\~/$HOME}"
elif [[ -n "${PREBASE_PREFIX:-}" ]]; then
  DEST_DIR="${PREBASE_PREFIX/#\~/$HOME}/bin"
else
  DEST_DIR="$HOME/.local/bin"
fi

# Resolve Cargo target directory
if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
  if [[ "$CARGO_TARGET_DIR" = /* ]]; then
    TARGET_ROOT="$CARGO_TARGET_DIR"
  else
    TARGET_ROOT="$ROOT_DIR/$CARGO_TARGET_DIR"
  fi
else
  TARGET_ROOT="$ROOT_DIR/target"
fi

DIST_DIR="$ROOT_DIR/crates/prebase-server/dist"
FRONTEND_DIR="$ROOT_DIR/frontend"
DEPS_STAMP="$FRONTEND_DIR/node_modules/.prebase-deps-stamp"
FRONTEND_STAMP="$TARGET_ROOT/.prebase-frontend-stamp"

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

compute_deps_hash() {
  local node_ver
  node_ver="$(node -v 2>/dev/null || echo 'unknown')"
  {
    printf 'node=%s\n' "$node_ver"
    printf 'package.json=%s\n' "$(sha256_file "$FRONTEND_DIR/package.json")"
    if [[ -f "$FRONTEND_DIR/package-lock.json" ]]; then
      printf 'package-lock.json=%s\n' "$(sha256_file "$FRONTEND_DIR/package-lock.json")"
    else
      printf 'package-lock.json=missing\n'
    fi
  } | sha256_stdin
}

compute_frontend_hash() {
  {
    for cfg in index.html package.json package-lock.json tsconfig.json vite.config.ts; do
      if [[ -f "$FRONTEND_DIR/$cfg" ]]; then
        printf '%s:%s\n' "$cfg" "$(sha256_file "$FRONTEND_DIR/$cfg")"
      fi
    done
    for sub in src public; do
      if [[ -d "$FRONTEND_DIR/$sub" ]]; then
        while IFS= read -r rel_file; do
          printf '%s:%s\n' "$rel_file" "$(sha256_file "$FRONTEND_DIR/$rel_file")"
        done < <(cd "$FRONTEND_DIR" && find "$sub" -type f ! -name '.DS_Store' | LC_ALL=C sort)
      fi
    done
  } | sha256_stdin
}

validate_dist_dir() {
  local dir="$1"
  if [[ -L "$dir" || ! -d "$dir" ]]; then
    return 1
  fi
  if [[ ! -s "$dir/index.html" ]]; then
    return 1
  fi
  # Reject any symlinks inside dist/
  if [[ -n "$(find "$dir" -type l -print -quit 2>/dev/null)" ]]; then
    return 1
  fi
  # Verify every local asset referenced by index.html exists and is non-empty
  local ref
  while IFS= read -r ref; do
    ref="${ref#/}"
    [[ -z "$ref" ]] && continue
    if [[ ! -s "$dir/$ref" ]]; then
      return 1
    fi
  done < <(grep -oE '(src|href)="(/[^"]+)"' "$dir/index.html" | sed -E 's/^(src|href)="([^"]+)"$/\2/' || true)
  return 0
}

STAGING_DIR=""
OLD_DIST_DIR=""
TMP_FILE=""
TMP_LINK=""
cleanup() {
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    rm -rf "$STAGING_DIR" 2>/dev/null || true
  fi
  if [[ -n "$OLD_DIST_DIR" && -d "$OLD_DIST_DIR" ]]; then
    rm -rf "$OLD_DIST_DIR" 2>/dev/null || true
  fi
  if [[ -n "$TMP_FILE" && -e "$TMP_FILE" ]]; then
    rm -f "$TMP_FILE" 2>/dev/null || true
  fi
  if [[ -n "$TMP_LINK" && ( -e "$TMP_LINK" || -L "$TMP_LINK" ) ]]; then
    rm -f "$TMP_LINK" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$PROFILE" == "dev" ]]; then
  echo "==> PreBase development build (incremental dev profile)..."
else
  echo "==> Building PreBase CLI (Frontend + Release Binary)..."
fi

# 1. Frontend dependencies & asset build
if [[ "$BUILD_FRONTEND" == "true" ]]; then
  cd "$FRONTEND_DIR"
  EXPECTED_DEPS_HASH="$(compute_deps_hash)"
  CURRENT_DEPS_HASH=""
  if [[ -f "$DEPS_STAMP" ]]; then
    CURRENT_DEPS_HASH="$(cat "$DEPS_STAMP" 2>/dev/null || true)"
  fi

  if [[ ! -d "node_modules" || ! -x "node_modules/.bin/vite" || "$CURRENT_DEPS_HASH" != "$EXPECTED_DEPS_HASH" ]]; then
    echo "--> Installing frontend dependencies..."
    if [[ -f "package-lock.json" ]]; then
      npm ci
    else
      npm install
    fi
    printf '%s\n' "$EXPECTED_DEPS_HASH" > "$DEPS_STAMP"
  fi

  EXPECTED_FE_HASH="$(compute_frontend_hash)"
  CURRENT_FE_HASH=""
  if [[ -f "$FRONTEND_STAMP" ]]; then
    CURRENT_FE_HASH="$(cat "$FRONTEND_STAMP" 2>/dev/null || true)"
  fi

  if [[ "$FORCE_FRONTEND" == "false" && "$CURRENT_FE_HASH" == "$EXPECTED_FE_HASH" ]] && validate_dist_dir "$DIST_DIR"; then
    echo "--> Frontend assets: current (skipping rebuild)"
  else
    echo "--> Frontend assets: building..."
    mkdir -p "$ROOT_DIR/crates/prebase-server" "$TARGET_ROOT"
    STAGING_DIR="$(mktemp -d "$ROOT_DIR/crates/prebase-server/.dist.staging.XXXXXX")"

    npm run typecheck
    npx vite build --outDir "$STAGING_DIR" --emptyOutDir

    if ! validate_dist_dir "$STAGING_DIR"; then
      echo "Error: Built frontend distribution failed validation (missing assets or symlink detected)." >&2
      exit 1
    fi

    if [[ -L "$DIST_DIR" ]]; then
      rm -f "$DIST_DIR"
    fi
    if [[ -d "$DIST_DIR" ]]; then
      OLD_DIST_DIR="$ROOT_DIR/crates/prebase-server/.dist.old.$$"
      mv "$DIST_DIR" "$OLD_DIST_DIR"
      mv "$STAGING_DIR" "$DIST_DIR"
      rm -rf "$OLD_DIST_DIR"
      OLD_DIST_DIR=""
    else
      mv "$STAGING_DIR" "$DIST_DIR"
    fi
    STAGING_DIR=""

    printf '%s\n' "$EXPECTED_FE_HASH" > "$FRONTEND_STAMP"
  fi
else
  echo "--> Frontend assets: skipped (--skip-frontend)"
  if ! validate_dist_dir "$DIST_DIR"; then
    echo "Error: --skip-frontend specified, but valid frontend assets were not found at $DIST_DIR." >&2
    echo "Run ./scripts/build.sh --dev (or ./scripts/build.sh) without --skip-frontend first." >&2
    exit 1
  fi
fi

# 2. Build Rust binary
cd "$ROOT_DIR"
if [[ "$PROFILE" == "dev" ]]; then
  echo "--> Rust: incremental dev build..."
  cargo build --locked --bin prebase
  BIN_SRC="$TARGET_ROOT/debug/prebase"
else
  echo "--> Rust: release build..."
  cargo build --release --locked --bin prebase
  BIN_SRC="$TARGET_ROOT/release/prebase"
fi

if [[ ! -f "$BIN_SRC" ]]; then
  echo "Error: Compiled binary not found at $BIN_SRC" >&2
  exit 1
fi

echo "==> Build successful: $BIN_SRC"

# If build only, exit cleanly
if [[ "$MODE" == "build" ]]; then
  if [[ "$PROFILE" == "dev" ]]; then
    echo "To link for development, run: ./scripts/build.sh --dev --link"
  else
    echo "To install to your bin directory, run:  ./scripts/build.sh --install"
    echo "To create a release symlink, run:      ./scripts/build.sh --link"
  fi
  exit 0
fi

# 3. Installation or Symlink Creation
if [[ -e "$DEST_DIR" && ! -d "$DEST_DIR" ]]; then
  echo "Error: Destination directory '$DEST_DIR' exists and is not a directory." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
DEST_DIR="$(cd "$DEST_DIR" && pwd)"
TARGET_BIN="$DEST_DIR/prebase"

if [[ -d "$TARGET_BIN" && ! -L "$TARGET_BIN" ]]; then
  echo "Error: Target destination '$TARGET_BIN' is an existing directory. Refusing to overwrite." >&2
  exit 1
fi

if [[ -e "$TARGET_BIN" && ! -f "$TARGET_BIN" && ! -L "$TARGET_BIN" ]]; then
  echo "Error: Target destination '$TARGET_BIN' is a special file (socket, FIFO, or device). Refusing to overwrite." >&2
  exit 1
fi

if [[ "$MODE" == "install" ]]; then
  echo "==> Installing prebase executable to $DEST_DIR..."
  TMP_FILE="$DEST_DIR/.prebase.tmp.$$"
  cp "$BIN_SRC" "$TMP_FILE"
  chmod 755 "$TMP_FILE"

  if [[ -L "$TARGET_BIN" ]]; then
    rm -f "$TARGET_BIN"
  fi

  mv -f "$TMP_FILE" "$TARGET_BIN"
  TMP_FILE=""

elif [[ "$MODE" == "link" ]]; then
  echo "==> Creating symlink in $DEST_DIR..."
  TMP_LINK="$DEST_DIR/.prebase.link.tmp.$$"
  ln -s "$BIN_SRC" "$TMP_LINK"

  if [[ -L "$TARGET_BIN" ]]; then
    rm -f "$TARGET_BIN"
  fi

  mv -f "$TMP_LINK" "$TARGET_BIN"
  TMP_LINK=""
fi

# 4. Verification
echo "==> Verifying executable..."
if [[ ! -x "$TARGET_BIN" ]]; then
  echo "Error: Installed binary '$TARGET_BIN' is not executable." >&2
  exit 1
fi

"$TARGET_BIN" --version

echo ""
if [[ "$MODE" == "link" ]]; then
  echo "✔ PreBase symlink successfully created:"
  echo "  $TARGET_BIN -> $BIN_SRC"
else
  echo "✔ PreBase successfully installed to:"
  echo "  $TARGET_BIN"
fi

# 5. PATH Verification and Shadowing Detection
check_path_and_shadowing() {
  local target="$1"
  local bin_dir="$2"
  local check_path="$3"
  local target_real
  local resolved
  local resolved_real=""
  local in_path=false

  target_real="$(cd "$(dirname "$target")" && pwd)/$(basename "$target")"

  IFS=':' read -ra PATH_ENTRIES <<< "$check_path"
  for entry in "${PATH_ENTRIES[@]}"; do
    if [[ -z "$entry" ]]; then entry="."; fi
    if [[ -d "$entry" ]]; then
      local entry_canon
      entry_canon="$(cd "$entry" 2>/dev/null && pwd || true)"
      if [[ "$entry_canon" == "$bin_dir" ]]; then
        in_path=true
        break
      fi
    elif [[ "$entry" == "$bin_dir" ]]; then
      in_path=true
      break
    fi
  done

  resolved="$(PATH="$check_path" command -v prebase 2>/dev/null || PATH="$check_path" which prebase 2>/dev/null || true)"

  if [[ -n "$resolved" ]]; then
    local res_dir
    res_dir="$(cd "$(dirname "$resolved")" 2>/dev/null && pwd || dirname "$resolved")"
    resolved_real="$res_dir/$(basename "$resolved")"
  fi

  if ! $in_path; then
    echo ""
    echo "Notice: '$bin_dir' is not currently in your PATH."
    echo "To make 'prebase' invokable from any directory, add this line to your shell configuration file:"
    echo ""
    echo "  For Zsh (~/.zshrc, default on macOS):"
    echo "    export PATH=\"$bin_dir:\$PATH\""
    echo ""
    echo "  For Bash (~/.bashrc):"
    echo "    export PATH=\"$bin_dir:\$PATH\""
    echo ""
    if [[ -n "$resolved" ]]; then
      echo "⚠️  Note: 'prebase' currently resolves to another executable ($resolved)."
      echo "Ensure '$bin_dir' is placed earlier in your PATH to invoke the newly installed version."
      echo ""
    fi
  elif [[ -z "$resolved" ]]; then
    echo ""
    echo "Notice: '$bin_dir' is in your PATH, but 'prebase' was not resolved."
    echo "You may need to restart your terminal or rehash command cache (hash -r in bash, rehash in zsh)."
    echo ""
  elif [[ "$resolved_real" != "$target_real" ]]; then
    echo ""
    echo "⚠️  Warning: PATH shadowing detected!"
    echo "The 'prebase' command resolves to another executable earlier in your PATH:"
    echo "  Active command:   $resolved"
    echo "  Installed target: $target"
    echo ""
    echo "When typing 'prebase', the system will execute '$resolved' instead of '$target'."
    echo "To resolve this shadowing:"
    echo "  1. Remove or rename the conflicting executable: $resolved"
    echo "  2. Or update your PATH in ~/.zshrc or ~/.bashrc so '$bin_dir' appears before '$(dirname "$resolved")':"
    echo "     export PATH=\"$bin_dir:\$PATH\""
    echo ""
  else
    echo "✔ PATH verified: 'prebase' resolves to $target"
  fi
}

check_path_and_shadowing "$TARGET_BIN" "$DEST_DIR" "$ORIGINAL_PATH"
