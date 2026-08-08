// Buzzer encoder tests.
//
// The load-bearing test here is the LAST one. A raw tone's `ms` is not honoured by the firmware
// on 2.2.7.14 — the PWM starts and the stop-timer never arms — so the only thing that ends the
// sound is a STOP we send ourselves. That is not a hypothetical: a raw tone played indefinitely
// next to a sleeping person, and stopped only when an explicit STOP was sent.

import {
  OS_DONE_PRESET,
  encodeNote,
  encodePreset,
  encodeRawTone,
  encodeSequence,
  encodeStop,
  playToneSafely,
} from "../sound";

describe("buzzer encoders", () => {
  it("preset is three bytes and clamps to the 0..8 the CFW accepts", () => {
    expect(Array.from(encodePreset(1))).toEqual([5, 0, 1]);
    expect(Array.from(encodePreset(99))).toEqual([5, 0, 8]);
    expect(Array.from(encodePreset(-3))).toEqual([5, 0, 0]);
  });

  it("note clamps to the range that keeps the driver's divisor non-zero", () => {
    // note 1..7 x octave 0..3 keeps the freq-table index in [0,27]; outside it the driver
    // computes 1000000 / (0xffff - table[idx]) and can divide by zero.
    expect(Array.from(encodeNote(5, 2, 8))).toEqual([5, 1, 5, 2, 8]);
    expect(Array.from(encodeNote(0, 9, 0))).toEqual([5, 1, 1, 3, 1]);
    expect(Array.from(encodeNote(99, -1, 999))).toEqual([5, 1, 7, 0, 255]);
  });

  it("raw tone is little-endian for freq and ms", () => {
    // 2000 Hz = 0x07D0, 400 ms = 0x0190
    expect(Array.from(encodeRawTone(2000, 50, 400))).toEqual([5, 3, 0xd0, 0x07, 50, 0x90, 0x01]);
  });

  it("stop is two bytes", () => {
    expect(Array.from(encodeStop())).toEqual([5, 2]);
  });

  it("sequence carries a count then 5 bytes per step", () => {
    const b = encodeSequence([{ freq: 1000, duty: 40, ms: 100 }, { freq: 2000, duty: 60, ms: 200 }]);
    expect(Array.from(b.subarray(0, 3))).toEqual([5, 4, 2]);
    expect(b.length).toBe(3 + 2 * 5);
  });

  /** The OS must chime with a PRESET, which self-terminates inside the driver. */
  it("the OS's done sound is a preset, not a raw tone", () => {
    expect(Array.from(encodePreset(OS_DONE_PRESET))[1]).toBe(0); // kind 0 = preset
  });
});

describe("playToneSafely", () => {
  it("ALWAYS sends STOP after the tone — the firmware's own timer does not fire", async () => {
    const sent: number[][] = [];
    await playToneSafely(
      (b) => { sent.push(Array.from(b)); },
      { freq: 2000, duty: 50, ms: 300 },
      async () => {}                       // no real waiting in tests
    );
    expect(sent).toHaveLength(2);
    expect(sent[0][1]).toBe(3);            // kind 3 = raw tone
    expect(sent[1]).toEqual([5, 2]);       // kind 2 = STOP
  });

  it("sends STOP even if the wait throws — an abort must not strand the piezo", async () => {
    const sent: number[][] = [];
    await expect(
      playToneSafely(
        (b) => { sent.push(Array.from(b)); },
        { freq: 1000, duty: 50, ms: 100 },
        async () => { throw new Error("aborted"); }
      )
    ).rejects.toThrow("aborted");
    expect(sent[sent.length - 1]).toEqual([5, 2]);
  });

  it("caps the duration, so a silly ms cannot become a long sound", async () => {
    const sent: number[][] = [];
    await playToneSafely((b) => { sent.push(Array.from(b)); }, { freq: 1000, duty: 50, ms: 999999 }, async () => {});
    const ms = sent[0][5] | (sent[0][6] << 8);
    expect(ms).toBe(3000);
  });
});
