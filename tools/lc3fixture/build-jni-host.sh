#!/usr/bin/env bash
# Build the JNI shim as a HOST library (ffslc3.dll on Windows / libffslc3.so elsewhere), so a
# plain-JVM unit test on a dev box can drive the REAL liblc3 instead of a fake.
#
#   bash build-jni-host.sh
#     -> ffs_os/tools/lc3fixture/out/ffslc3.dll        (gitignored)
#
# Load it from a test with:
#     -Dffs.lc3.library=<absolute path to the .dll>
# NativeLc3Decoder falls back to System.load() on that property when System.loadLibrary("ffslc3")
# finds nothing, which is exactly the desk case. On device nothing changes: the .so comes from the
# APK via CMake.
#
# The JDK matters: the Gradle test JVM is 17, so we compile against JDK 17's jni.h by default.
# Override with JAVA_HOME_FOR_JNI=... if you need a different one. (jni.h is ABI-stable across
# these versions, but matching the test JVM removes the question.)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cpp="$here/../../modules/ffs-ble/android/src/main/cpp"
out="$here/out"
lc3="$cpp/third_party/liblc3"

jdk="${JAVA_HOME_FOR_JNI:-C:/Program Files/Eclipse Adoptium/jdk-17.0.20.8-hotspot}"
if [ ! -f "$jdk/include/jni.h" ]; then
    echo "build-jni-host.sh: no jni.h under $jdk — set JAVA_HOME_FOR_JNI" >&2
    exit 1
fi

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) libname="ffslc3.dll"; jnimd="win32" ;;
    Darwin)               libname="libffslc3.dylib"; jnimd="darwin" ;;
    *)                    libname="libffslc3.so"; jnimd="linux" ;;
esac

mkdir -p "$out"

gcc -shared -O2 -fPIC \
    -o "$out/$libname" \
    "$cpp/ffs_lc3_jni.c" \
    "$lc3/liblc3/attdet.c" "$lc3/liblc3/bits.c" "$lc3/liblc3/bwdet.c" \
    "$lc3/liblc3/energy.c" "$lc3/liblc3/lc3.c" "$lc3/liblc3/ltpf.c" \
    "$lc3/liblc3/mdct.c" "$lc3/liblc3/plc.c" "$lc3/liblc3/sns.c" \
    "$lc3/liblc3/spec.c" "$lc3/liblc3/tables.c" "$lc3/liblc3/tns.c" \
    -I "$lc3/include" -I "$lc3/liblc3" \
    -I "$jdk/include" -I "$jdk/include/$jnimd" \
    -lm

echo "built $out/$libname"
echo
echo "use it with:  -Dffs.lc3.library=$(cygpath -w "$out/$libname" 2>/dev/null || echo "$out/$libname")"
