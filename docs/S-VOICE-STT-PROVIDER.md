# S-VOICE — plugging in a real speech-to-text provider

**Status:** the seam is built and proven; **no provider is chosen.** Nothing in the codebase
names, defaults to, or branches on a vendor. This document is the checklist that turns "we
should use X" into a working config file.

**Where the code is:**
`ffs_os/modules/ffs-ble/android/src/main/java/expo/modules/ffsble/voice/`
— `SttConfig.kt`, `SttConfigStore.kt`, `SttProviderFactory.kt`, `MockSttProvider.kt`,
`HttpSttProvider.kt`, `SttQueue.kt`, `SqliteTranscriptIndex.kt`, `MiniJson.kt`.

---

## 0. What already works without a provider

The phone can be used exactly as it will be used later, today:

* Audio is captured and archived. **Always.**
* With `providerKind = "none"` (the shipped default) the transcription queue **accumulates**.
  Nothing is dropped, nothing expires, nothing is truncated.
* The moment a provider is configured, **the entire backlog transcribes** and becomes
  searchable — including everything recorded before the provider existed.
* `MockSttProvider` produces deterministic offline transcripts, so the archive, the FTS index
  and the search UI can be built and demoed with zero cloud involvement. Mock-produced segments
  are permanently stamped `provider = "mock"` and can never be confused with real ones.

So there is **no rush** on this decision, and no cost to deferring it.

---

## 1. The checklist — answer these and the config writes itself

Each item maps to one field of `SttConfig`.

### Endpoint
| # | Question | Config field |
|---|---|---|
| 1 | What is the full HTTPS URL for a **batch** (non-streaming) recognition request? | `endpointUrl` |
| 2 | HTTP method? (Everything seen so far is `POST`.) | `method` |

### Auth
| # | Question | Config field |
|---|---|---|
| 3 | What exact HTTP header carries the credential, and in what shape? e.g. `Authorization: Bearer <token>`, or `x-api-key: <key>`, or a vendor-specific header name. | `headers` |
| 4 | Does anything need to go in the **query string** instead (some APIs take `?key=…`)? | `queryParams` |
| 5 | Is the credential a long-lived key, or a short-lived token that must be **refreshed**? ⚠️ See §4 — refresh is the one thing the generic client cannot do. | — |

### Audio
| # | Question | Config field |
|---|---|---|
| 6 | What container does it accept? We produce **WAV (RIFF, PCM s16le)** or **raw headerless PCM**. Anything else (FLAC, Opus, OGG) needs an encoder we have not written. | `audioEncoding` |
| 7 | Is the audio the **raw request body**, or a **multipart/form-data field**? If multipart, what is the field name and does it care about the filename/extension? | `audioCarrier`, `multipartFieldName`, `multipartFileName` |
| 8 | What `Content-Type` does it expect on the audio? | `audioContentType` |
| 9 | Or does it want a **JSON envelope** with base64 audio inside? If so, which field? | `paramsIn = "json-body"`, `jsonAudioField` |

We produce, unconditionally: **16 kHz, mono, signed 16-bit little-endian PCM** (`VoiceFormat`).
If the provider cannot accept 16 kHz mono, say so — resampling is extra work.

### Parameters
| # | Question | Config field |
|---|---|---|
| 10 | What are the **exact parameter names** for sample rate, channel count, language and model? (These differ per vendor, which is why they live in config as a plain string map.) | `extraParams` |
| 11 | Do those parameters go in the **query string**, as **multipart text parts**, or as **JSON body fields**? | `paramsIn` |
| 12 | Which language / model / tier do we want? | `extraParams` |

### Response
| # | Question | Config field |
|---|---|---|
| 13 | Paste one **example success response body**. We need the dotted/indexed path to the transcript text — e.g. `text`, or `results.0.alternatives.0.transcript`. | `textPath` |
| 14 | Is there a confidence value, and where? | `confidencePath` |
| 15 | When it fails **with HTTP 200 and an error in the body**, where is the error message? | `errorPath` |

### Limits & cost
| # | Question | Config field |
|---|---|---|
| 16 | **Maximum clip length** per request (seconds). We refuse longer clips rather than truncating them — a half-sentence transcript is worse than none. | `maxClipSeconds` |
| 17 | Rate limits: requests/minute, concurrent requests, daily quota? | (informs `retryBackoffMs`) |
| 18 | **Pricing unit** — per audio-second, per request, per character? And roughly what per hour of audio? | — |
| 19 | Does it support **streaming** recognition, and do we care? We currently send **batch clips**; streaming would be a new `SttProvider`, not a config change. | — |
| 20 | Retry policy the provider prefers — which status codes are retryable (429/503) and does it send `Retry-After`? ⚠️ We currently back off exponentially on **any** failure and ignore `Retry-After`. | `retryAttempts`, `retryBackoffMs`, `retryMaxBackoffMs` |

---

## 2. Example config file (synthetic — not any real provider)

Written to `<app filesDir>/voice/stt-config.json`, app-private, at runtime. **Never committed.**

```json
{
  "providerKind": "http",
  "displayName": "Some Provider",
  "endpointUrl": "https://stt.example.invalid/v1/recognize",
  "method": "POST",
  "headers": { "Authorization": "Bearer PUT-THE-REAL-KEY-HERE-AT-RUNTIME" },
  "queryParams": {},
  "audioEncoding": "wav",
  "audioCarrier": "body",
  "extraParams": { "language": "en-US", "sample_rate": "16000", "channels": "1" },
  "paramsIn": "query",
  "textPath": "results.0.alternatives.0.transcript",
  "confidencePath": "results.0.alternatives.0.confidence",
  "errorPath": "error.message",
  "maxClipSeconds": 60,
  "connectTimeoutMs": 15000,
  "readTimeoutMs": 60000,
  "retryAttempts": 3,
  "retryBackoffMs": 2000,
  "retryMaxBackoffMs": 300000
}
```

`stt.example.invalid` is an RFC 2606 reserved name and can never resolve. It is a placeholder,
not a hint.

---

## 3. ⛔ Where the data goes — plainly

**Stays on the phone, always:**

* The raw 205-byte master packet stream (`.g2a`) — the complete recording.
* The decoded PCM clips in `<filesDir>/voice/stt-pcm/`.
* The SQLite archive (`sessions`, `segments`, `segments_fts`) with all transcript text.
* The provider config, including the credential.

**Leaves the phone, only when a provider is configured, only to that provider:**

* One HTTP request per clip, containing **the audio of that clip** (WAV or raw PCM, 16 kHz mono)
  plus the declared parameters and the credential header.
* Nothing else. No session ids, no device identifiers, no location, no other clips.

**Never leaves the phone at all:** the master `.g2a` archive, the SQLite database, the search
index, and any transcript text (the transcript comes *back* from the provider; we never send
text anywhere).

**Never enters a log line:** audio bytes, transcript text, header values, or the full endpoint
URL (a URL can carry a key in its query string). Logging across this whole subsystem is
**counts and short reason codes only** — the same rule `G2MicStats` enforces on the BLE side,
for the same reason.

**Retention:** none is applied. Nothing here deletes anything, ever. The only removal paths are
`SqliteTranscriptIndex.deleteSessionByUserRequest()` and `SttConfigStore.clear()`, both of
which require a deliberate user action.

Choosing a provider is therefore a **privacy decision, not just a cost one**: it decides who
gets to hear the audio. Worth weighing an on-device model (which would be a fourth
`providerKind`, no network at all) against a cloud endpoint.

---

## 4. Known gaps — what the generic client does NOT do

Be honest about these before promising a provider will "just work":

1. **No token refresh.** `headers` is static. A provider requiring an OAuth exchange, a signed
   request (AWS SigV4 and friends) or a short-lived token needs a small dedicated
   `SttProvider`. The seam supports that — it is a new class and a new `providerKind`, and
   `HttpSttProvider` stays untouched.
2. **No streaming.** We send finished clips. Live captions would be a different provider and a
   different pipeline.
3. **No `Retry-After` handling.** Backoff is exponential regardless of what the provider asks.
4. **No 429-vs-500 distinction.** All failures are retried the same way. Harmless, just not
   optimal.
5. **No diarisation, timestamps or word-level alignment** are read out, even if a provider
   returns them. `SttConfig` has one `textPath`; per-word data would need a schema change to
   `segments`.
6. **No resampling or transcoding.** 16 kHz mono s16le in, WAV or raw PCM out. FLAC/Opus need
   an encoder.
7. **WAV framing is duplicated.** `HttpSttProvider.wavHeader()` writes its own 44-byte header
   rather than depending on the sibling stream's `WavWriter.kt`, so the two could be built in
   parallel. `[hypothesis]` they are byte-identical for 16 kHz mono s16le; once both have
   landed, delete the local copy and call the shared writer.
8. **Clips are not split.** A clip longer than `maxClipSeconds` fails as `clip-too-long` and
   stays pending forever. Deliberate — silently sending half a sentence produces a wrong
   transcript that then looks authoritative in search for good.

---

## 5. How to prove a provider works, once chosen

1. Write the config JSON to `<filesDir>/voice/stt-config.json` (settings UI, or `adb`-pushed
   during bring-up — the file is app-private).
2. `SttProviderFactory.describe()` should report `stt-provider=http` with the right host.
3. Record a short session, then `SttQueue.drainOnce()`.
4. `TranscriptIndex.search("<words from the middle of what you said>")` must return a hit whose
   snippet highlights the terms with `[` `]`.

That is exactly what `SttPipelineHeadlineTest.speakASentenceThenFindItByText` does with the
mock, so the only new variable is the provider itself.
