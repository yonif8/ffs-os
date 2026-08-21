// Microphone packet-layer and audio-control tests.
//
// Two things are load-bearing here.
//
// The first is the ENCODER: a wrong wrapper field on an EvenHub control message is silent — the
// glasses accept the frame, protobuf skips the field it does not recognise, and nothing happens.
// The IMU cost this project a round of hardware time over exactly that (field 22 vs 20), so the
// audio-control bytes are pinned to the generated descriptor here rather than checked on glass.
//
// The second is the LOSS ACCOUNTING. Each packet is 50 ms of speech. A dropped one is a hole in
// the middle of a sentence, and an ASR fed audio with a hole in it does not report a hole — it
// reports a fluent sentence with a word missing. The counter arithmetic is what tells us the
// difference, so it is tested against wraparound, duplicates and trailing packets rather than
// assumed.

import {
  COUNTER_OFFSET,
  MAX_SESSION_MS,
  MicSession,
  PACKET_BYTES,
  PACKET_MS,
  SAMPLES_PER_PACKET,
  captureIsTrustworthy,
  counterGap,
  parseMicPacket,
} from "../mic";
import { AUDIO_CTRL_FIELD, Cmd, encodeAudioControl } from "../wire";

/** A well-formed 205-byte packet with `counter` in the last byte. */
function packet(counter: number, fill = 0x5a): Uint8Array {
  const p = new Uint8Array(PACKET_BYTES).fill(fill);
  p[COUNTER_OFFSET] = counter & 0xff;
  return p;
}

describe("mic packet layout", () => {
  it("is the layout faceclaw decodes: 5 x 40 B of LC3, counter at 204, 800 samples", () => {
    expect(PACKET_BYTES).toBe(205);
    expect(COUNTER_OFFSET).toBe(204);
    expect(SAMPLES_PER_PACKET).toBe(800);
    expect(PACKET_MS).toBe(50);
  });

  it("accepts a 205-byte packet and hands back exactly the 200 LC3 bytes", () => {
    const parsed = parseMicPacket(packet(7));
    expect(parsed).not.toBeNull();
    expect(parsed!.counter).toBe(7);
    expect(parsed!.lc3.length).toBe(200);
  });

  it("rejects anything that is not 205 bytes rather than throwing on a BLE callback", () => {
    expect(parseMicPacket(new Uint8Array(204))).toBeNull();
    expect(parseMicPacket(new Uint8Array(206))).toBeNull();
    expect(parseMicPacket(new Uint8Array(0))).toBeNull();
  });

  it("counter arithmetic wraps at 256 — 255 -> 0 is a gap of one, not of -255", () => {
    expect(counterGap(254, 255)).toBe(1);
    expect(counterGap(255, 0)).toBe(1);
    expect(counterGap(250, 3)).toBe(9);
    expect(counterGap(9, 9)).toBe(0);
  });
});

describe("MicSession", () => {
  it("drops packets that arrive while no session is open", () => {
    // The glasses keep streaming until the disable command lands, so packets ALWAYS trail a stop.
    // Appending them to the next utterance would splice two sentences together.
    const s = new MicSession();
    expect(s.accept(packet(1))).toBeNull();
    s.start();
    s.accept(packet(1));
    const stats = s.stop("user");
    expect(stats.packets).toBe(1);
    expect(s.accept(packet(2))).toBeNull();
  });

  it("counts a missing packet as missing and a repeat as a duplicate", () => {
    const s = new MicSession();
    s.start();
    s.accept(packet(0));
    s.accept(packet(1));
    s.accept(packet(1)); // BLE re-delivery
    s.accept(packet(4)); // 2 and 3 never arrived
    const stats = s.stop("user");
    expect(stats.packets).toBe(3);
    expect(stats.duplicates).toBe(1);
    expect(stats.missing).toBe(2);
    expect(stats.audioMs).toBe(150);
  });

  it("counts a malformed notification without letting it disturb the sequence", () => {
    const s = new MicSession();
    s.start();
    s.accept(packet(0));
    s.accept(new Uint8Array(12));
    s.accept(packet(1));
    const stats = s.stop("user");
    expect(stats.malformed).toBe(1);
    expect(stats.missing).toBe(0);
    expect(stats.packets).toBe(2);
  });

  it("expires at the safety ceiling — the interlock for a missed release gesture", () => {
    let t = 1000;
    const s = new MicSession(() => t);
    s.start();
    expect(s.expired).toBe(false);
    t += MAX_SESSION_MS - 1;
    expect(s.expired).toBe(false);
    t += 1;
    expect(s.expired).toBe(true);
    expect(s.stop("timeout").reason).toBe("timeout");
  });

  it("stats carry counts and durations ONLY — nothing derived from the audio", () => {
    // This is the privacy contract expressed as a test: MicStats is the one thing from a mic
    // session that may be logged, and it stays loggable only while every field is a number.
    const s = new MicSession();
    s.start();
    s.accept(packet(0));
    const stats = s.stop("user");
    for (const [key, value] of Object.entries(stats)) {
      if (key === "reason") continue;
      expect(typeof value).toBe("number");
    }
    expect(Object.keys(stats).sort()).toEqual(
      ["audioMs", "duplicates", "elapsedMs", "malformed", "missing", "packets", "reason"].sort()
    );
  });

  it("flags a lossy capture instead of letting a hole become a confident sentence", () => {
    const clean = { packets: 100, duplicates: 0, missing: 1, malformed: 0, elapsedMs: 5000, audioMs: 5000, reason: "user" } as const;
    const lossy = { packets: 100, duplicates: 0, missing: 9, malformed: 0, elapsedMs: 5000, audioMs: 5000, reason: "user" } as const;
    const empty = { packets: 0, duplicates: 0, missing: 0, malformed: 0, elapsedMs: 20, audioMs: 0, reason: "user" } as const;
    expect(captureIsTrustworthy(clean)).toBe(true);
    expect(captureIsTrustworthy(lossy)).toBe(false);
    expect(captureIsTrustworthy(empty)).toBe(false);
  });
});

describe("audio control (EvenHub Cmd 15 / wrapper field 18)", () => {
  it("is Cmd 15 in field 1 and AudioCtrCmd in field 18", () => {
    expect(Cmd.AUDIO_CONTROL).toBe(15);
    expect(AUDIO_CTRL_FIELD).toBe(18);
  });

  it("encodes enable as {1:15, 2:magic, 18:{1:1}} and disable with AudoFuncEn=0", () => {
    // field 1 varint 15 -> 0x08 0x0f
    // field 2 varint 7  -> 0x10 0x07
    // field 18 LEN      -> tag (18<<3)|2 = 146 -> varint 0x92 0x01, len 2, {0x08, en}
    expect(Array.from(encodeAudioControl({ enable: true, magic: 7 }))).toEqual([
      0x08, 0x0f, 0x10, 0x07, 0x92, 0x01, 0x02, 0x08, 0x01,
    ]);
    expect(Array.from(encodeAudioControl({ enable: false, magic: 7 }))).toEqual([
      0x08, 0x0f, 0x10, 0x07, 0x92, 0x01, 0x02, 0x08, 0x00,
    ]);
  });

  it("differs from the same message on the wrong wrapper field — the silent-failure mode", () => {
    const right = encodeAudioControl({ enable: true, magic: 1 });
    const wrong = encodeAudioControl({ enable: true, magic: 1, field: 20 });
    expect(Array.from(right)).not.toEqual(Array.from(wrong));
  });
});
