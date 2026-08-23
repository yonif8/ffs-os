cmake_minimum_required(VERSION 3.22.1)

# Host-side S-VOICE fixture harness.
#
# Builds mkfixture + checkfixture against the SAME vendored liblc3 that ships in the Android
# library — there is no second copy of the codec, so a green run here is evidence about the code
# that actually runs on the phone.

project(lc3fixture C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# ../../modules/ffs-ble/android/src/main/cpp/third_party/liblc3
set(LC3_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../modules/ffs-ble/android/src/main/cpp/third_party/liblc3)
get_filename_component(LC3_DIR ${LC3_DIR} ABSOLUTE)

if(NOT EXISTS ${LC3_DIR}/include/lc3.h)
    message(FATAL_ERROR "vendored liblc3 not found at ${LC3_DIR} — see third_party/README.md")
endif()

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

add_library(lc3_static STATIC ${LC3_SOURCES})
target_include_directories(lc3_static PUBLIC ${LC3_DIR}/include PRIVATE ${LC3_DIR}/liblc3)
target_compile_options(lc3_static PRIVATE -O2)

add_executable(mkfixture mkfixture.c)
add_executable(checkfixture checkfixture.c)

foreach(tool mkfixture checkfixture)
    target_link_libraries(${tool} lc3_static)
    target_compile_options(${tool} PRIVATE -O2 -Wall -Wextra)
    if(NOT MSVC)
        target_link_libraries(${tool} m)
    endif()
endforeach()
