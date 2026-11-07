#!/usr/bin/env bash
set -euo pipefail

echo "==> Building PreBase CLI (Frontend + Release Binary)..."

# 1. Build frontend distribution
echo "--> Compiling React frontend with lockfile-driven reproducibility..."
cd "$(dirname "$0")/../frontend"
if [ -f package-lock.json ]; then
    npm ci
else
    npm install
fi
npm run build

# 2. Build Rust release binary
echo "--> Compiling Rust workspace in release mode..."
cd ..
cargo build --release --bin prebase

echo "==> Build successful! Executable is located at: target/release/prebase"

