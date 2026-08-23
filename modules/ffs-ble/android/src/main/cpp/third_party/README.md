# `third_party/` — vendored native code

## `liblc3/`

**What this is.** [google/liblc3](https://github.com/google/liblc3) — the reference C
implementation of the Bluetooth SIG **LC3** codec (Low Complexity Communication Codec). We need it
because the G2 glasses notify microphone audio as LC3: 16 kHz mono, 10 ms frames, 40 bytes per
frame, **five frames per 205-byte BLE packet** (see `voice/VoiceFormat.kt`).

**License.** Apache License 2.0, Copyright 2022 Google LLC. Full text in `liblc3/LICENSE`; every
source file keeps its original Apache header. Nothing here may be relicensed.

**Provenance.** Lifted from the vendored copy inside the MentraOS `bluetooth-sdk` Android module
(`mobile/modules/bluetooth-sdk/android/lc3Lib/src/main/cpp/liblc3`), which is itself an unmodified
drop of upstream google/liblc3.

**What was taken.** The **C codec only** — `include/lc3.h`, `include/lc3_private.h` and
`liblc3/*.c` + `liblc3/*.h` (attdet, bits, bwdet, energy, lc3, ltpf, mdct, plc, sns, spec, tables,
tns, plus the `*_arm.h` / `*_neon.h` intrinsic headers, `common.h`, `fastmath.h`). Both the
**decoder and the encoder** are included: the decoder is the product, the encoder is what lets a
host fixture tool and an on-device self-test round-trip audio without ever touching a real
recording.

**What was deliberately NOT taken.**
- `liblc3.cpp` — MentraOS's own JNI shim. Ours is `../ffs_lc3_jni.c`, written from scratch.
- `rnnoise/` and `include/rnnoise.h` — noise suppression, not needed.
- `google_opus_stuff/` — Opus/Ogg, not needed.
- Upstream's `CMakeLists.txt` / `meson.build` / `makefile.mk` — the parent `../CMakeLists.txt`
  compiles the `.c` files directly, so there is no `add_subdirectory` into upstream build logic.

**Modifications.** None to the code. The only change made during vendoring was normalising line
endings to **LF** (the MentraOS working copy had CRLF), to match this repo's convention. Do not
hand-patch these files: if a fix is needed, take it from upstream and note it here.

**Re-vendoring.** Copy `include/*.h` and `liblc3/*.c|*.h` from upstream, normalise to LF, leave the
Apache headers alone, and re-run `ffs_os/tools/lc3fixture/build.sh` — the host harness compiles the
exact same sources, so it is the fastest way to prove a re-vendor still decodes correctly.
