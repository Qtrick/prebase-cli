#!/usr/bin/env bash
set -euo pipefail

# PreBase CLI — User Installation Script
# Builds frontend assets and Rust release binary, then installs or links 'prebase'.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
PreBase CLI — User Installation Script

Usage:
  scripts/install.sh [OPTIONS]

Builds the frontend distribution, compiles the Rust release binary with embedded assets,
and installs 'prebase' to your user bin directory.

Options:
  --bin-dir <DIR>     Exact destination directory for the executable (installs to <DIR>/prebase).
                      Example: --bin-dir /usr/local/bin
  --prefix <PREFIX>   Root prefix directory (installs to <PREFIX>/bin/prebase).
                      Example: --prefix /usr/local (installs to /usr/local/bin/prebase)
  --link              Create or update a development symlink instead of copying the binary
  --skip-frontend     Skip compiling frontend distribution (use existing embedded assets)
  -h, --help          Show this help message and exit

Directory Distinction:
  --bin-dir <DIR>     Specifies the exact directory where the executable file will be placed.
  --prefix <PREFIX>   Specifies the root directory prefix, installing the executable into <PREFIX>/bin.

Default target directory: $HOME/.local/bin
EOF
  exit 0
}

# Check for help flag
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      ;;
  esac
done

# Check if user explicitly requested --link or --install
has_mode=false
for arg in "$@"; do
  if [[ "$arg" == "--link" || "$arg" == "--install" ]]; then
    has_mode=true
    break
  fi
done

if $has_mode; then
  exec "$ROOT_DIR/scripts/build.sh" "$@"
else
  exec "$ROOT_DIR/scripts/build.sh" --install "$@"
fi
