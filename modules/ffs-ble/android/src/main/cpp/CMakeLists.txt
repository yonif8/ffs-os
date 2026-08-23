cmake_minimum_required(VERSION 3.22.1)

# ffslc3 — the native half of the S-VOICE audio pipeline.
#
# One SHARED library: our JNI shim (ffs_lc3_jni.c) plus the vendored google/liblc3 C sources.
# We compile upstream's .c files directly rather than add_subdirectory()'ing upstream's own
# CMakeLists, so the build stays standalone and a re-vendor cannot drag in build logic, an
# install() rule, or a target name we did not ask for.
#
# The host fixture harness (ffs_os/tools/lc3fixture) compiles the SAME third_party sources, so a
# green host run is real evidence about this library's codec, not about a second copy.

project(ffslc3 C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(LC3_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/liblc3)

set(LC3_SOURCES
        ${LC3_DIR}/liblc3/attdet.c
        ${LC3_DIR}/liblc3/bits.c
        ${LC3_DIR}/liblc3/bwdet.c
        ${LC3_DIR}/liblc3/energy.c
        ${LC3_DIR}/liblc3/lc3.c
        ${LC3_DIR}/liblc3/ltpf.c
        ${LC3_DIR}/liblc3/mdct.c
        ${LC3_DIR}/liblc3/plc.c
        ${LC3_DIR}/liblc3/sns.c
        ${LC3_DIR}/liblc3/spec.c
        ${LC3_DIR}/liblc3/tables.c
        ${LC3_DIR}/liblc3/tns.c
)

add_library(ffslc3 SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/ffs_lc3_jni.c
        ${LC3_SOURCES}
)

include_directories(${LC3_DIR}/include)

# Upstream sources also #include their siblings by bare name.
target_include_directories(ffslc3 PRIVATE
        ${LC3_DIR}/include
        ${LC3_DIR}/liblc3
)

# -O3 only, deliberately: no -ffast-math (it perturbs the codec's float paths, and the host
# fixture must be able to reproduce on-device output bit-for-bit-ish), and no -fvisibility=hidden
# (JNIEXPORT marks the entry points default-visible, but there is no upside to relying on it here).
target_compile_options(ffslc3 PRIVATE -O3)

# Vendored code is not ours to lint; keep our own warnings loud without failing on upstream.
set_source_files_properties(${CMAKE_CURRENT_SOURCE_DIR}/ffs_lc3_jni.c
        PROPERTIES COMPILE_OPTIONS "-Wall;-Wextra")

find_library(log-lib log)
target_link_libraries(ffslc3 ${log-lib})
