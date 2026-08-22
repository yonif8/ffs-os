// Raster + zlib tests.
//
// The zlib stream is the risky part: the firmware only accepts a frame if inflate reaches
// Z_STREAM_END with total_out == width*height, and a wrong adler32 or block header makes it
// stop short. That failure is SILENT on-glass — the previous frame stays up, which looks
// exactly like "nothing was sent". So the stream is checked against a real inflater here.

import { inflateSync } from "node:zlib";
import { adler32, zlibStored } from "../deflate";
import { Raster } from "../raster";
import { parseImageAck } from "../events";

describe("zlibStored", () => {
  it("produces a stream a real inflater accepts, byte for byte", () => {
    for (const n of [0, 1, 5, 4096, 70000]) {
      const src = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      const round = new Uint8Array(inflateSync(Buffer.from(zlibStored(src))));
      expect(Array.from(round)).toEqual(Array.from(src));
    }
  });

  it("spans multiple stored blocks past the 65535 limit", () => {
    const src = Uint8Array.from({ length: 140000 }, (_, i) => i & 0xff);
    expect(new Uint8Array(inflateSync(Buffer.from(zlibStored(src)))).length).toBe(140000);
  });

  it("adler32 matches the RFC 1950 reference value", () => {
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e60398);
  });

  it("the zlib header passes the %31 check inflate performs first", () => {
    const z = zlibStored(Uint8Array.from([1, 2, 3]));
    expect(((z[0] << 8) | z[1]) % 31).toBe(0);
  });
});

describe("Raster", () => {
  it("is exactly width*height bytes — the size the firmware demands", () => {
    const r = new Raster(96, 64);
    expect(r.data.length).toBe(96 * 64);
  });

  it("drops out-of-bounds writes rather than wrapping to the next row", () => {
    const r = new Raster(8, 8);
    r.px(-1, 0, 255);
    r.px(8, 0, 255);
    r.px(0, 8, 255);
    expect(Array.from(r.data).every((v) => v === 0)).toBe(true);
  });

  it("blend only lightens — the panel is emissive, so drawing adds light", () => {
    const r = new Raster(4, 4);
    r.px(1, 1, 200);
    r.blend(1, 1, 100);
    expect(r.at(1, 1)).toBe(200);
    r.blend(1, 1, 250);
    expect(r.at(1, 1)).toBe(250);
  });

  it("antialiases a rounded corner rather than stepping it", () => {
    const r = new Raster(40, 40).fillRoundRect(0, 0, 40, 40, 10, 255);
    // A hard-edged fill would contain only 0 and 255; smooth corners produce intermediates.
    const mids = Array.from(r.data).filter((v) => v > 0 && v < 255).length;
    expect(mids).toBeGreaterThan(10);
  });

  it("toMode2 emits the mode byte then a valid stream of exactly w*h bytes", () => {
    const r = new Raster(32, 16).fillRect(0, 0, 32, 16, 128);
    const msg = r.toMode2(zlibStored);
    expect(msg[0]).toBe(0x02);
    const back = new Uint8Array(inflateSync(Buffer.from(msg.subarray(1))));
    expect(back.length).toBe(32 * 16);
    expect(back.every((v) => v === 128)).toBe(true);
  });
});

describe("parseImageAck", () => {
  /** Build ImgResCmd: envelope f6 { f3 session, f6 fragment, f8 errorCode }. */
  function ack(session: number, fragment: number, err: number) {
    const inner = [0x18, session, 0x30, fragment, 0x40, err]; // f3, f6, f8 varints
    return Uint8Array.from([0x08, 0x02, 0x32, inner.length, ...inner]);
  }

  it("reads session and fragment, and treats errorCode 4 as SUCCESS", () => {
    expect(parseImageAck(ack(3, 2, 4))).toEqual({ session: 3, fragment: 2, ok: true });
  });

  it("any other errorCode is a failure — 0 is NOT success here", () => {
    expect(parseImageAck(ack(1, 0, 0))?.ok).toBe(false);
  });

  it("returns null for a frame that is not an image ack", () => {
    expect(parseImageAck(Uint8Array.from([0x08, 0x02]))).toBeNull();
  });
});
