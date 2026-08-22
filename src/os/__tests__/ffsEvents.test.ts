// Golden byte-vectors for the FFS inbound event bus (sid 0x91), pinned to
// g2flash/patches/ffs_event.h (contract version 1). These vectors ARE the
// contract's phone-side golden — the CFW emitter must reproduce these exact bytes.
// Change them only in lockstep with a FFS_EVT_VER bump on BOTH ends.

import {
  decodeFfsEvent,
  decodeGesture,
  describeFfsEvent,
  FFS_EVT_SID,
  FFS_EVT_VER,
  FFS_EVT_SRC_SYS,
  FFS_EVT_SYS_GESTURE,
  FFS_EVT_APP_SELECT,
  G2_G_ROLL_DOWN,
} from "../ffsEvents";

const bytes = (...b: number[]) => Uint8Array.from(b);

describe("FFS event bus wire constants", () => {
  it("mirrors ffs_event.h", () => {
    expect(FFS_EVT_SID).toBe(0x91);
    expect(FFS_EVT_VER).toBe(0x01);
    expect(FFS_EVT_SRC_SYS).toBe(0x00);
    expect(FFS_EVT_SYS_GESTURE).toBe(0x01);
    expect(FFS_EVT_APP_SELECT).toBe(0x01);
    expect(G2_G_ROLL_DOWN).toBe(0x44);
  });
});

describe("decodeFfsEvent — golden byte-vectors", () => {
  it("GOLDEN 1: system GESTURE roll-down frame", () => {
    // ver src type flags | seq(LE)=1 | len(LE)=5 | code=0x44 x=0 y=0
    const frame = bytes(0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x05, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00);
    const evt = decodeFfsEvent(frame)!;
    expect(evt).not.toBeNull();
    expect(evt.ver).toBe(0x01);
    expect(evt.src).toBe(0x00);
    expect(evt.type).toBe(0x01);
    expect(evt.flags).toBe(0x00);
    expect(evt.seq).toBe(1);
    expect(Array.from(evt.payload)).toEqual([0x44, 0x00, 0x00, 0x00, 0x00]);

    const g = decodeGesture(evt)!;
    expect(g).not.toBeNull();
    expect(g.code).toBe(0x44);
    expect(g.x).toBe(0);
    expect(g.y).toBe(0);
    expect(describeFfsEvent(evt)).toContain("code=0x44(ROLL_DOWN)");
  });

  it("GOLDEN 2: app SELECT frame (src=7, type=1, index=3)", () => {
    // src=7, type=SELECT(1), flags=0, seq=10, len=2, payload uint16 index=3
    const frame = bytes(0x01, 0x07, 0x01, 0x00, 0x0a, 0x00, 0x02, 0x00, 0x03, 0x00);
    const evt = decodeFfsEvent(frame)!;
    expect(evt).not.toBeNull();
    expect(evt.src).toBe(7);
    expect(evt.type).toBe(FFS_EVT_APP_SELECT);
    expect(evt.seq).toBe(10);
    expect(Array.from(evt.payload)).toEqual([0x03, 0x00]);
    // uint16 LE index from the payload
    const index = evt.payload[0] | (evt.payload[1] << 8);
    expect(index).toBe(3);
    // Not a system gesture — decodeGesture refuses it.
    expect(decodeGesture(evt)).toBeNull();
  });

  it("GOLDEN 3: malformed/short frame → null", () => {
    // Only 5 bytes — shorter than the 8-byte header.
    expect(decodeFfsEvent(bytes(0x01, 0x00, 0x01, 0x00, 0x01))).toBeNull();
    // Empty.
    expect(decodeFfsEvent(bytes())).toBeNull();
  });

  it("rejects a wrong version byte", () => {
    const frame = bytes(0x02, 0x00, 0x01, 0x00, 0x01, 0x00, 0x05, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00);
    expect(decodeFfsEvent(frame)).toBeNull();
  });

  it("rejects a len that overruns the buffer", () => {
    // len=5 but only 2 payload bytes present.
    const frame = bytes(0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x05, 0x00, 0x44, 0x00);
    expect(decodeFfsEvent(frame)).toBeNull();
  });

  it("accepts a zero-length payload (len=0)", () => {
    const frame = bytes(0x01, 0x00, 0x03, 0x01, 0x07, 0x00, 0x00, 0x00);
    const evt = decodeFfsEvent(frame)!;
    expect(evt).not.toBeNull();
    expect(evt.type).toBe(0x03); // WEAR
    expect(evt.flags).toBe(0x01); // right/master lens bit
    expect(evt.seq).toBe(7);
    expect(evt.payload.length).toBe(0);
  });

  it("sign-extends negative gesture coordinates (x=-1, y=-2)", () => {
    // code=TAP(0x0A), x=0xFFFF=-1, y=0xFFFE=-2
    const frame = bytes(0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x0a, 0xff, 0xff, 0xfe, 0xff);
    const g = decodeGesture(decodeFfsEvent(frame)!)!;
    expect(g.code).toBe(0x0a);
    expect(g.x).toBe(-1);
    expect(g.y).toBe(-2);
  });

  it("decodes a two-byte LE seq correctly", () => {
    // seq = 0x1234 = 4660
    const frame = bytes(0x01, 0x00, 0x01, 0x00, 0x34, 0x12, 0x05, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00);
    expect(decodeFfsEvent(frame)!.seq).toBe(0x1234);
  });
});
