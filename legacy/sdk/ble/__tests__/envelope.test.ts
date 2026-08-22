// aa21 transport framing — byte-pinned against the proven native G2Transport.buildPackets, plus a
// round-trip guarantee (frame -> reassemble -> original, CRC verified).

import {
  Counters,
  Flag,
  MAX_PACKET_PAYLOAD,
  SID,
  frameMessage,
  parseFrame,
  reassemble,
} from "../envelope";
import { crc16CcittFalse } from "../crc";

describe("frameMessage — single fragment", () => {
  const pb = Uint8Array.from([0x08, 0x01, 0x10, 0x2a]);
  const frames = frameMessage(pb, { syncId: 0x07, sid: SID.UI_BACKGROUND_EVENHUB, flag: Flag.REQUEST });

  it("produces exactly one frame for a short payload", () => {
    expect(frames.length).toBe(1);
  });

  it("is byte-identical to the hand-computed frame", () => {
    // header(8) = AA 21 syncId len(=4+2) tot(1) serial(1) sid(0xe0) flag(0x20)
    // + pb(4) + crc16LE(0xB068 -> 68 B0)
    expect(Array.from(frames[0]!)).toEqual([
      0xaa, 0x21, 0x07, 0x06, 0x01, 0x01, 0xe0, 0x20,
      0x08, 0x01, 0x10, 0x2a,
      0x68, 0xb0,
    ]);
  });

  it("appends CRC-16/CCITT-FALSE little-endian over the whole pb", () => {
    const crc = crc16CcittFalse(pb);
    const f = frames[0]!;
    expect(f[f.length - 2]! | (f[f.length - 1]! << 8)).toBe(crc);
  });
});

describe("frameMessage — fragmentation", () => {
  it("splits an oversized payload into 236-byte chunks with a shared syncId", () => {
    const pb = new Uint8Array(500);
    for (let i = 0; i < pb.length; i++) pb[i] = i & 0xff;
    const frames = frameMessage(pb, { syncId: 0x11, sid: SID.UI_BACKGROUND_EVENHUB, flag: Flag.REQUEST });
    // 500 -> 236 + 236 + 28  => 3 frames
    expect(frames.length).toBe(3);
    for (const f of frames) {
      expect(f[2]).toBe(0x11); // ONE shared syncId — reassembly group key
      expect(f[4]).toBe(3); // totalPackets
    }
    expect(frames[0]![5]).toBe(1); // serial 1-based
    expect(frames[2]![5]).toBe(3);
    // Only the last frame carries the +2 CRC in its length byte.
    expect(frames[0]![3]).toBe(236);
    expect(frames[1]![3]).toBe(236);
    expect(frames[2]![3]).toBe(28 + 2);
  });

  it("appends an empty trailing CRC packet when the last chunk is exactly maxPayload", () => {
    const pb = new Uint8Array(MAX_PACKET_PAYLOAD * 2); // 472 -> two full 236 chunks
    const frames = frameMessage(pb, { syncId: 1, sid: SID.UI_BACKGROUND_EVENHUB, flag: Flag.REQUEST });
    // 2 full chunks + 1 empty CRC-carrier = 3 frames (the G2Transport edge case).
    expect(frames.length).toBe(3);
    expect(frames[2]!.length).toBe(8 + 2); // header + CRC only, no data
    expect(frames[2]![3]).toBe(2);
  });
});

describe("round-trip", () => {
  it("reassemble(frameMessage(x)) === x and verifies the CRC", () => {
    for (const len of [0, 1, 4, 235, 236, 237, 472, 500, 1000]) {
      const pb = new Uint8Array(len);
      for (let i = 0; i < len; i++) pb[i] = (i * 13 + 7) & 0xff;
      const frames = frameMessage(pb, { syncId: 9, sid: SID.UI_BACKGROUND_EVENHUB, flag: Flag.REQUEST });
      const back = reassemble(frames);
      expect(back).not.toBeNull();
      expect(Array.from(back!)).toEqual(Array.from(pb));
    }
  });

  it("reassemble returns null on a corrupted CRC", () => {
    const pb = Uint8Array.from([1, 2, 3, 4]);
    const frames = frameMessage(pb, { syncId: 1, sid: SID.UI_BACKGROUND_EVENHUB, flag: Flag.REQUEST });
    const bad = Uint8Array.from(frames[0]!);
    bad[bad.length - 1]! ^= 0xff; // flip a CRC byte
    expect(reassemble([bad])).toBeNull();
  });

  it("parseFrame reads the header fields back", () => {
    const pb = Uint8Array.from([0x08, 0x01]);
    const f = frameMessage(pb, { syncId: 0x2a, sid: SID.UI_SETTING, flag: Flag.REQUEST })[0]!;
    const p = parseFrame(f);
    expect(p).toMatchObject({ ok: true, isTx: true, syncId: 0x2a, sid: SID.UI_SETTING, flag: 0x20, serial: 1, totalPackets: 1 });
    expect(Array.from(p.chunk)).toEqual([0x08, 0x01]);
  });
});

describe("safety", () => {
  it("REFUSES to frame sid 0x80 (dev_config)", () => {
    expect(() => frameMessage(Uint8Array.from([1]), { syncId: 0, sid: 0x80, flag: Flag.REQUEST })).toThrow(/0x80/);
  });

  it("SID enum marks the safe render/control channels and the forbidden one", () => {
    expect(SID.UI_BACKGROUND_EVENHUB).toBe(0xe0);
    expect(SID.UI_SETTING).toBe(0x09);
    expect(SID.UX_DEVICE_SETTINGS_FORBIDDEN).toBe(0x80);
  });
});

describe("Counters", () => {
  it("hands out syncId and magic independently, wrapping at 256", () => {
    const c = new Counters(254, 0);
    expect(c.nextSyncId()).toBe(254);
    expect(c.nextSyncId()).toBe(255);
    expect(c.nextSyncId()).toBe(0); // wrapped
    expect(c.nextMagic()).toBe(0);
    expect(c.nextMagic()).toBe(1);
  });
});
