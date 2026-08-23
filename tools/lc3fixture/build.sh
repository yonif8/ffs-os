#!/usr/bin/env bash
# Build the host fixture harness with mingw-w64 + cmake (Git Bash on Windows).
#
#   bash build.sh          configure + build into ./out/build
#   bash build.sh clean    wipe ./out/build first
#
# Requires mingw-w64 gcc and cmake on PATH. There is no clang on this box, by design.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="$here/out/build"

if [ "${1:-}" = "clean" ]; then
    rm -rf "$build"
fi

mkdir -p "$build"
cmake -S "$here" -B "$build" -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build" -j

echo
echo "built:"
ls -1 "$build"/mkfixture.exe "$build"/checkfixture.exe 2>/dev/null || ls -1 "$build"/mkfixture "$build"/checkfixture
