// Dictation — the last hop: a transcript becomes bytes in an on-glass app's mailbox.
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// WHERE THIS SITS
// ══════════════════════════════════════════════════════════════════════════════════════════
//
//   temple long-press
//        │
//        ├─ ble/commands.ts  audioControl({enable:true})       EvenHub Cmd 15 / field 18
//        │       glasses power the DMIC pair and stream 205-byte LC3 packets (LEFT arm)
//        ├─ mic.ts           MicSession: sequencing, loss accounting, the 30 s interlock
//        ├─ <native>         liblc3 -> 16 kHz PCM -> sherpa-onnx, ON THE PHONE, no server
//        │
//   ┌────┴──────────────── THIS FILE ────────────────────────────────────────────────┐
//   │  encodeTranscript(text, …)   -> an "FFTX" blob                                 │
//   │  encodeFfsc({appId, seq, blob}) (sdk/ffsc.ts, S-DATA) -> the FXP1 body          │
//   └────┬──────────────────────────────────────────────────────────────────────────┘
//        │
//        ▼  cfw_loader_ingest routes on the body's first 4 bytes ("FFSC")
//   ffs_data_consume() copies it into the resident per-app mailbox
//        │
//        ├─ the app reads it:  ctx->api->data(ctx, &d)          <- ABI 2, S-DATA
//        └─ or we read it back with ZERO calls: g2flash/payloads/ffs_mic_text.c
//
// ⛔ NOTHING IN THIS FILE MAY BE LOGGED. `text` is the wearer's speech. The whole point of
// `src/sdk/mic.ts`'s contract is that a transcript is the recording, only smaller — so this
// module exports no logger, takes no logger, and the ONE number it offers for diagnostics is
// `checksum8`, which is 8 bits and one-way. Log the checksum and the length; never the text.
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// THE "FFTX" BLOB, AND WHY IT IS NOT JUST A BARE STRING
// ══════════════════════════════════════════════════════════════════════════════════════════
// The channel is a mailbox, not a stream: latest-wins, one value per app. So a partial
// transcript and a final transcript arrive on the SAME channel and overwrite each other, and
// an app that cannot tell them apart will happily let the wearer send half a sentence. Eight
// bytes of header buys that distinction, plus a lossy flag from `captureIsTrustworthy` so a
// capture with a hole in it can be drawn as such instead of as a fluent lie.
//
//     +0x00  char[4]  "FFTX"
//     +0x04  u8       ver = 1
//     +0x05  u8       flags   bit0 FINAL, bit1 LOSSY
//     +0x06  u16      text_len   bytes of 7-bit ASCII following (never NUL-terminated)
//     +0x08  text[text_len]
//
// 7-bit ASCII because the on-glass font is: `apps/messages.c` carries its own 5x7 face and
// draws a visible substitute box for anything >= 0x80. `toAscii` (sdk/ffsm.ts) is the same
// transliteration S-MSG already tested, so a smart quote from the recogniser becomes `'`
// rather than a box.

import { toAscii } from "./ffsm";

export const FFTX_MAGIC = "FFTX";
export const FFTX_VER = 1;
export const FFTX_HDR_LEN = 8;

export const FFTX_FLAG_FINAL = 0x01;
export const FFTX_FLAG_LOSSY = 0x02;

/**
 * Longest transcript that fits.
 *
 * G2D_MAX_BLOB is 1024 and the FFSC header takes 16 of it, so the hard ceiling is 1000 bytes
 * of text. That is ~170 words — far more than anyone dictates into a reply, and the excess is
 * deliberate headroom rather than an invitation.
 */
export const FFTX_MAX_TEXT = 1024 - 16 - FFTX_HDR_LEN;

export interface TranscriptOptions {
  /** false while the recogniser is still emitting partials. */
  final: boolean;
  /** from `captureIsTrustworthy(stats)` in sdk/mic.ts — the packet loss was material. */
  lossy?: boolean;
}

/**
 * Build the blob. Transliterates, collapses whitespace, and truncates from the FRONT of the
 * overflow (keeping the start of the sentence, which is what a reader needs) rather than
 * throwing — a partial arriving 1 byte over the cap must not abort a live dictation.
 */
export function encodeTranscript(text: string, opts: TranscriptOptions): Uint8Array {
  let ascii = toAscii(text).replace(/\s+/g, " ").trim();
  if (ascii.length > FFTX_MAX_TEXT) ascii = ascii.slice(0, FFTX_MAX_TEXT);

  const out = new Uint8Array(FFTX_HDR_LEN + ascii.length);
  out[0] = 0x46; // F
  out[1] = 0x46; // F
  out[2] = 0x54; // T
  out[3] = 0x58; // X
  out[4] = FFTX_VER;
  out[5] = (opts.final ? FFTX_FLAG_FINAL : 0) | (opts.lossy ? FFTX_FLAG_LOSSY : 0);
  out[6] = ascii.length & 0xff;
  out[7] = (ascii.length >> 8) & 0xff;
  for (let i = 0; i < ascii.length; i++) out[FFTX_HDR_LEN + i] = ascii.charCodeAt(i) & 0x7f;
  return out;
}

/** Read one back. Exists so the tests round-trip against the encoder rather than a fixture. */
export function decodeTranscript(blob: Uint8Array): { text: string; final: boolean; lossy: boolean } {
  if (blob.length < FFTX_HDR_LEN) throw new Error("FFTX: shorter than its header");
  if (blob[0] !== 0x46 || blob[1] !== 0x46 || blob[2] !== 0x54 || blob[3] !== 0x58) {
    throw new Error("FFTX: bad magic");
  }
  if (blob[4] !== FFTX_VER) throw new Error(`FFTX: version ${blob[4]}`);
  const len = blob[6]! | (blob[7]! << 8);
  if (FFTX_HDR_LEN + len !== blob.length) throw new Error("FFTX: text_len disagrees with the blob");
  let text = "";
  for (let i = 0; i < len; i++) text += String.fromCharCode(blob[FFTX_HDR_LEN + i]!);
  return { text, final: (blob[5]! & FFTX_FLAG_FINAL) !== 0, lossy: (blob[5]! & FFTX_FLAG_LOSSY) !== 0 };
}

/**
 * ⭐ The proof function.
 *
 * Byte-for-byte the arithmetic in `g2flash/payloads/ffs_mic_text.c`: rotate the running byte
 * left by one, then XOR the next byte, starting from zero. Order-sensitive (so a transposition
 * shows), one-way, and 8 bits — small enough that it can be logged next to the length without
 * saying anything about the words.
 *
 * ⛔ IF YOU CHANGE THIS, CHANGE THE PAYLOAD. They are one algorithm with two implementations,
 * and their agreement is the entire evidence that the transcript on the glasses is the
 * transcript the recogniser produced. `expectedMailboxRet` below turns that into a single
 * number to compare against the `ret=` the device prints.
 */
export function checksum8(bytes: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < bytes.length; i++) {
    s = ((s << 1) | (s >> 7)) & 0xff;
    s ^= bytes[i]!;
  }
  return s & 0xff;
}

/**
 * Predict, on this box and BEFORE the push, exactly what `ffs_mic_text.c` must return once
 * the blob is resident. Compare it with the `ret=` on the `⟨LOADER⟩` line.
 *
 *     bits 31..24  0x65
 *     bits 23..16  checksum8 of the blob
 *     bits 15..6   blob length
 *     bits  5..4   slot (0 or 1; the first PUT after a boot lands in 0)
 *     bits  3..0   0 = OK
 */
export function expectedMailboxRet(blob: Uint8Array, slot = 0): number {
  if (blob.length === 0 || blob.length > 1023) throw new Error(`FFTX: ${blob.length} B cannot be read back by the probe`);
  return (
    (0x65 << 24) | (checksum8(blob) << 16) | ((blob.length & 0x3ff) << 6) | ((slot & 3) << 4)
  ) >>> 0;
}

/** Format it the way the device log does, so the comparison is a string match. */
export function formatRet(word: number): string {
  return `0x${(word >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}
