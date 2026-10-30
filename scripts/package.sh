#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(grep -m1 '^version = ' "$ROOT_DIR/Cargo.toml" | cut -d '"' -f2)
TARGET_DIR="$ROOT_DIR/target/release"
DIST_DIR="$ROOT_DIR/dist"

echo "==> Packaging PreBase CLI v${VERSION}..."

# Ensure binary is built
"$ROOT_DIR/scripts/build.sh"

mkdir -p "$DIST_DIR"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
PACKAGE_NAME="prebase-v${VERSION}-${OS}-${ARCH}"
PACKAGE_PATH="${DIST_DIR}/${PACKAGE_NAME}.tar.gz"

echo "--> Archiving ${PACKAGE_NAME}..."
tar -czf "$PACKAGE_PATH" -C "$TARGET_DIR" prebase

echo "--> Computing SHA256 checksum..."
if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$PACKAGE_PATH" > "${PACKAGE_PATH}.sha256"
elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$PACKAGE_PATH" > "${PACKAGE_PATH}.sha256"
fi

echo "==> Package created:"
echo "    Archive:  ${PACKAGE_PATH}"
echo "    Checksum: ${PACKAGE_PATH}.sha256"

