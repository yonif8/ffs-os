// SDK step-0 acceptance: the pure TypeScript encoder must be byte-identical to the proven native
// path, and the event normalizer must handle the frames the glasses actually sent.
//
// Runs on Windows with no glasses in the room. That is deliberate — it is what lets the on-glass
// run confirm ONE thing instead of debugging a whole stack.

import { encodeListPage, encodeListContainer, encodePageContainer, encodeEnvelope, encodeImuControl, Cmd } from "../wire";
import { normalizeEvent, EventType, EventSource } from "../events";
import { ProtoWriter, fromHex, hex, parseFields, u32, sub, str } from "../proto";

describe("proto codec", () => {
  it("round-trips varints across the multi-byte boundary", () => {
    // 127/128 is where varints grow a byte; 300 is the canonical two-byte case.
    for (const v of [0, 1, 127, 128, 255, 300, 576, 16383, 16384, 100000]) {
      const w = new ProtoWriter();
      w.int32(1, v);
      expect(u32(parseFields(w.data), 1)).toBe(v);
    }
  });

  it("rejects a negative varint instead of encoding 10 bytes of two's complement", () => {
    const w = new ProtoWriter();
    expect(() => w.int32(1, -1)).toThrow(RangeError);
  });

  it("returns null for a truncated length-delimited field rather than throwing", () => {
    // Field 1, wiretype 2, claims 9 bytes but only 2 follow. Radios produce this; it is not
    // exceptional, so the parser must report it as "not a message" and move on.
    expect(parseFields(fromHex("0a09aabb"))).toBeNull();
  });

  it("round-trips UTF-8 including Hebrew", () => {
    const w = new ProtoWriter();
    w.string(10, "שלום");
    expect(str(parseFields(w.data), 10)).toBe("שלום");
  });
});

describe("encodeListPage — byte-identical to the native listPageMessage", () => {
  // Reproduces G2Protocol.kt listPageMessage(items, rebuild=false, magic) exactly:
  //   ListObject f1..f4 geometry, f5..f8 zeros, f9 id, f10 name, f11 items, f12 capture
  //   page f1 count, f2 ListObject
  //   envelope f1 Cmd, f2 magic, f3|f7 page
  function expectedListPage(items: string[], rebuild: boolean, magic: number): Uint8Array {
    const lc = encodeListContainer({
      x: 0,
      y: 0,
      width: 576,
      height: 288,
      containerId: 3,
      containerName: "ffs-list",
      items,
      isEventCapture: true,
    });
    const page = encodePageContainer({ lists: [lc] });
    return rebuild
      ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, magic)
      : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, magic);
  }

  it("CREATE uses Cmd 0 in sub-field 3", () => {
    const bytes = encodeListPage({ items: ["AAAA"], rebuild: false, magic: 100 });
    expect(hex(bytes)).toBe(hex(expectedListPage(["AAAA"], false, 100)));
    const f = parseFields(bytes)!;
    expect(u32(f, 1)).toBe(Cmd.CREATE_STARTUP_PAGE);
    expect(u32(f, 2)).toBe(100);
    expect(sub(f, 3)).toBeDefined();
    expect(sub(f, 7)).toBeUndefined();
  });

  it("REBUILD uses Cmd 7 in sub-field 7 — a second CREATE is silently ignored by the firmware", () => {
    const f = parseFields(encodeListPage({ items: ["AAAA"], rebuild: true, magic: 101 }))!;
    expect(u32(f, 1)).toBe(Cmd.REBUILD_PAGE);
    expect(sub(f, 7)).toBeDefined();
    expect(sub(f, 3)).toBeUndefined();
  });

  it("declares the item count, the names, and the capture flag the firmware needs", () => {
    const items = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"];
    const page = parseFields(sub(parseFields(encodeListPage({ items, rebuild: false, magic: 7 })), 3)!)!;
    expect(u32(page, 1)).toBe(1); // one container on the page
    const lo = parseFields(sub(page, 2)!)!;
    expect(u32(lo, 3)).toBe(576);
    expect(u32(lo, 4)).toBe(288);
    expect(u32(lo, 9)).toBe(3);
    expect(str(lo, 10)).toBe("ffs-list");
    expect(u32(lo, 12)).toBe(1); // IsEventCapture

    const item = parseFields(sub(lo, 11)!)!;
    expect(u32(item, 1)).toBe(items.length);
    expect(u32(item, 3)).toBe(1); // select border
  });

  it("a capturing list page carries NO evt-0 container — the trap that freezes a list", () => {
    // Exactly ONE container, and it is the list (field 2). An evt-0 text container would appear
    // as field 3 and would steal the event binding, leaving the list rendered but frozen.
    const page = parseFields(sub(parseFields(encodeListPage({ items: ["A"], rebuild: false, magic: 1 })), 3)!)!;
    expect(u32(page, 1)).toBe(1);
    expect(sub(page, 2)).toBeDefined();
    expect(sub(page, 3)).toBeUndefined();
  });

  it("is deterministic — same input, same bytes", () => {
    const a = encodeListPage({ items: ["X", "Y"], rebuild: false, magic: 5 });
    const b = encodeListPage({ items: ["X", "Y"], rebuild: false, magic: 5 });
    expect(hex(a)).toBe(hex(b));
  });

  /**
   * PARITY WITH THE NATIVE ENCODER — the actual step-0 acceptance.
   *
   * Comparing encodeListPage against a helper in this file would be self-referential: it proves
   * determinism, not parity. These byte counts were LOGGED BY THE KOTLIN DRIVER on hardware
   * ("showList: created NATIVE list page, 4 items, NNB"), so matching them is evidence that the
   * TypeScript encoder emits what the proven path emits.
   *
   * The +24 entries are runs where showList also co-declared the 576x288 raster container on the
   * same page (so a payload push has a landing target without rebuilding the page and destroying
   * the list); that container is a fixed 24 bytes.
   */
  const NATIVE_SIZES: [string[], number, string][] = [
    [["AAAA", "BBBB", "CCCC", "DDDD"], 75, "logged 75B, list only"],
    [["AAAA", "BBBB", "CCCC", "DDDD"], 99 - 24, "logged 99B incl. raster container"],
    [["ONE", "TWO", "THREE", "FOUR"], 98 - 24, "logged 98B incl. raster container"],
    [["Clock", "Notifications", "Settings", "About"], 114 - 24, "logged 114B incl. raster container"],
    [["BRIGHT TEST", "Second Row", "Third Row", "Fourth Row"], 123 - 24, "logged 123B incl. raster container"],
  ];

  it.each(NATIVE_SIZES)("matches the byte count the native driver logged: %p", (items, expected) => {
    expect(encodeListPage({ items, rebuild: false, magic: 100 }).length).toBe(expected);
  });
});

describe("normalizeEvent — GOLDEN VECTORS captured off the glasses 2026-08-07", () => {
  /** envelope: Cmd(1)=2 OS_NOITY_EVENT_TO_APP_PACKET, DevEvent(13)=<body> */
  const envelope = (bodyHex: string) => {
    const body = fromHex(bodyHex);
    const out = [0x08, 0x02, 0x6a, body.length, ...Array.from(body)];
    return Uint8Array.from(out);
  };

  it("row-0 tap has NO index field and still decodes as index 0", () => {
    // CAPTURED: temple tap with the highlight on row 0.
    // ListEvent{ContainerID=3, ContainerName="ffs-list"} — no index, no type: both are 0.
    const e = normalizeEvent(envelope("0a0c080312086666732d6c697374"));
    expect(e).not.toBeNull();
    expect(e!.kind).toBe("select");
    if (e!.kind !== "select") return;
    expect(e!.containerId).toBe(3);
    expect(e!.containerName).toBe("ffs-list");
    expect(e!.index).toBe(0); // THE bug this pins
    expect(e!.type).toBe(EventType.CLICK);
  });

  it("row-1 tap reports the selected index", () => {
    // CAPTURED: scrolled on-glass to row 1, then tapped. `2001` = field 4 varint 1.
    const e = normalizeEvent(envelope("0a0e080312086666732d6c6973742001"));
    expect(e!.kind).toBe("select");
    if (e!.kind !== "select") return;
    expect(e!.index).toBe(1);
    expect(e!.containerName).toBe("ffs-list");
  });

  it("double tap arrives as a SYS event carrying its source", () => {
    // CAPTURED: double tap on the right temple, with a list on screen — it does NOT come through
    // as a list event.
    const e = normalizeEvent(envelope("1a0408031001"));
    expect(e!.kind).toBe("sys");
    if (e!.kind !== "sys") return;
    expect(e!.type).toBe(EventType.DOUBLE_CLICK);
    expect(e!.source).toBe(EventSource.GLASSES_R);
  });

  it("an absent EventSource stays unknown rather than defaulting to a source", () => {
    // EventSource has no zero member, so absent must NOT become 0 — guessing here would
    // misattribute every ring press to the right temple.
    const e = normalizeEvent(envelope("1a020803"));
    expect(e!.kind).toBe("sys");
    if (e!.kind !== "sys") return;
    expect(e!.source).toBeUndefined();
  });

  it("a heartbeat is not mistaken for an event", () => {
    expect(normalizeEvent(fromHex("080c10137a02100c"))).toBeNull();
  });

  it("garbage decodes to null instead of throwing", () => {
    expect(normalizeEvent(fromHex("ffffffff"))).toBeNull();
    expect(normalizeEvent(new Uint8Array(0))).toBeNull();
  });
});

/**
 * IMU control + sample decoding.
 *
 * Two traps are pinned here, both of which fail as SILENCE rather than as an error:
 *  - the wrapper is field 22 (generated schema + faceclaw), not 20 (MentraOS's prose);
 *  - samples are wire-type-5 FLOAT32 even though the schema declares them `double`.
 * A parser that steps over wire type 5 reports a permanently empty IMU stream, which is
 * indistinguishable from hardware that simply never sends anything.
 */
describe("IMU", () => {
  it("enables with a pace in wrapper field 22", () => {
    const b = encodeImuControl({ enable: true, magic: 77, pace: 500 });
    const f = parseFields(b)!;
    expect(u32(f, 1)).toBe(Cmd.IMU_CONTROL);
    expect(u32(f, 2)).toBe(77);
    const ctrl = parseFields(sub(f, 22)!)!;
    expect(u32(ctrl, 1)).toBe(1);
    expect(u32(ctrl, 2)).toBe(500);
  });

  /**
   * A BYTE golden, not just a field read.
   *
   * Field 22 is the first wrapper field whose tag does not fit one byte (22<<3|2 = 178), so it
   * encodes as the two-byte varint b2 01. A parse-then-assert test cannot catch a regression in
   * that tag, because the same writer produces both sides of the comparison — it would agree with
   * itself while the glasses saw a different field. These are the literal bytes that must leave
   * the phone.
   */
  it("emits the exact bytes for an enable at pace 500", () => {
    expect(Array.from(encodeImuControl({ enable: true, magic: 77, pace: 500 }))).toEqual([
      0x08, 0x13,             // f1 Cmd = 19 (APP_REQUEST_OPEN_IMU_PACKET)
      0x10, 0x4d,             // f2 MagicRandom = 77
      0xb2, 0x01, 0x05,       // f22 ImuCtrl, len 5  <- the two-byte tag
      0x08, 0x01,             //   f1 IMUReportEn = 1
      0x10, 0xf4, 0x03,       //   f2 reportFrq = 500
    ]);
  });

  it("omits the pace when disabling", () => {
    const ctrl = parseFields(sub(parseFields(encodeImuControl({ enable: false, magic: 1 }))!, 22)!)!;
    expect(u32(ctrl, 1)).toBe(0);
    expect(sub(ctrl, 2)).toBeUndefined();
  });

  it("decodes a float32 sample — reading it as the schema's `double` would yield nothing", () => {
    // Build SysEvent{1: type=8, 3: IMU_Report_Data{1:x, 2:y, 3:z}} with wire-type-5 floats.
    const f32le = (v: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, v, true);
      return b;
    };
    const imu: number[] = [];
    [0.25, -1.5, 9.75].forEach((v, i) => {
      imu.push(((i + 1) << 3) | 5, ...Array.from(f32le(v)));
    });
    const sys = [0x08, 0x08, 0x1a, imu.length, ...imu];
    const dev = [0x1a, sys.length, ...sys];
    const frame = Uint8Array.from([0x08, 0x02, 0x6a, dev.length, ...dev]);

    const e = normalizeEvent(frame);
    expect(e?.kind).toBe("imu");
    expect(e).toMatchObject({ x: 0.25, y: -1.5, z: 9.75 });
  });
});
