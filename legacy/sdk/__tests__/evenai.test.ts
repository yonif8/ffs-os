// Even-AI wire tests — the "Hey Even" wake-word CONFIG.
//
// Cross-checked against MentraOS `EvenAIProto.setHeyEven` (reference/MentraOS/.../sgcs/G2.kt, MIT)
// and the generated schema `reference/g2-kit-unofficial/ble/gen/even_ai_pb.ts`. The byte golden
// below is the exact frame MentraOS's builder emits, so a match is real cross-implementation
// evidence rather than the encoder agreeing with itself.

import { EvenAiCmd, HEY_EVEN_STREAM_SPEED, SID_EVEN_AI, setHeyEven } from "../evenai";
import { parseFields, sub, u32 } from "../proto";

describe("even-ai — Hey Even wake word", () => {
  it("service id is 0x07", () => {
    expect(SID_EVEN_AI).toBe(0x07);
  });

  it("enable writes CONFIG(10) with voiceSwitch=1 and streamSpeed=32 in config (field 13)", () => {
    const f = parseFields(setHeyEven(50, true))!;
    expect(u32(f, 1)).toBe(EvenAiCmd.CONFIG);
    expect(u32(f, 2)).toBe(50); // magic
    const cfg = parseFields(sub(f, 13)!)!;
    expect(u32(cfg, 1)).toBe(1);                      // voiceSwitch on
    expect(u32(cfg, 2)).toBe(HEY_EVEN_STREAM_SPEED);  // 32
  });

  it("disable OMITS voiceSwitch (proto3 default) but still sends streamSpeed", () => {
    const cfg = parseFields(sub(parseFields(setHeyEven(51, false))!, 13)!)!;
    expect(sub(cfg, 1)).toBeUndefined();
    // voiceSwitch is a varint, so check it as absent via u32 too
    expect(u32(cfg, 1)).toBeUndefined();
    expect(u32(cfg, 2)).toBe(HEY_EVEN_STREAM_SPEED);
  });

  /**
   * BYTE GOLDEN — the literal frame MentraOS's `setHeyEven(magic, true)` produces. Field 13's tag
   * is 13<<3|2 = 106 = 0x6a; config length is 4 (08 01 10 20).
   */
  it("emits the exact bytes MentraOS emits for an enable", () => {
    expect(Array.from(setHeyEven(77, true))).toEqual([
      0x08, 0x0a,             // f1 commandId = 10 (CONFIG)
      0x10, 0x4d,             // f2 magicRandom = 77
      0x6a, 0x04,             // f13 config, len 4
      0x08, 0x01,             //   f1 voiceSwitch = 1
      0x10, 0x20,             //   f2 streamSpeed = 32
    ]);
  });

  it("disable byte golden — no voiceSwitch, config is just streamSpeed", () => {
    expect(Array.from(setHeyEven(77, false))).toEqual([
      0x08, 0x0a,             // f1 commandId = 10 (CONFIG)
      0x10, 0x4d,             // f2 magicRandom = 77
      0x6a, 0x02,             // f13 config, len 2
      0x10, 0x20,             //   f2 streamSpeed = 32
    ]);
  });
});
