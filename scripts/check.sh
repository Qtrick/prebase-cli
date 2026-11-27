#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Running full verification check..."

# 1. Shell script syntax
echo "--> Checking Shell script syntax..."
for script in scripts/*.sh; do
    bash -n "$script"
done

# 2. Frontend tests, typecheck, and build (populates embedded assets for prebase-server)
echo "--> Running Frontend unit tests..."
cd "$ROOT_DIR/frontend"
npm test

echo "--> Verifying Frontend TypeScript types..."
npm run typecheck

echo "--> Building Frontend bundle..."
npm run build:bundle
cd "$ROOT_DIR"

# 3. Rust formatting, lints, and tests
echo "--> Checking Rust code format..."
cargo fmt --all -- --check

echo "--> Checking Clippy lints across workspace..."
cargo clippy --workspace --all-targets --locked -- -D warnings

echo "--> Running Rust test suite..."
cargo test --workspace --locked

echo "==> All verification checks PASSED!"

