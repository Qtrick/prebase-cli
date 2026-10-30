#!/usr/bin/env bash
set -euo pipefail

echo "==> Building PreBase CLI (Frontend + Release Binary)..."

# 1. Build frontend distribution
echo "--> Compiling React frontend..."
cd "$(dirname "$0")/../frontend"
npm install
npm run build

# 2. Build Rust release binary
echo "--> Compiling Rust workspace in release mode..."
cd ..
cargo build --release --bin prebase

echo "==> Build successful! Executable is located at: target/release/prebase"

