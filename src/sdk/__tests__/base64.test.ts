// base64 round-trip tests.
//
// This codec sits on EVERY byte in and out of the glasses. A padding or masking slip here would
// not throw — it would quietly hand the firmware malformed protobuf and hand the decoder
// malformed events, which presents as "the hardware is being flaky". Hence: check against a
// known-good implementation over exhaustive lengths, not a couple of hand-picked vectors.

import { fromBase64, toBase64 } from "../base64";

/** Reference encoder — Node's Buffer, i.e. not our own arithmetic agreeing with itself. */
const ref = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe("base64", () => {
  it("matches the reference encoder for every length 0..64", () => {
    for (let n = 0; n <= 64; n++) {
      // A byte pattern that exercises the high bit, which is where sign-extension bugs live.
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 200) & 0xff);
      expect(toBase64(bytes)).toBe(ref(bytes));
    }
  });

  it("round-trips every byte value", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(fromBase64(toBase64(all)))).toEqual(Array.from(all));
  });

  it("handles all three padding cases", () => {
    // Lengths 1, 2 and 3 produce "==", "=" and no padding respectively.
    for (const n of [1, 2, 3]) {
      const b = Uint8Array.from({ length: n }, (_, i) => 0xf0 + i);
      expect(toBase64(b)).toBe(ref(b));
      expect(Array.from(fromBase64(toBase64(b)))).toEqual(Array.from(b));
    }
    expect(toBase64(new Uint8Array())).toBe("");
    expect(fromBase64("")).toHaveLength(0);
  });

  it("decodes what the driver sends — NO_WRAP, but tolerates whitespace", () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
    const wrapped = ref(bytes).replace(/(.{20})/g, "$1\n");
    expect(Array.from(fromBase64(wrapped))).toEqual(Array.from(bytes));
  });

  it("decodes a real captured event frame", () => {
    // The row-1 list tap used throughout the event tests.
    const hex = "0802" + "6a0e" + "0a0e080312086666732d6c6973742001";
    const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
