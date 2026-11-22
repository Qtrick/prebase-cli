#!/usr/bin/env bash
set -euo pipefail

# PreBase CLI — User Installation Script
# Installs the prebase binary to $HOME/.local/bin (or a custom --prefix)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREBASE_PREFIX:-$HOME/.local/bin}"

# Parse optional --prefix argument
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      shift 1
      ;;
    -h|--help)
      echo "Usage: scripts/install.sh [--prefix <DIR>]"
      echo ""
      echo "Installs prebase executable to a directory in your PATH (default: \$HOME/.local/bin)."
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: scripts/install.sh [--prefix <DIR>]" >&2
      exit 1
      ;;
  esac
done

echo "==> Building PreBase release binary..."
cd "$ROOT_DIR"
cargo build --release --locked --bin prebase

BIN_SRC="$ROOT_DIR/target/release/prebase"
if [[ ! -f "$BIN_SRC" ]]; then
  echo "Error: Release binary not found at $BIN_SRC" >&2
  exit 1
fi

echo "==> Installing prebase to $PREFIX..."
mkdir -p "$PREFIX"
cp "$BIN_SRC" "$PREFIX/prebase"
chmod 755 "$PREFIX/prebase"

echo "==> Verifying installation..."
"$PREFIX/prebase" --version

echo ""
echo "✔ PreBase successfully installed to: $PREFIX/prebase"

# Check if PREFIX is in user's PATH
if [[ ":$PATH:" != *":$PREFIX:"* ]]; then
  echo ""
  echo "Notice: $PREFIX is not currently in your PATH."
  echo "To make 'prebase' invokable from any directory, add this line to your shell configuration file (~/.zshrc or ~/.bashrc):"
  echo ""
  echo "  export PATH=\"$PREFIX:\$PATH\""
  echo ""
fi
