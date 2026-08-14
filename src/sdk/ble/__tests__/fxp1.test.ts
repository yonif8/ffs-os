// The FXP1 CFW-push builder — byte-pinned frame, image-raw fragmentation, and an end-to-end push
// of a real FFSP program assembled by program.ts.

import {
  IMG_FRAGMENT_SIZE,
  LDR_MAX_PAYLOAD,
  buildFxp1Push,
  chunkImageRaw,
  fxp1Frame,
} from "../fxp1";
import { Counters } from "../envelope";
import { crc32 } from "../crc";
import { frame as templatesFrame } from "../../templates";
import { parseFields, sub, u32 } from "../../proto";
import { assemble, park } from "../../program";

describe("fxp1Frame", () => {
  it("lays out magic + len(LE) + crc32(LE) + body exactly", () => {
    const body = Uint8Array.from([1, 2, 3, 4, 5]);
    // Precomputed: crc32([1,2,3,4,5]) = 0x470B99F4
    expect(Array.from(fxp1Frame(body))).toEqual([
      0x46, 0x58, 0x50, 0x31, // "FXP1"
      0x05, 0x00, 0x00, 0x00, // len = 5, LE
      0xf4, 0x99, 0x0b, 0x47, // crc32 = 0x470B99F4, LE
      0x01, 0x02, 0x03, 0x04, 0x05,
    ]);
  });

  it("carries a body CRC-32 the loader would accept", () => {
    const body = Uint8Array.from([9, 8, 7, 6, 5, 4]);
    const f = fxp1Frame(body);
    const dv = new DataView(f.buffer);
    expect(dv.getUint32(4, true)).toBe(body.length);
    expect(dv.getUint32(8, true)).toBe(crc32(body));
  });

  it("is byte-identical to templates.ts frame() (drift guard)", () => {
    const body = Uint8Array.from([10, 20, 30, 40]);
    expect(Array.from(fxp1Frame(body))).toEqual(Array.from(templatesFrame(body)));
  });

  it("refuses empty and oversized bodies", () => {
    expect(() => fxp1Frame(new Uint8Array(0))).toThrow(/empty/);
    expect(() => fxp1Frame(new Uint8Array(LDR_MAX_PAYLOAD + 1))).toThrow(/REJ_CAP/);
  });
});

describe("chunkImageRaw", () => {
  it("splits an oversized image-raw payload into 4096-byte Cmd-3 fragments", () => {
    const payload = new Uint8Array(IMG_FRAGMENT_SIZE + 100); // 4196 -> 2 fragments
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    let m = 40;
    const msgs = chunkImageRaw(payload, { sessionId: 129 }, () => ++m);
    expect(msgs.length).toBe(2);

    const inner = (msg: Uint8Array) => parseFields(sub(parseFields(msg)!, 5)!)!;
    const a = inner(msgs[0]!);
    const b = inner(msgs[1]!);

    // Both carry the WHOLE payload's totalSize (f4), a per-fragment packet size (f7), and a
    // 0-based incrementing fragmentIndex (f6) — the proven native shape.
    expect(u32(a, 3)).toBe(129); // session
    expect(u32(a, 4)).toBe(payload.length); // totalSize
    expect(u32(a, 6)).toBe(0); // fragmentIndex
    expect(u32(a, 7)).toBe(IMG_FRAGMENT_SIZE); // this fragment's byte count
    expect(u32(b, 4)).toBe(payload.length);
    expect(u32(b, 6)).toBe(1);
    expect(u32(b, 7)).toBe(100);

    // Cmd (f1) is 3 and magic (f2) is per-fragment.
    expect(u32(parseFields(msgs[0]!)!, 1)).toBe(3);
    expect(u32(parseFields(msgs[0]!)!, 2)).toBe(41);
    expect(u32(parseFields(msgs[1]!)!, 2)).toBe(42);
  });

  it("returns no messages for an empty payload", () => {
    expect(chunkImageRaw(new Uint8Array(0), { sessionId: 1 }, () => 0)).toEqual([]);
  });
});

describe("buildFxp1Push end-to-end", () => {
  it("wraps a real FFSP program image and produces aa21 frames on sid 0xe0", () => {
    const image = assemble(park()).image; // a real, small FFSP program image
    expect(image.length).toBeGreaterThan(0);

    const push = buildFxp1Push(image, { sessionId: 7, counters: new Counters(0, 100) });

    // FXP1 frame wraps the exact program image.
    expect(Array.from(push.fxp1.subarray(0, 4))).toEqual([0x46, 0x58, 0x50, 0x31]);
    expect(new DataView(push.fxp1.buffer).getUint32(4, true)).toBe(image.length);
    expect(Array.from(push.fxp1.subarray(12))).toEqual(Array.from(image));

    // A small program fits in a single 4096 image-raw fragment.
    expect(push.imageRawMessages.length).toBe(1);
    // ...and its Cmd-3 message frames as aa21 on the EvenHub sid with the REQUEST flag.
    expect(push.frames.length).toBeGreaterThanOrEqual(1);
    for (const f of push.frames) {
      expect(f[0]).toBe(0xaa);
      expect(f[1]).toBe(0x21);
      expect(f[6]).toBe(0xe0); // sid = EvenHub
      expect(f[7]).toBe(0x20); // flag = REQUEST
    }
  });

  it("reassembling the frames of each image-raw message recovers that Cmd-3 pb", async () => {
    const { reassemble } = await import("../envelope");
    const image = assemble(park()).image;
    const push = buildFxp1Push(image, { sessionId: 3, counters: new Counters(0, 0) });
    // Single message here, so all frames belong to it.
    const back = reassemble(push.frames);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(push.imageRawMessages[0]!));
  });
});
