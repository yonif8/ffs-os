// Transcript -> mailbox tests.
//
// The load-bearing one is the LAST block. `checksum8` here and the loop in
// `g2flash/payloads/ffs_mic_text.c` are one algorithm written twice, and their agreement is
// the whole evidence that the bytes on the glasses are the bytes the recogniser produced. The
// vectors below are computed by hand from the C, not by calling the TS and writing down what
// it said — a self-consistent test would prove only that TypeScript agrees with itself.

import {
  FFTX_FLAG_FINAL,
  FFTX_FLAG_LOSSY,
  FFTX_HDR_LEN,
  FFTX_MAX_TEXT,
  checksum8,
  decodeTranscript,
  encodeTranscript,
  expectedMailboxRet,
  formatRet,
} from "../dictation";
import { FFSC_HDR_LEN, FFSC_MAX_BLOB, encodeFfsc } from "../ffsc";

describe("FFTX transcript blob", () => {
  it("is an 8-byte header then 7-bit ASCII", () => {
    const b = encodeTranscript("hi", { final: true });
    expect(b.length).toBe(FFTX_HDR_LEN + 2);
    expect(Array.from(b.subarray(0, 8))).toEqual([0x46, 0x46, 0x54, 0x58, 1, FFTX_FLAG_FINAL, 2, 0]);
    expect(Array.from(b.subarray(8))).toEqual([0x68, 0x69]);
  });

  it("round-trips text, the final flag and the lossy flag", () => {
    const b = encodeTranscript("running ten minutes late", { final: false, lossy: true });
    const d = decodeTranscript(b);
    expect(d.text).toBe("running ten minutes late");
    expect(d.final).toBe(false);
    expect(d.lossy).toBe(true);
    expect(b[5]).toBe(FFTX_FLAG_LOSSY);
  });

  it("transliterates what a recogniser actually emits, so nothing draws as a box", () => {
    // The on-glass 5x7 face draws a substitute box for anything >= 0x80. A smart apostrophe
    // from an ASR is the single most likely byte to hit that.
    const b = encodeTranscript("I’m on my way — café", { final: true });
    const { text } = decodeTranscript(b);
    expect(text).toBe("I'm on my way - cafe");
    for (const byte of b.subarray(FFTX_HDR_LEN)) expect(byte).toBeLessThan(0x80);
  });

  it("collapses the newlines a partial arrives with, because the app wraps for itself", () => {
    expect(decodeTranscript(encodeTranscript("  two\n\nlines  ", { final: true })).text).toBe("two lines");
  });

  it("truncates instead of throwing — a long partial must not abort a live dictation", () => {
    const b = encodeTranscript("x".repeat(FFTX_MAX_TEXT + 50), { final: false });
    expect(b.length).toBe(FFTX_HDR_LEN + FFTX_MAX_TEXT);
    expect(FFTX_HDR_LEN + FFTX_MAX_TEXT + FFSC_HDR_LEN).toBe(FFSC_MAX_BLOB);
  });

  it("rejects a corrupt blob rather than returning plausible garbage", () => {
    const b = encodeTranscript("ok", { final: true });
    expect(() => decodeTranscript(b.subarray(0, 4))).toThrow();
    const badMagic = Uint8Array.from(b); badMagic[3] = 0x59;
    expect(() => decodeTranscript(badMagic)).toThrow();
    const badLen = Uint8Array.from(b); badLen[6] = 9;
    expect(() => decodeTranscript(badLen)).toThrow();
  });

  it("fits inside a real FFSC frame at the maximum length", () => {
    const blob = encodeTranscript("y".repeat(FFTX_MAX_TEXT), { final: true });
    const frame = encodeFfsc({ appId: 3, seq: 1, blob });
    expect(frame.length).toBe(FFSC_HDR_LEN + FFSC_MAX_BLOB - FFSC_HDR_LEN);
    expect(frame.length).toBeLessThanOrEqual(FFSC_HDR_LEN + FFSC_MAX_BLOB);
  });
});

describe("checksum8 — the number the glasses must independently produce", () => {
  it("matches hand-computed vectors from the C loop", () => {
    // s = 0; per byte: s = rotl8(s,1) ^ b
    //   []            -> 0
    //   [0x00]        -> rotl8(0,1)=0 ^ 0x00 = 0x00
    //   [0x01]        -> 0 ^ 0x01 = 0x01
    //   [0x01,0x01]   -> rotl8(0x01,1)=0x02 ^ 0x01 = 0x03
    //   [0x80]        -> 0 ^ 0x80 = 0x80
    //   [0x80,0x00]   -> rotl8(0x80,1)=0x01 ^ 0x00 = 0x01     <- the rotate, not a shift
    //   [0x41,0x42]   -> rotl8(0x41,1)=0x82 ^ 0x42 = 0xC0
    expect(checksum8(new Uint8Array([]))).toBe(0x00);
    expect(checksum8(new Uint8Array([0x00]))).toBe(0x00);
    expect(checksum8(new Uint8Array([0x01]))).toBe(0x01);
    expect(checksum8(new Uint8Array([0x01, 0x01]))).toBe(0x03);
    expect(checksum8(new Uint8Array([0x80]))).toBe(0x80);
    expect(checksum8(new Uint8Array([0x80, 0x00]))).toBe(0x01);
    expect(checksum8(new Uint8Array([0x41, 0x42]))).toBe(0xc0);
  });

  it("agrees with the COMPILED C, on the real blobs, not just on synthetic bytes", () => {
    // These two are the output of the checksum loop lifted verbatim out of
    // g2flash/payloads/ffs_mic_text.c, compiled with gcc -O2 and run on this box over the
    // exact bytes encodeTranscript produces. Reproduce them by pasting the loop into a host
    // main() -- that is how they were obtained, and it is why they are evidence rather than
    // a restatement of the TypeScript.
    expect(checksum8(encodeTranscript("hi", { final: true }))).toBe(0x6f);
    expect(checksum8(encodeTranscript("running ten minutes late", { final: true }))).toBe(0x7d);
    expect(formatRet(expectedMailboxRet(encodeTranscript("hi", { final: true })))).toBe("0x656F0280");
  });

  it("is order-sensitive, so a transposed payload does not pass", () => {
    expect(checksum8(new Uint8Array([1, 2, 3]))).not.toBe(checksum8(new Uint8Array([3, 2, 1])));
  });

  it("stays inside a byte for a full-length blob", () => {
    const blob = encodeTranscript("z".repeat(FFTX_MAX_TEXT), { final: true });
    const c = checksum8(blob);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(0xff);
  });
});

describe("expectedMailboxRet — the single number the device run is graded against", () => {
  it("packs tag / checksum / length / slot exactly as ffs_mic_text.c unpacks them", () => {
    const blob = encodeTranscript("hi", { final: true }); // 10 bytes
    const word = expectedMailboxRet(blob, 0);
    expect(word >>> 24).toBe(0x65);
    expect((word >>> 16) & 0xff).toBe(checksum8(blob));
    expect((word >>> 6) & 0x3ff).toBe(blob.length);
    expect((word >>> 4) & 3).toBe(0);
    expect(word & 0xf).toBe(0);
  });

  it("reproduces the worked example in the payload's own header comment", () => {
    // 22 bytes, checksum 0x9E, slot 0, status OK.
    const fake = { length: 22 } as Uint8Array;
    const word = ((0x65 << 24) | (0x9e << 16) | (22 << 6) | 0) >>> 0;
    expect(formatRet(word)).toBe("0x659E0580");
    expect((word >>> 6) & 0x3ff).toBe(fake.length);
  });

  it("moves visibly when the transcript changes by one character", () => {
    const a = expectedMailboxRet(encodeTranscript("send it", { final: true }));
    const b = expectedMailboxRet(encodeTranscript("send in", { final: true }));
    expect(a).not.toBe(b);
  });
});
