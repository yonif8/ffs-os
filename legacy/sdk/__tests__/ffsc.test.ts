// The phone's FFSC encoder, pinned to the bytes the on-glass parser is tested against.
//
// `ffsc_golden.json` is written by `g2flash/tools/ffsc_ref.py --emit-json`; the SAME
// vectors go into `g2flash/tools/ffsc_golden.h`, which `g2flash/tools/test_data_channel.c`
// feeds to the shipping C parser. So these tests do not check that this encoder agrees with
// itself — they check that it agrees with the thing on the other end of the wire.
//
// Regenerate both after any layout change:
//     python g2flash/tools/ffsc_ref.py --emit-c --emit-json

import { describe, expect, it } from "bun:test";
import {
  FFSC_HDR_LEN,
  FFSC_MAX_BLOB,
  FFSC_OP_CLEAR,
  FFSC_OP_PUT,
  decodeFfsc,
  decodeFfscRet,
  encodeFfsc,
} from "../ffsc";
import golden from "./ffsc_golden.json";

type Vector = { name: string; app_id: number; seq: number; op: number; blob: number[]; frame: number[] };
const vectors = golden as unknown as Vector[];

describe("FFSC frames match the reference encoder byte for byte", () => {
  for (const v of vectors) {
    it(v.name, () => {
      const got = encodeFfsc({
        appId: v.app_id,
        seq: v.seq,
        blob: new Uint8Array(v.blob),
        op: v.op,
      });
      expect(Array.from(got)).toEqual(v.frame);
    });
  }

  it("covers the real 304-byte FFSM inbox, not just toy blobs", () => {
    const inbox = vectors.find((v) => v.name === "messages_inbox");
    expect(inbox).toBeDefined();
    expect(inbox!.blob.length).toBe(304);
    // the cargo really is an FFSM store — the two formats are pinned together end to end
    expect(String.fromCharCode(...inbox!.blob.slice(0, 4))).toBe("FFSM");
  });
});

describe("round trip", () => {
  it("decodes what it encodes", () => {
    const blob = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
    const d = decodeFfsc(encodeFfsc({ appId: 42, seq: 1234, blob }));
    expect(d.ver).toBe(1);
    expect(d.op).toBe(FFSC_OP_PUT);
    expect(d.appId).toBe(42);
    expect(d.seq).toBe(1234);
    expect(Array.from(d.blob)).toEqual(Array.from(blob));
  });

  it("wraps seq at 16 bits rather than throwing", () => {
    expect(decodeFfsc(encodeFfsc({ appId: 3, seq: 0x1_0001, blob: new Uint8Array([9]) })).seq).toBe(1);
  });

  it("a CLEAR carries no blob", () => {
    const f = encodeFfsc({ appId: 3, seq: 5, op: FFSC_OP_CLEAR, blob: new Uint8Array([1, 2, 3]) });
    expect(f.length).toBe(FFSC_HDR_LEN);
    expect(decodeFfsc(f).blob.length).toBe(0);
  });

  it("rejects a frame whose blob was corrupted in flight", () => {
    const f = encodeFfsc({ appId: 3, seq: 1, blob: new Uint8Array([7, 7, 7, 7]) });
    f[FFSC_HDR_LEN] ^= 0x01;
    expect(() => decodeFfsc(f)).toThrow(/CRC/);
  });

  it("rejects a frame whose length field lies", () => {
    const f = encodeFfsc({ appId: 3, seq: 1, blob: new Uint8Array([7, 7, 7, 7]) });
    new DataView(f.buffer).setUint16(10, 999, true);
    expect(() => decodeFfsc(f)).toThrow(/past the frame/);
  });
});

describe("every refusal the glasses would make happens HERE instead", () => {
  const blob = new Uint8Array([1]);
  it("app_id 0", () => expect(() => encodeFfsc({ appId: 0, seq: 1, blob })).toThrow(/app_id/));
  it("app_id 0xFFFF", () => expect(() => encodeFfsc({ appId: 0xffff, seq: 1, blob })).toThrow(/app_id/));
  it("an empty PUT", () =>
    expect(() => encodeFfsc({ appId: 3, seq: 1, blob: new Uint8Array(0) })).toThrow(/empty blob/));
  it("a blob over the cap", () =>
    expect(() => encodeFfsc({ appId: 3, seq: 1, blob: new Uint8Array(FFSC_MAX_BLOB + 1) })).toThrow(
      /G2D_MAX_BLOB/
    ));
  it("a blob exactly at the cap is fine", () =>
    expect(encodeFfsc({ appId: 3, seq: 1, blob: new Uint8Array(FFSC_MAX_BLOB).fill(1) }).length).toBe(
      FFSC_HDR_LEN + FFSC_MAX_BLOB
    ));
  it("an unknown op", () => expect(() => encodeFfsc({ appId: 3, seq: 1, blob, op: 9 })).toThrow(/unknown op/));
  it("a negative seq", () => expect(() => encodeFfsc({ appId: 3, seq: -1, blob })).toThrow(/seq/));
});

describe("the ret= word", () => {
  it("reads an accepted PUT", () => {
    const r = decodeFfscRet(0x64000103);
    expect(r.isChannel).toBe(true);
    expect(r.errName).toBe("NONE");
    expect(r.op).toBe(FFSC_OP_PUT);
    expect(r.seqLow).toBe(1);
    expect(r.slot).toBe(0);
    expect(r.duplicate).toBe(false);
    expect(r.evicted).toBe(false);
  });

  it("reads a refused grow — and that it is a refusal, not a loss", () => {
    const r = decodeFfscRet(0x64700ff0); // err=OOM, seq=0x0f, slot=0xF (nothing written)
    expect(r.errName).toBe("OOM");
    expect(r.slot).toBeNull();
  });

  it("reads a duplicate", () => {
    const r = decodeFfscRet(0x64000204); // err=0, seq=2, slot=0, DUP bit
    expect(r.duplicate).toBe(true);
  });

  it("reads an eviction", () => {
    expect(decodeFfscRet(0x64000119).evicted).toBe(true); // slot 1, EVICT bit, 1 channel
  });

  it("refuses to interpret an app-install word as a channel word", () => {
    expect(decodeFfscRet(0x7a000000).isChannel).toBe(false);
  });
});
