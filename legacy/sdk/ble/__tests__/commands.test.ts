// The typed frame-level command builders — each returns aa21 frames on the correct sid, plus the
// magic/syncId it consumed. Checks the two NEW inner encoders (heartbeat, shutdown) field-by-field
// and confirms channel routing for the composed builders.

import {
  brightness,
  encodeHeartbeat,
  encodeShutdown,
  headUpAngle,
  heartbeat,
  heyEven,
  imuControl,
  listPage,
  readStatus,
  screenDepth,
  screenHeight,
  shutdown,
  silentMode,
  updateText,
  wearDetection,
} from "../commands";
import { Counters, parseFrame, reassemble } from "../envelope";
import { parseFields, sub, u32 } from "../../proto";

describe("new inner encoders", () => {
  it("heartbeat is Cmd 12 with HeartBeatPacket{Cnt} in wrapper field 14", () => {
    const f = parseFields(encodeHeartbeat(205, 3))!;
    expect(u32(f, 1)).toBe(12); // Cmd
    expect(u32(f, 2)).toBe(205); // MagicRandom
    const hb = parseFields(sub(f, 14)!)!;
    expect(u32(hb, 1)).toBe(3); // Cnt
  });

  it("shutdown is Cmd 9 with ShutDownContaniner{exitMode} in wrapper field 11", () => {
    const f = parseFields(encodeShutdown(204, 0))!;
    expect(u32(f, 1)).toBe(9);
    expect(u32(f, 2)).toBe(204);
    expect(sub(f, 11)).toBeDefined();
  });
});

describe("channel routing", () => {
  it("EvenHub builders frame on sid 0xe0 flag REQUEST", () => {
    const c = new Counters(0, 0);
    for (const m of [
      listPage(c, { items: ["A", "B"], rebuild: false }),
      updateText(c, { containerId: 1, content: "hi" }),
      heartbeat(c),
      shutdown(c),
      imuControl(c, { enable: true, pace: 100 }),
    ]) {
      const p = parseFrame(m.frames[0]!);
      expect(p.sid).toBe(0xe0);
      expect(p.flag).toBe(0x20);
    }
  });

  it("settings builders frame on sid 0x09", () => {
    const c = new Counters(0, 0);
    for (const m of [
      brightness(c, 15),
      silentMode(c, true),
      wearDetection(c, true),
      readStatus(c),
      headUpAngle(c, 30),
      screenHeight(c, 4),
      screenDepth(c, 4),
    ]) {
      expect(parseFrame(m.frames[0]!).sid).toBe(0x09);
    }
  });

  it("Hey Even frames on sid 0x07 flag REQUEST and round-trips to a CONFIG pb", () => {
    const c = new Counters(0, 0);
    const m = heyEven(c, true);
    const p = parseFrame(m.frames[0]!);
    expect(p.sid).toBe(0x07);
    expect(p.flag).toBe(0x20);
    const pb = reassemble(m.frames)!;
    expect(u32(parseFields(pb)!, 1)).toBe(10); // commandId = CONFIG
  });
});

describe("counter consumption + reassembly", () => {
  it("each command consumes one magic then one syncId, and its frames round-trip", () => {
    const c = new Counters(10, 50);
    const hb = heartbeat(c);
    expect(hb.magic).toBe(50); // first magic consumed
    expect(hb.syncId).toBe(10); // first syncId consumed
    const back = reassemble(hb.frames);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(hb.pb));

    // Next command advances both counters.
    const bt = brightness(c, 15);
    expect(bt.magic).toBe(51);
    expect(bt.syncId).toBe(11);
  });

  it("the pb inside a heartbeat frame decodes back to Cmd 12", () => {
    const c = new Counters(0, 7);
    const m = heartbeat(c, 0);
    const pb = reassemble(m.frames)!;
    expect(u32(parseFields(pb)!, 1)).toBe(12);
    expect(u32(parseFields(pb)!, 2)).toBe(7); // magic threaded through
  });
});
