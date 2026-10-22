#!/bin/sh
# Rebuilds ../df3.wasm: DeepFilterNet3 with its model compiled in, no JS glue needed.
# Only needed after changing this crate; the built file is committed (the Docker build has no Rust).
#   rustup target add wasm32-unknown-unknown
#   packages/denoise/wasm/build.sh
# Cargo.lock comes from DeepFilterNet itself: newer tract versions do not build with its ndarray.
set -eu
cd "$(dirname "$0")"
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --locked --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/df3_wasm.wasm ../df3.wasm
ls -l ../df3.wasm
