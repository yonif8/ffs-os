# `lc3fixture` — host harness for the S-VOICE audio pipeline

Two small C programs and a build script that let this desk answer, **with numbers**, the question
that decides whether the whole voice pipeline works:

> The glasses notify 205-byte packets. Are the 200 payload bytes **five 40-byte LC3 frames**, or
> one 200-byte frame?

They are five, through **one persistent decoder**. `checkfixture --wrong` does it the other way on
purpose so the two reports can sit side by side. The contrast is the evidence.

Everything here builds against the **same vendored liblc3** the Android library ships
(`modules/ffs-ble/android/src/main/cpp/third_party/liblc3`). There is no second copy of the codec,
so a green run here is evidence about the code that runs on the phone.

## Build

```bash
bash build.sh            # -> out/build/mkfixture.exe, out/build/checkfixture.exe
bash build.sh clean      # wipe first
```

Needs **mingw-w64 gcc + cmake** on PATH, from Git Bash. There is no clang on this box, deliberately.
`out/` is gitignored.

## Generate fixtures

```bash
mkdir -p out/fixtures && cd out/fixtures

../build/mkfixture --out fixture-speech --seconds 2.0

../build/mkfixture --out fixture-gaps --seconds 2.0 --no-ref \
    --drop 5,11,12,19,26,27,28,29,30,31,32,33,34,35
```

`mkfixture` writes, for prefix `P`:

- `P.g2a` — the raw 205-byte packet stream: `[200 B = 5 × 40 B LC3][ssr i16le][tdoa i16le][counter u8]`.
  Exactly what the phone archives as a session master.
- `P.ref.wav` — the **pre-encode** PCM, 16 kHz mono s16le. The ground truth. `--no-ref` skips it.
- `P.json` — manifest: parameters, packet count, per-packet counter/ssr/tdoa/present, sha256 of the `.g2a`.

`--drop a,b,c` omits those packet indices while the counter keeps advancing — precisely what the
firmware does when its tx queue is half full. Note that dropped packets are still **encoded**: the
encoder state has to advance as the glasses' would, or the frames after a hole would not be the
frames a real stream produces after that hole.

⛔ **The signal is synthetic and contains no human voice.** It is a deterministic swept-formant
glottal buzz with syllable gating and seeded noise — speech-*shaped* so LC3's pitch, formant and
concealment paths get exercised, and not speech, so the fixtures can live in a public repo. Same
seed, same bytes, forever.

## Check a fixture

```bash
../build/checkfixture fixture-speech.g2a --ref fixture-speech.ref.wav --out correct.wav
../build/checkfixture fixture-speech.g2a --ref fixture-speech.ref.wav --out wrong.wav --wrong
../build/checkfixture fixture-gaps.g2a   --ref fixture-speech.ref.wav --out gaps.wav
```

`checkfixture` is also the **reference implementation of the framing and gap rules** the Kotlin
`VoiceFramer` must match: assert 205 bytes, five frames per packet, one persistent decoder,
mod-256 counter deltas, `gap == 0` is the other lens's duplicate, small gaps get LC3 concealment
from the same decoder, a gap past `--max-conceal` (default 10 frames) is a resync whose remainder
is written as silence so the timeline stays true. Exit code is 0 on PASS, 1 on FAIL, so it works
as a gate and not only as something to read.

## What the numbers mean

| line | meaning |
|---|---|
| `sample ratio` | decoded samples ÷ reference samples. **1.000 = the timeline is intact.** The single loudest symptom of the one-frame misreading is 0.200 — five times too few samples. |
| `best lag` | where the decode lines up with the reference. A correct decode lands at **40 samples (2.5 ms)**: LC3's algorithmic delay. A wrong one lands wherever noise happens to correlate best. |
| `correlation` | Pearson correlation at that lag. Correct ≈ **0.98**. Garbage ≈ **0.04**. |
| `segmental SNR` | mean SNR over 20 ms voiced segments (silence skipped). Correct ≈ **13.5 dB**. Garbage ≈ **0 dB**. |
| `concealed frames` | frames synthesised by PLC. `lc3_decode` returns **1** for these — that is **valid audio, not an error**. |
| `silence frames` | audio genuinely lost to a gap too big to conceal. |
| `bar` / `VERDICT` | the pass bar slides with **measured** packet loss, because a fixture with holes cannot hit the lossless bar and should not be judged against it. `--wrong` loses nothing (it just misreads the frames), so it still faces the full bar — and fails it. |

### Measured, 2026-08-23, this vendored liblc3

| run | samples | ratio | lag | correlation | seg SNR | verdict |
|---|---|---|---|---|---|---|
| correct, clean fixture | 32000 | 1.000 | 40 (2.5 ms) | **0.9786** | **13.55 dB** | PASS |
| `--wrong` (200 B as one frame) | 6400 | 0.200 | 926 | **0.0415** | **−0.42 dB** | FAIL |
| correct, gaps fixture (14/40 lost) | 32000 | 1.000 | 40 (2.5 ms) | 0.7489 | 7.63 dB | PASS (degraded) |

The `--wrong` run is worth looking at closely: it does **not** error. `lc3_decode` happily accepts
200 as a frame size (20…400 is legal), returns 0 four fifths of the time, and hands back plausible
looking PCM at a fifth of the RMS. Nothing throws. That is exactly why this measurement exists —
the failure is silent, and only correlation against a known reference exposes it.

## Host JNI library (real decoder in plain-JVM tests)

```bash
bash build-jni-host.sh          # -> out/ffslc3.dll  (gitignored)
```

Builds `ffs_lc3_jni.c` + the vendored liblc3 into a **host** shared library against the JDK's
`jni.h` (JDK 17 by default, matching the Gradle test JVM; override with `JAVA_HOME_FOR_JNI`). A
plain JVM unit test then drives the **real** codec instead of a fake:

```
-Dffs.lc3.library=C:\...\ffs_os\tools\lc3fixture\out\ffslc3.dll
```

`NativeLc3Decoder` falls back to `System.load()` on that property when `System.loadLibrary("ffslc3")`
finds nothing — which is the desk case. On device nothing changes: the `.so` comes from the APK.

Verified on this box (JDK 17, mingw-w64 gcc 16.1.0 x86_64): the DLL loads, `NativeLc3Decoder`
decodes all 40 fixture packets to 32000 samples at RMS 0.04579 — **identical to the C harness** —
`concealFrame` returns 1, every out-of-bounds call returns a negative code instead of crashing, a
call after `close()` returns −10, and an encode→decode round trip through `NativeLc3Encoder`
reproduces the signal.
