// FFSM encoder tests.
//
// The consumer of these bytes is a 4 KB Thumb-2 blob on a display thread that walks the
// buffer with raw pointer arithmetic. It validates first (`ms_valid()` in
// g2flash/apps/messages.c) and REFUSES to launch on anything malformed — which on-glass looks
// exactly like "the app is broken", 13 minutes away from a diagnosis. So the byte layout gets
// pinned here, offline, against the same rules the C enforces.
//
// The cross-check that matters most: `g2flash/apps/messages/gen_fixture.py` encodes the same
// structure for the compiled-in fixture, and `g2flash/apps/messages/test_store.c` proves the C
// parser reads THAT. The vector below is that fixture, byte for byte, so the two encoders are
// checked against each other rather than each against itself.

import { decodeFfsm, encodeFfsm, fitFfsm, toAscii, FFSM_MAX_BYTES } from "../ffsm";

const thread = (name: string, unread: boolean, msgs: [boolean, number, string][]) => ({
  name,
  unread,
  messages: msgs.map(([fromMe, ageMin, body]) => ({ fromMe, ageMin, body })),
});

/** The exact conversation in gen_fixture.py's THREADS table, minus its deliberate U+2665. */
const FIXTURE = [
  thread("Sarah", true, [
    [false, 42, "Are we still on for 7?"],
    [true, 40, "Yes - booked the table"],
    [false, 12, "Perfect, I'll head over after the gym"],
    [false, 4, "Running 10 min late, sorry!"],
  ]),
  thread("Mum", true, [
    [false, 95, "Call me when you get a chance"],
    [true, 90, "Will do this evening"],
    [false, 88, "Thanks love x"],
  ]),
  thread("Dan R", false, [
    [false, 185, "PR is green, merging now"],
    [true, 180, "nice one"],
  ]),
  thread("Alex K", true, [[false, 1500, "sent you the file"]]),
];

describe("FFSM header", () => {
  it("starts with the magic, version and thread count the app checks", () => {
    const b = encodeFfsm(FIXTURE);
    expect(Array.from(b.subarray(0, 8))).toEqual([0x46, 0x46, 0x53, 0x4d, 1, 4, 0, 0]);
  });

  it("lays a thread out as len/count/flags/pad then the name", () => {
    const b = encodeFfsm([thread("Mum", true, [[false, 5, "hi"]])]);
    //                       nameLen nMsgs unread pad  M     u     m
    expect(Array.from(b.subarray(8, 15))).toEqual([3, 1, 1, 0, 0x4d, 0x75, 0x6d]);
    //                      dir bodyLen ageLo ageHi  h     i
    expect(Array.from(b.subarray(15, 21))).toEqual([0, 2, 5, 0, 0x68, 0x69]);
  });

  it("writes age_min little-endian across the byte boundary", () => {
    const b = encodeFfsm([thread("A", false, [[false, 1500, "x"]])]);
    const i = 8 + 4 + 1; // header + thread header + 1-char name
    expect(b[i + 2] | (b[i + 3] << 8)).toBe(1500);
    expect(b[i + 2]).toBe(1500 & 0xff);
  });

  it("clamps an absurd age instead of wrapping it", () => {
    const b = encodeFfsm([thread("A", false, [[false, 999_999, "x"]])]);
    expect(decodeFfsm(b)[0].messages[0].ageMin).toBe(0xffff);
  });
});

describe("FFSM round trip", () => {
  it("survives the whole fixture unchanged", () => {
    expect(decodeFfsm(encodeFfsm(FIXTURE))).toEqual(FIXTURE);
  });

  it("is small enough to be a resident buffer", () => {
    expect(encodeFfsm(FIXTURE).length).toBeLessThan(400);
  });

  it("rejects every truncation, exactly as ms_valid() does on-glass", () => {
    const b = encodeFfsm(FIXTURE);
    for (let n = 0; n < b.length; n++) {
      expect(() => decodeFfsm(b.subarray(0, n))).toThrow();
    }
  });

  it("rejects a corrupted header", () => {
    const b = encodeFfsm(FIXTURE);
    for (const [i, v] of [
      [0, 0x58],
      [4, 2],
      [5, 0],
    ] as [number, number][]) {
      const bad = Uint8Array.from(b);
      bad[i] = v;
      expect(() => decodeFfsm(bad)).toThrow();
    }
  });
});

describe("transliteration to the app's 7-bit face", () => {
  it("leaves plain ASCII alone", () => {
    expect(toAscii("Running 10 min late, sorry!")).toBe("Running 10 min late, sorry!");
  });

  it("maps the punctuation phones actually emit", () => {
    expect(toAscii("I’ll be there — promise…")).toBe("I'll be there - promise...");
    expect(toAscii("“ok”")).toBe('"ok"');
  });

  it("strips accents rather than dropping the letter", () => {
    expect(toAscii("café naïve über")).toBe("cafe naive uber");
  });

  it("collapses a RUN of emoji to a single marker, not one per codepoint", () => {
    expect(toAscii("on my way \u{1F697}\u{1F4A8}")).toBe("on my way *");
    expect(toAscii("\u{1F44D} ok \u{1F44D}")).toBe("* ok *");
  });

  it("turns newlines into spaces, since the app wraps for itself", () => {
    expect(toAscii("line one\nline two")).toBe("line one line two");
  });

  it("never emits a byte the app has no glyph for", () => {
    const out = toAscii("héllo \u{1F600} — “quoted” 日本語");
    for (const ch of out) {
      const c = ch.codePointAt(0)!;
      expect(c).toBeGreaterThanOrEqual(0x20);
      expect(c).toBeLessThanOrEqual(0x7e);
    }
  });
});

describe("fitting the budget", () => {
  const big = () =>
    Array.from({ length: 8 }, (_, t) =>
      thread(`Person ${t}`, false, Array.from({ length: 12 }, (_, m): [boolean, number, string] => [
        m % 2 === 0,
        m,
        "x".repeat(120),
      ]))
    );

  it("drops the oldest messages first and still fits", () => {
    const fitted = fitFfsm(big());
    expect(encodeFfsm(fitted).length).toBeLessThanOrEqual(FFSM_MAX_BYTES);
    // every surviving thread keeps its NEWEST message
    for (const t of fitted) expect(t.messages[t.messages.length - 1].body.length).toBe(120);
  });

  it("keeps all eight threads when trimming messages is enough", () => {
    const modest = Array.from({ length: 8 }, (_, t) =>
      thread(`Person ${t}`, false, Array.from({ length: 12 }, (_, m): [boolean, number, string] => [
        m % 2 === 0,
        m,
        "x".repeat(30),
      ]))
    );
    const fitted = fitFfsm(modest);
    expect(fitted.length).toBe(8);
    expect(fitted.every((t) => t.messages.length >= 2)).toBe(true);
    expect(encodeFfsm(fitted).length).toBeLessThanOrEqual(FFSM_MAX_BYTES);
  });

  it("only drops a thread once every thread is down to one message", () => {
    // 8 threads x one 120-char message cannot fit 1024 B, so a thread MUST go.
    const fitted = fitFfsm(big());
    expect(fitted.length).toBeLessThan(8);
    expect(fitted.every((t) => t.messages.length === 1)).toBe(true);
  });

  it("caps a thread at 12 messages, keeping the newest", () => {
    const t = thread(
      "A",
      false,
      Array.from({ length: 30 }, (_, i): [boolean, number, string] => [false, 30 - i, `m${i}`])
    );
    const [fitted] = fitFfsm([t]);
    expect(fitted.messages.length).toBe(12);
    expect(fitted.messages[11].body).toBe("m29");
  });

  it("refuses an empty inbox rather than shipping a blank screen", () => {
    expect(() => encodeFfsm([])).toThrow();
    expect(() => encodeFfsm([thread("A", false, [])])).toThrow();
  });
});
