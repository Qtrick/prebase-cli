#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Running full verification check..."

# 1. Rust formatting & lints
echo "--> Checking Rust code format..."
cargo fmt --all -- --check

echo "--> Checking Clippy lints across workspace..."
cargo clippy --workspace --all-targets -- -D warnings

echo "--> Running Rust test suite..."
cargo test --workspace

# 2. Frontend tests and build
echo "--> Running Frontend unit tests..."
cd "$ROOT_DIR/frontend"
npm test

echo "--> Verifying Frontend TypeScript build..."
npm run build
cd "$ROOT_DIR"

echo "==> All verification checks PASSED!"

