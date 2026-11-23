#!/usr/bin/env bash
set -euo pipefail

# PreBase CLI — Build and Installation Script
# Supports:
#   ./scripts/build.sh                   (build only: frontend + release binary)
#   ./scripts/build.sh --install         (build + install standalone binary)
#   ./scripts/build.sh --link            (build + create/update development symlink)
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
BIN_DIR=""
PREFIX=""
BUILD_FRONTEND=true

usage() {
  cat <<'EOF'
PreBase CLI — Build & Installation Utility

Usage:
  scripts/build.sh [OPTIONS]

Modes:
  (default)           Build frontend distribution and Rust release binary without installing
  --install           Build and install the release binary to user bin directory
  --link              Build and create/update a development symlink to target/release/prebase

Directory Options:
  --bin-dir <DIR>     Exact destination directory for the executable (installs to <DIR>/prebase).
                      Example: --bin-dir /usr/local/bin
  --prefix <PREFIX>   Root prefix directory (installs to <PREFIX>/bin/prebase).
                      Example: --prefix /usr/local (installs to /usr/local/bin/prebase)

Build Flags:
  --skip-frontend     Skip compiling frontend distribution (use existing embedded assets)
  -h, --help          Display this help message and exit

Environment Variables:
  PREBASE_BIN_DIR     Default destination directory for executable (overrides default, overridden by flags)
  PREBASE_PREFIX      Default root prefix (overrides default, overridden by flags)

Default target directory: $HOME/.local/bin
EOF
  exit 0
}

# Parse command line options
while [[ $# -gt 0 ]]; do
  case "$1" in
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
      BUILD_FRONTEND=false
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

# Expand tilde in directory paths if passed quoted
if [[ -n "$BIN_DIR" ]]; then
  BIN_DIR="${BIN_DIR/#\~/$HOME}"
fi
if [[ -n "$PREFIX" ]]; then
  PREFIX="${PREFIX/#\~/$HOME}"
fi

# Determine target directory
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

echo "==> Building PreBase CLI (Frontend + Release Binary)..."

# 1. Build frontend distribution
if [[ "$BUILD_FRONTEND" == "true" ]]; then
  echo "--> Compiling React frontend with lockfile-driven reproducibility..."
  cd "$ROOT_DIR/frontend"
  if [[ ! -d "node_modules" ]]; then
    echo "    Installing frontend dependencies..."
    if [[ -f "package-lock.json" ]]; then
      npm ci
    else
      npm install
    fi
  fi
  npm run build
else
  echo "--> Skipping frontend compilation (--skip-frontend specified)..."
fi

# 2. Build Rust release binary
echo "--> Compiling Rust workspace in release mode..."
cd "$ROOT_DIR"
cargo build --release --locked --bin prebase

BIN_SRC="$ROOT_DIR/target/release/prebase"
if [[ ! -f "$BIN_SRC" ]]; then
  echo "Error: Release binary not found at $BIN_SRC" >&2
  exit 1
fi

echo "==> Build successful! Executable is located at: $BIN_SRC"

# If build only, exit cleanly
if [[ "$MODE" == "build" ]]; then
  echo ""
  echo "To install to your bin directory, run:  ./scripts/build.sh --install"
  echo "To create a development symlink, run: ./scripts/build.sh --link"
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
  trap 'rm -f "$TMP_FILE" 2>/dev/null || true' EXIT INT TERM

  cp "$BIN_SRC" "$TMP_FILE"
  chmod 755 "$TMP_FILE"

  # Remove existing symlink if present to prevent dereferencing
  if [[ -L "$TARGET_BIN" ]]; then
    rm -f "$TARGET_BIN"
  fi

  mv -f "$TMP_FILE" "$TARGET_BIN"
  trap - EXIT INT TERM

elif [[ "$MODE" == "link" ]]; then
  echo "==> Creating development symlink in $DEST_DIR..."
  TMP_LINK="$DEST_DIR/.prebase.link.tmp.$$"
  trap 'rm -f "$TMP_LINK" 2>/dev/null || true' EXIT INT TERM

  ln -s "$BIN_SRC" "$TMP_LINK"

  # Remove existing symlink if present to prevent dereferencing
  if [[ -L "$TARGET_BIN" ]]; then
    rm -f "$TARGET_BIN"
  fi

  mv -f "$TMP_LINK" "$TARGET_BIN"
  trap - EXIT INT TERM
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
  echo "✔ PreBase development symlink successfully created:"
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
