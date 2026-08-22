// Byte-truth for the two wire CRCs, plus drift guards against the other implementations of the
// SAME functions already in the tree (proven native driver, program.ts, templates.ts). CRC cannot
// catch drift between two encoders that share a computer — but a test that runs BOTH and asserts
// equality can, which is the whole point of these guards.

import { crc16CcittFalse, crc16BytesLE, crc32, crc32BytesLE } from "../crc";
import { crc16 as ffspCrc16 } from "../../program";
import { crc32 as templatesCrc32 } from "../../templates";

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Faithful port of the proven native transport CRC (G2Protocol.kt `g2CRC16`) — a byte-swap/xor
 * *bit-mix* formulation. It is a different-looking algorithm from our MSB-first table walk; the
 * guard below proves they are the same function.
 */
function g2Crc16Mix(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc = (((crc >>> 8) | ((crc << 8) & 0xff00)) ^ (b & 0xff)) & 0xffff;
    crc = (crc ^ ((crc & 0xff) >>> 4)) & 0xffff;
    crc = (crc ^ ((crc << 12) & 0xffff)) & 0xffff;
    crc = (crc ^ (((crc & 0xff) << 5) & 0xffff)) & 0xffff;
  }
  return crc & 0xffff;
}

describe("CRC-16/CCITT-FALSE (transport + FFSP)", () => {
  it("matches the canonical check vectors", () => {
    expect(crc16CcittFalse(new Uint8Array(0))).toBe(0xffff);
    expect(crc16CcittFalse(enc("A"))).toBe(0xb915);
    // 0x29B1 is THE published CCITT-FALSE check value for "123456789".
    expect(crc16CcittFalse(enc("123456789"))).toBe(0x29b1);
    expect(crc16CcittFalse(new Uint8Array(16))).toBe(0x6a0a);
  });

  it("emits its 2 bytes little-endian", () => {
    // 0x29B1 -> [0xB1, 0x29]
    expect(Array.from(crc16BytesLE(enc("123456789")))).toEqual([0xb1, 0x29]);
  });

  it("equals the proven native g2CRC16 mix across random vectors (drift guard)", () => {
    for (let n = 0; n < 200; n++) {
      const len = (n * 7 + 3) % 137;
      const v = new Uint8Array(len);
      for (let i = 0; i < len; i++) v[i] = (i * 31 + n * 17 + 5) & 0xff;
      expect(crc16CcittFalse(v)).toBe(g2Crc16Mix(v));
    }
  });

  it("equals program.ts's FFSP crc16 (same algorithm, drift guard)", () => {
    expect(crc16CcittFalse(enc("123456789"))).toBe(ffspCrc16(enc("123456789")));
    expect(crc16CcittFalse(new Uint8Array(16))).toBe(ffspCrc16(new Uint8Array(16)));
  });
});

describe("CRC-32 (zlib/PKZIP, FXP1 body)", () => {
  it("matches the canonical check vector", () => {
    // 0xCBF43926 is THE published zlib/PKZIP CRC-32 check value for "123456789".
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
  });

  it("emits its 4 bytes little-endian", () => {
    // 0xCBF43926 -> [0x26, 0x39, 0xF4, 0xCB]
    expect(Array.from(crc32BytesLE(enc("123456789")))).toEqual([0x26, 0x39, 0xf4, 0xcb]);
  });

  it("is NOT the truncated CRC-16 (proves the two checks are distinct)", () => {
    expect(crc32(enc("123456789")) & 0xffff).not.toBe(crc16CcittFalse(enc("123456789")));
  });

  it("equals templates.ts crc32 (drift guard)", () => {
    const v = enc("the quick brown fox");
    expect(crc32(v)).toBe(templatesCrc32(v));
  });
});
