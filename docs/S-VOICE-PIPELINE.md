# S-VOICE — the phone-side pipeline (decode → archive → transcribe → search)

**Stream:** S-VOICE stage S4 (phone pipeline). **Scope of this document:** everything that happens
on the *phone*, from a 205-byte BLE notification to a sentence coming back out of a text search.
The on-glass half (opening the audio session, VAD, own-voice gating, the settings toggles) belongs
to sibling streams and is **not** described here beyond the hand-off point in §9.

**Status legend:** `[proven]` = observed working here · `[mapped]` = read out of code/firmware but
not run · `[hypothesis]` = reasoned, unverified.

---

## 1. What this is for

One sentence: **speak, and later find what you said by typing a few of its words.**

The wearer's decision (recorded in `ROADMAP.md`): capture **everyone nearby**, **keep everything**
permanently, transcribe in the **cloud** with a provider supplied later, and never silently drop
words. This document describes the machinery that honours that, and §10 says plainly what it means
for the people around the wearer.

## 2. The shape of the thing

```
  glasses ──ESS notify, 205 B, ~20/s──►  G2Central.onAudioPacket        (binder thread)
                                              │  copy, no decode here
                                              ▼
                                       VoicePipeline queue                (~100 pkts ≈ 5 s)
                                              │
                                              ▼
                                       decode thread ── VoiceFramer ──►  ONE persistent Lc3Decoder
                                              │            dedup/gap/PLC        (liblc3, JNI)
                            ┌─────────────────┴─────────────────┐
                            ▼                                   ▼
                 VoiceArchiveFiles                        VoiceAudioChunk
              master.g2a  (RAW 205-B packets)             (16 kHz mono s16 PCM)
              meta.json   (counts, ssr/tdoa, stats)              │
                            │                                    ▼
                            │                              SttQueue (durable, retrying)
                            │                                    │
                            │                                    ▼
                            │                        SttProvider  ← config-driven, NO provider
                            │                          · mock (tests)   chosen or hardcoded
                            │                          · http (generic REST)
                            ▼                                    ▼
                    re-decode any time            SqliteTranscriptIndex  (SQLite + FTS)
                    (deriveWav)                            │
                                                            ▼
                                                     search("…") → VoiceSearchHit
```

Two independent stores, on purpose:

* **the master** — the raw 205-byte packet stream, byte-for-byte what the glasses sent;
* **the index** — transcripts, searchable.

Everything else (WAV, uploads, transcripts) is *derived*, and can be regenerated from the master.

## 3. The packet, and the one mistake that costs days

```
205 bytes
  [0  ..199]  FIVE 40-byte LC3 frames — 16 kHz mono, 10 ms each → 50 ms of audio
  [200..201]  ssr   int16 LE — speech-presence / SNR proxy, computed ON-GLASS
  [202..203]  tdoa  int16 LE — 2-mic cross-correlation, 3 fractional bits
  [204]       counter u8     — mod-256, the ONLY loss signal on this pipe
```

⛔ **The 200 bytes are FIVE frames, not one.** Handing all 200 to a decoder as a single frame
produces *white noise* — that is the exact failure signature, and it is the single most expensive
mistake available in this feature. They are decoded through **one persistent decoder instance**
whose state carries across frames; a fresh decoder per packet is the second way to get noise.

`enc_len` is a firmware variable, so the code **asserts** the packet is 205 bytes rather than
trusting offset 200. A wrong-length packet is counted as malformed and dropped.

`ssr` and `tdoa` are computed on-glass and are **preserved into the archive**: a sibling stream
needs them for own-voice gating, and they are per-50 ms metadata worth keeping regardless.
`tdoa` is fixed-point with 3 fractional bits — divide by 8 for samples.

### ★ Which arm — and why the other one will waste your week

`[proven on hardware, 2026-08-23]` **Both arms notify, but they do not carry the same audio.** The
RIGHT arm's encoder runs and ships a perfectly healthy ~20 packets/s of **nothing**: over a real
run, speech and silence on it are statistically identical — rms 3274 vs 3260, zero-crossing rate
0.434 vs 0.442, flat spectrum, no pauses.

That is the nastiest possible failure mode, because *every counter looks right*. Packet rate,
lengths, counter continuity, `bad=0` — all green, and the audio decodes to noise. It is
indistinguishable from a decoder bug, and it is where somebody goes hunting through liblc3 for a
week.

So the pipeline **filters to the LEFT arm before anything else touches the packet**
(`VoiceService.captureSide`, default `"L"`). MentraOS subscribes the left arm, faceclaw drops the
right outright, and our own 3,281-packet archive was 100% side=L — three independent
implementations, one answer.

⚠️ This also **corrects an earlier assumption in this document**: the duplicate rule below was
written believing the two lenses were copies of one stream. They are not. If both arms reached the
framer, `gap == 0` would keep whichever notification won the race and speech would interleave with
noise at random. The side filter is a *filter*, not a dedup preference, and it has to come first.

⚠️ Still open: **we have not confirmed the left arm carries intelligible speech either** — only
that the right arm does not. §7's capture path exists to settle exactly that.

### Loss, which is normal

The firmware **silently drops** frames when its tx queue is half full, so gaps are expected and
are not a bug in this code. The counter is the only way to see them:

| counter gap | meaning | what the framer does |
|---|---|---|
| `0` | a counter we already have (a retransmit, or the other arm if the side filter is off) | drop, count `duplicates` |
| `1` | normal | decode the five frames |
| `2..8` | small loss | emit `(gap−1)×5` PLC frames (`lc3_decode(dec, NULL, 0, …)`) |
| `>8` | large loss | resync, count `resyncs` + `lostPackets`, do not conceal |

`lc3_decode` returning **`1` means PLC ran and the output is valid audio — not an error.**

## 4. Transport (already in place before this stream)

Audio does **not** ride sid `0x09` / the `aa21` command pipe. It is the separate **ESS** streaming
pipe: raw notify payloads, no G2 header, no CRC, no sid, no in-band sequence number.

`G2Central` already: subscribes `AUDIO_NOTIFY` (`00002760-08c2-11e1-9073-0e8ac72e6402`) on both
lenses, requests **MTU 247** and defers `discoverServices()` to `onMtuChanged` — without that, the
default ATT MTU of 23 shatters every 205-byte notification into 10+ fragments and the audio path
looks broken in a way that resembles a decoder bug. `G2MicStats` is the counts-only instrument for
"did packets arrive?".

The seam this stream plugs into is `G2Central.onAudioPacket: ((ByteArray, String) -> Unit)` — the
privacy-guarded diversion that keeps audio out of `onNotify`, out of the driver log, and off the
JS bridge.

## 5. The STT seam — deliberately empty

⛔ **No provider is chosen, named, or hardcoded anywhere in this tree.** What ships is:

* `SttProvider` / `SttRequest` / `SttResult` — the interface;
* a **mock** provider, deterministic, used by the tests (its `name` is `"mock"`, recorded on every
  segment it produces, so mock output can never later be mistaken for a real transcript);
* one **generic config-driven HTTP client** that most cloud STT REST endpoints fit without new
  code — endpoint, method, headers (this is where a key goes), query/body params, audio encoding,
  and a dotted path into the response JSON for the transcript.

Credentials and endpoint live in a JSON file in the app's private storage, written at runtime —
**never in source, never in a bundled asset, never in this public repo**. With no configuration,
the system runs in *archive-but-do-not-transcribe* mode: audio is still captured and kept, the
work queue accumulates, and the backlog drains when a provider is configured later.

What a real provider needs, as a checklist to be answered: **`docs/S-VOICE-STT-PROVIDER.md`**.

## 6. Why this archive shape

The **raw 205-byte packet stream is the master**, and that is a deliberate choice over storing WAV:

* it is **lossless with respect to what the glasses actually sent** — no decode decision is baked in;
* it preserves `ssr`/`tdoa`, which a decoded WAV throws away;
* it is **32.8 kbps ≈ 14 MB per hour of capture** — storage is a non-issue;
* if the frame parameters are ever refined, or a better decoder arrives, **everything can be
  re-decoded** rather than re-recorded, which is impossible for a conversation that already happened.

WAV (16 kHz/mono/s16le) is derived on demand for upload. Search runs on **SQLite with an FTS
virtual table** — it is already in Android, needs no dependency, gives ranked matching and
snippets, and a phone-lifetime archive of speech is comfortably within what it handles.

⛔ **Nothing auto-deletes.** There is no retention policy and no eviction anywhere in this
pipeline, by explicit decision. A failing upload stays pending forever rather than being dropped.

## 7. ★ Capturing real audio, and getting a WAV out

This is the gate everything else waits behind: **is there intelligible speech on the left arm?**
Counters cannot answer it — somebody has to listen. The path below is four adb commands.

⛔ **This turns on a microphone.** Capture is OFF until asked for, the broadcast receiver is only
registered on a **debuggable** build, and every sub-command has to be named explicitly. Only ever
record deliberate owner tests, and see §10.

```sh
PKG=com.futurefounders.glassesos
V="am broadcast -a com.futurefounders.ffs.VOICE -p $PKG"

# 1. start capturing (LEFT arm by default -- read the ★ note in §3 before passing --es side R)
adb shell $V --es cmd start

#    ... now have the glasses' mic opened and speak. Mic control is a payload, not this app.

# 2. watch it arrive -- counts only, no audio
#    ⚠️ Read the counters on the LOGCAT tag, not the JS log: every VOICE command mirrors its
#    reply to `FFSVOICE` natively, so it lands even when the React bundle is not running.
adb logcat -s FFSVOICE:V          # (leave this open in another shell)
adb shell $V --es cmd status

# 3. stop, then export the raw master + a decoded WAV where adb can reach them
adb shell $V --es cmd stop
adb shell $V --es cmd export

# 4. pull
adb pull /sdcard/Android/data/$PKG/files/voice-export/
```

`export` writes two files per session: `<id>.g2a` (the **raw 205-byte master** — lossless, keeps
`ssr`/`tdoa`, re-decodable forever) and `<id>.wav` (16 kHz mono, decoded on the phone by the same
liblc3 the pipeline uses). If the decoder failed to load you still get the `.g2a`, which is the
half that cannot be regenerated.

**To decode a `.g2a` on the dev box instead** — useful for a second opinion, and it prints a
quality report rather than just a file:

```sh
ffs_os/tools/lc3fixture/out/build/checkfixture <pulled>.g2a --out out.wav
```

### Reading the result honestly

`status` reports `captureSide`, `packets`, `duplicates`, `otherSidePackets`, `lostPackets`,
`concealedFrames`, `archiveOverruns`. Two properties of it worth knowing, both fixed 2026-08-23:

* it is **exact once the decode thread is idle** — the pipeline publishes a framer snapshot on
  drain-idle as well as every 20 packets, so polling `status` to decide "is it safe to pull?" is
  no longer racing a 20-packet lag;
* it **still reports the session's final numbers after `stop`** — the counts are frozen at
  teardown rather than reading zero, which is exactly when you want to read them.

Before concluding anything from the WAV:

* `packets ≈ 20 × seconds` and `otherSidePackets` of a similar order — both arms notified and the
  filter did its job. `otherSidePackets == 0` with a two-lens link means the side tag is wrong.
* `lostPackets` non-zero is **normal** — the firmware drops silently at a half-full tx queue; an
  ~8% shortfall was measured over a 52 s run.
* `archiveOverruns > 0` means the master itself has holes; treat the WAV as suspect.
* ⛔ A WAV that sounds like noise does **not** by itself convict the decoder. Check the arm first
  (§3), then re-run `checkfixture` on the synthetic fixture to confirm the decoder is sane, and
  only then suspect the decode.

⛔ **Neither the `.g2a` nor the `.wav` may ever be committed** — this repo is public. `.gitignore`
denies those file types outright and excepts only the synthetic fixtures.

## 8. What is actually verified, and how

Everything below was measured on the dev box against **synthetic** audio. No real microphone
packet has been through any of this. `[proven-synthetic]` is the honest tag.

### The decode reading, proven by contrast

`tools/lc3fixture` builds the *same* vendored liblc3 sources the Android library compiles, encodes
a deterministic speech-shaped signal, packs it into 205-byte packets, and decodes it back:

| run | samples | correlation vs reference | seg SNR |
|---|---|---|---|
| **correct** — five 40-byte frames, one persistent decoder | 32000 | **0.9786** | **13.55 dB** |
| **wrong** — 200 B handed over as one frame | 6400 | **0.0415** | −0.42 dB |
| gaps fixture, 14 of 40 packets dropped | 32000 | 0.7489 | 7.63 dB |

⚠️ **The wrong path does not error.** `lc3_decode` accepts 200 as a legal frame size and returns
success on most calls, handing back plausible-looking PCM at a fifth of the amplitude. Nothing
throws, nothing logs. Only the correlation and the 5×-short sample count expose it — which is
precisely why the contrast, and not just the happy path, is the evidence worth keeping.

### The rest

`./gradlew :ffs-ble:testDebugUnitTest` — **214 tests, 0 failures, 0 skipped** (measured
2026-08-23), covering: the
205-byte length assertion; signed little-endian `ssr`/`tdoa` including negatives; counter
wraparound at 256; both-lens duplicate rejection in either arrival order; a 3-packet gap producing
10 PLC frames; a 20-packet gap resyncing; queue overrun evicting the oldest and counting it;
decoder-lifecycle and thread cleanup; a byte-exact WAV header; `master.g2a` round-trip including
torn-tail repair; the generic HTTP STT client against a real loopback socket; SQLite FTS search
against injection-shaped queries; and the headline **speak → search → find** path end to end
through the mock provider.

★ Added 2026-08-23 (`VoiceTailClipTest`): **a session shorter than the clip ceiling still
produces a transcript.** The clipper used to cut a clip only when its buffer filled (20 s) or
after 20 consecutive quiet packets, and nothing flushed the remainder at `stop` — so a 2 s
session, which is what most real ones are, was archived as perfectly good audio and transcribed
as *nothing*, silently. That reads as a flaky STT provider rather than a clipping bug, which is
the expensive way to find it. `stop` now flushes the tail, still linked to its session id.

The same file also covers **the pull step** (`export puts the raw master and a wav where adb
pull can reach them`): `exportSession` writes `<external files>/voice-export/<id>.g2a`
byte-identical to what was archived, plus a decoded `<id>.wav` of the expected length. That is
the last link in §7's chain a test can reach — everything after it is `adb pull`.

Two independent implementations agree on the framing: the C harness and the Kotlin framer both
read the fixtures' counters, `ssr` and `tdoa` and reach the same numbers, and on the gaps fixture
the Kotlin framer recovers exactly the 14 lost packets from byte 204 alone.

### Rebuilding the evidence

```sh
bash ffs_os/tools/lc3fixture/build.sh          # host harness (mingw-w64 + cmake)
ffs_os/tools/lc3fixture/out/build/checkfixture …  # the correlation report, and --wrong for contrast
bash ffs_os/tools/lc3fixture/build-jni-host.sh # host DLL, so the JVM tests get the REAL codec
cd ffs_os/android && ./gradlew :ffs-ble:testDebugUnitTest
```

⚠️ `--tests` is not accepted on `:ffs-ble:test` (an aggregate task) — use `testDebugUnitTest`.

## 9. Hand-off with the AUDIO stream

This stream is desk-only by construction and is verified against **synthetic** LC3 frames. The
boundary is exact:

| owned here | owned by the AUDIO / on-glass streams |
|---|---|
| everything downstream of `G2Central.onAudioPacket` | opening and closing the audio session on the glasses |
| decode, gap/PLC, dedup, archive, STT, search | VAD, own-voice gating, the settings toggles |
| the 205-byte format contract | producing real 205-byte packets from a real microphone |

**To join them:** call `onAudioPacket` with real packets. Nothing else changes — and as of
2026-08-23 that seam is wired: `FfsBleModule` hands it to `VoiceService.submit`, and §7 is the
adb path from "mic is open" to a WAV on the dev box.

This matters because the on-glass routes to the audio bytes are dead ends: the 205-byte frame is
built on the **stack** of `SVC_PcmAppProcessData` (no fixed address to poll), PC-side BLE cannot
see the lenses while the phone holds the pair, and HCI snoop is unavailable on this phone. The ESS
notification the phone already receives is the only place the real frames are reachable — so the
phone side is not a convenience here, it is the shortest path to the whole feature's hardest gate.

The first real capture should be read against §7's checklist — packet count, `otherSidePackets`,
counter continuity, concealment — *before* anyone listens to the WAV, so a bad number is caught
before an ear is used as an instrument.

## 10. What a reasonable person would want to know

This feature **records everyone near the wearer, continuously, and keeps it forever.** That is the
device owner's explicit and informed decision, and it is written down here so it can never be an
accident.

* **The raw archive stays on the phone.** It is written to the app's private storage and is not
  uploaded anywhere as a whole.
* **What leaves the device** is audio clips sent to whatever STT endpoint the owner configures, and
  nothing else. With no provider configured, nothing leaves at all.
* **No telemetry, no analytics.** Audio, PCM, base64 of either, and transcript text never enter a
  log line and never cross the JS bridge — the log pipe on this project ships to a collector on the
  dev box, and a transcript is just the recording, smaller. What may be logged is counts and
  milliseconds.
* **Third parties near the wearer have not consented** to being recorded or to having their speech
  sent to a cloud service. Local law on that varies and in several places it is not a grey area.

## 11. Files

| file | what it is |
|---|---|
| `modules/ffs-ble/android/src/main/java/expo/modules/ffsble/voice/VoiceFormat.kt` | the 205-byte format constants |
| `…/voice/VoiceContracts.kt` | shared types: `VoicePacket`, `Lc3Decoder`, `TranscriptIndex`, `SttProvider` |
| `…/voice/VoiceFramer.kt` | pure dedup / gap / PLC / resync logic |
| `…/voice/VoicePipeline.kt` | the queue and the one decode thread |
| `…/voice/VoiceArchiveFiles.kt` | `master.g2a` + `meta.json`, and re-decode |
| `…/voice/VoiceService.kt` | the assembly: side filter, session lifecycle, clipping, export |
| `…/voice/NativeLc3Decoder.kt` | liblc3 through JNI, one instance per stream |
| `…/voice/Stt*.kt` | the provider seam, config, durable upload queue |
| `…/voice/SqliteTranscriptIndex.kt` | the permanent searchable index |
| `modules/ffs-ble/android/src/main/cpp/` | the JNI shim + vendored liblc3 (Apache-2.0) |
| `tools/lc3fixture/` | host-side fixture generator and decode checker |
| `docs/S-VOICE-STT-PROVIDER.md` | the provider checklist |

## 12. Supersedes

`legacy/sdk/mic.ts` documents the **old** push-to-talk mic contract, including "NO PERSISTENCE" and
a 30 s session ceiling. S-VOICE deliberately replaces both: capture is continuous and the archive
is permanent. That file's *packet layout* and *privacy-against-logging* rules still hold; its
session policy does not. Its note that `[200..203]` is "not interpreted by any known
implementation" is superseded by the `ssr`/`tdoa` reading above.
