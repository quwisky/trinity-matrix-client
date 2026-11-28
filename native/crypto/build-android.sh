#!/bin/sh
# Builds libtrinity_crypto.so for the Android app. The app's Gradle build runs this (task
# buildNativeCrypto); run it by hand only to check a cross-build.
# Usage: native/crypto/build-android.sh <output dir> [abi ...]   default ABIs: the four the app ships.
# Needs: Rust with `rustup target add <target>` per ABI, `cargo install cargo-ndk`, and an NDK
# (ANDROID_NDK_HOME, or one under $ANDROID_HOME/ndk). See platforms/android.md.
set -eu
[ $# -gt 0 ] || { echo 'usage: build-android.sh <output dir> [abi ...]' >&2; exit 64; }
out=$1
shift
case "$out" in /*) ;; *) out="$(pwd)/$out" ;; esac
cd "$(dirname "$0")"
[ $# -gt 0 ] || set -- arm64-v8a armeabi-v7a x86 x86_64
missing() {
  echo "native crypto: $1" >&2
  echo 'Native end-to-end encryption is on by default for Android builds. Install the toolchain' >&2
  echo '(platforms/android.md, "Native crypto toolchain"), or build a WASM-only app with' >&2
  echo '-PtrinityNativeCrypto=false (or TRINITY_NATIVE_CRYPTO=0).' >&2
  exit 1
}
command -v cargo > /dev/null || missing 'cargo is not on PATH'
cargo ndk --version > /dev/null 2>&1 || missing 'cargo-ndk is not installed (cargo install cargo-ndk --locked)'
targets=""
for abi in "$@"; do
  case "$abi" in
    arm64-v8a) triple=aarch64-linux-android ;;
    armeabi-v7a) triple=armv7-linux-androideabi ;;
    x86) triple=i686-linux-android ;;
    x86_64) triple=x86_64-linux-android ;;
    *) missing "unknown ABI $abi" ;;
  esac
  rustup target list --installed 2> /dev/null | grep -qx "$triple" ||
    missing "the Rust target $triple is not installed (rustup target add $triple)"
  targets="$targets -t $abi"
done
# shellcheck disable=SC2086 # one -t flag per ABI
cargo ndk $targets -P 24 -o "$out" build --release --locked --lib --features jni
