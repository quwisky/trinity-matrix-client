#!/bin/sh
# Builds libtrinity_crypto.so into the Android app's debug source set (never release).
# Usage: native/crypto/build-android.sh [abi ...]   default: x86_64, the emulator.
# Needs: `rustup target add <target>` per ABI, `cargo install cargo-ndk`, and an NDK
# (ANDROID_NDK_HOME, or one under $ANDROID_HOME/ndk).
set -eu
cd "$(dirname "$0")"
[ $# -gt 0 ] || set -- x86_64
targets=""
for abi in "$@"; do targets="$targets -t $abi"; done
# shellcheck disable=SC2086 # one -t flag per ABI
cargo ndk $targets -P 24 -o ../../android/app/src/debug/jniLibs \
  build --release --locked --lib --features jni
