// templates.test.ts — byte parity with the Python patchers.
//
// src/sdk/templates.ts is a hand port of g2flash/tools/patch_dash.py and patch_screen.py.
// A hand port of a binary struct layout is exactly the kind of code that type-checks, builds,
// pushes "successfully" and then renders the STOCK dashboard, because a rejected descriptor
// falls back to stock and that is indistinguishable from "nothing happened" on the HUD.
//
// So every golden below was produced by running the Python tool that is being ported, on the
// same blob that is bundled in templates.generated.ts:
//
//   for d in stock mirror centre temp two; do
//     python3 tools/patch_dash.py --demo $d obj/ffs_dashboard.text.bin
//   done | while read b; do python3 -c "import base64,zlib,sys;\
//     f=base64.b64decode(sys.argv[1]);print(len(f),hex(zlib.crc32(f)))" "$b"; done
//
// crc32 over the WHOLE framed payload is the fingerprint: it covers the frame header, the
// untouched interpreter code and the patched descriptor at once, so any single-byte drift in
// any of them fails here rather than on the glasses.

// describe/it/expect are `bun test` globals — the rest of src/sdk/__tests__ relies on them
// too, and tsconfig.json excludes this directory from tsc for exactly that reason.

import { fromBase64 } from "../base64";
import {
  DASH_PRESETS,
  DASH_STOCK,
  SCREEN_PRESETS,
  buildDashboardPush,
  buildScreenPush,
  crc32,
  dashGeometry,
  frame,
  packDashDescriptor,
  validateDashConfig,
  validateScreen,
  type DashConfig,
} from "../templates";
import { TEMPLATE_DASHBOARD, TEMPLATE_SCREEN } from "../templates.generated";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fingerprint = (b64: string) => {
  const f = fromBase64(b64);
  return { bytes: f.length, crc: crc32(f) };
};

describe("crc32 (zlib)", () => {
  it("matches the published check values", () => {
    // The two vectors every CRC-32 implementation is checked against.
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    // Catches sign extension on the high byte, which a 0..127 test would not.
    expect(crc32(new Uint8Array(256).map((_, i) => i))).toBe(0x29058c73);
  });
});

describe("FXP1 framing", () => {
  it("is magic + length + crc32(body) + body", () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const f = frame(body);
    expect(f.length).toBe(17);
    // "FXP1" — the loader reads this as 0x31505846 and rejects anything else.
    expect(hex(f.subarray(0, 4))).toBe("46585031");
    const dv = new DataView(f.buffer, f.byteOffset);
    expect(dv.getUint32(4, true)).toBe(5);
    expect(dv.getUint32(8, true)).toBe(crc32(body));
    expect(hex(f.subarray(12))).toBe("0102030405");
  });

  it("refuses a payload the loader would REJ_CAP", () => {
    expect(() => frame(new Uint8Array(8193))).toThrow(/8192/);
  });
});

describe("bundled templates", () => {
  it("decode to the blob the generator measured", () => {
    for (const t of [TEMPLATE_DASHBOARD, TEMPLATE_SCREEN]) {
      const blob = fromBase64(t.b64);
      expect(blob.length).toBe(t.bytes);
      expect(crc32(blob)).toBe(t.crc32);
      // The magic really is where the generator said, little-endian.
      const dv = new DataView(blob.buffer, blob.byteOffset);
      expect(dv.getUint32(t.descOffset, true)).toBe(t.magic);
    }
  });
});

describe("dashboard descriptor", () => {
  // Descriptor bytes straight out of patch_dash.py, read back from its framed output.
  const GOLDEN_DESC: Record<string, string> = {
    stock: "4653444201000005000102040301000000000000010000000400000000000000",
    mirror: "4653444201000205000102040301000000000000010000000400000000000000",
    centre: "4653444201000100000102040301000000000000010000000400000000000000",
    temp: "4653444201000205000102040303000000000000010000000100000000000000",
    two: "4653444201000202030000000001000000000000010000000400000000000000",
  };
  // { framed length, crc32(framed) } from the same runs.
  const GOLDEN_PUSH: Record<string, number> = {
    stock: 0x0255f1d8,
    mirror: 0x0508bb4f,
    centre: 0x95198cb9,
    temp: 0x42913858,
    two: 0x6a02a612,
  };

  it("packs 32 bytes identical to patch_dash.py for every preset", () => {
    for (const p of DASH_PRESETS) {
      expect(hex(packDashDescriptor(p.cfg))).toBe(GOLDEN_DESC[p.id]);
    }
  });

  it("produces a framed push byte-identical to patch_dash.py", () => {
    for (const p of DASH_PRESETS) {
      const f = fingerprint(buildDashboardPush(p.cfg));
      expect(f.bytes).toBe(664); // 12 B frame + the 652 B interpreter
      expect(f.crc).toBe(GOLDEN_PUSH[p.id]);
    }
  });

  it("keeps widget_order when widget_count drops to zero", () => {
    // patch_dash.py's `centre` demo does exactly this, and the firmware reads only the first
    // widget_count entries — so zeroing the tail would be a silent divergence from the tool.
    const centre = DASH_PRESETS.find((p) => p.id === "centre")!;
    expect(hex(packDashDescriptor(centre.cfg)).slice(16, 26)).toBe("0001020403");
  });
});

describe("dashboard validation mirrors the firmware's own", () => {
  const cfg = (over: Partial<DashConfig>): DashConfig => ({ ...DASH_STOCK, ...over });

  it("accepts the stock configuration", () => {
    expect(validateDashConfig(DASH_STOCK)).toBeNull();
  });

  it("refuses CENTER with widgets — the case that renders stock and looks like a no-op", () => {
    expect(validateDashConfig(cfg({ basePos: 1, widgetCount: 3 }))).toMatch(/CENTER/);
    // ...and allows it once the widgets are gone.
    expect(validateDashConfig(cfg({ basePos: 1, widgetCount: 0 }))).toBeNull();
  });

  it("refuses every out-of-range field", () => {
    expect(validateDashConfig(cfg({ basePos: 3 }))).toMatch(/base_pos/);
    expect(validateDashConfig(cfg({ basePos: -1 }))).toMatch(/base_pos/);
    expect(validateDashConfig(cfg({ widgetCount: 6 }))).toMatch(/widget_count/);
    expect(validateDashConfig(cfg({ kind: 0 }))).toMatch(/kind/);
    expect(validateDashConfig(cfg({ kind: 5 }))).toMatch(/kind/);
    expect(validateDashConfig(cfg({ widgetOrder: [0, 1, 2, 4, 9] }))).toMatch(/widget 5/);
    // Only the first widget_count entries are read, so a junk tail is legal.
    expect(validateDashConfig(cfg({ widgetCount: 2, widgetOrder: [0, 1, 9, 9, 9] }))).toBeNull();
  });

  it("throws rather than pushing something the firmware would reject", () => {
    expect(() => buildDashboardPush(cfg({ basePos: 1 }))).toThrow(/CENTER/);
  });
});

describe("dashGeometry restates apply_geo", () => {
  it("matches the table the payload grades itself against", () => {
    const g = (basePos: number, widgetCount: number) => dashGeometry({ ...DASH_STOCK, basePos, widgetCount });
    expect(g(0, 0)).toEqual({ watchfaceX: 0, widgetColX: 0 });
    expect(g(1, 0)).toEqual({ watchfaceX: 188, widgetColX: 0 });
    expect(g(2, 0)).toEqual({ watchfaceX: 376, widgetColX: 0 });
    // With widgets the face is pinned to one edge and the column takes the other.
    expect(g(0, 5)).toEqual({ watchfaceX: 0, widgetColX: 224 });
    expect(g(2, 5)).toEqual({ watchfaceX: 376, widgetColX: 0 });
  });
});

describe("screen descriptor", () => {
  const GOLDEN_PUSH: Record<string, number> = {
    home: 0x6316311f,
    settings: 0x7bb68947,
    dash: 0x05fefd1a,
  };

  it("produces a framed push byte-identical to patch_screen.py", () => {
    for (const p of SCREEN_PRESETS) {
      const f = fingerprint(buildScreenPush(p.slots));
      expect(f.bytes).toBe(2488); // 12 B frame + the 2476 B interpreter
      expect(f.crc).toBe(GOLDEN_PUSH[p.id]);
    }
  });

  it("refuses a list with no items — the firmware NULLs on item_count 0 and draws nothing", () => {
    expect(validateScreen([{ kind: "list", items: [] }])).toMatch(/at least one item/);
    expect(() => buildScreenPush([{ kind: "list" }])).toThrow(/at least one item/);
  });

  it("refuses more slots or items than the descriptor holds", () => {
    expect(validateScreen(new Array(7).fill({ kind: "none" }))).toMatch(/max is 6/);
    expect(validateScreen([{ kind: "list", items: new Array(9).fill("x") }])).toMatch(/max is 8/);
  });

  it("truncates rather than overflowing a fixed text field", () => {
    const b64 = buildScreenPush([{ kind: "text", text: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" }]);
    const blob = fromBase64(b64).subarray(12);
    const at = TEMPLATE_SCREEN.descOffset + 12 + 16; // desc + header + slot.text
    // 23 characters plus the NUL the firmware needs — never 24 characters and no terminator.
    expect(new TextDecoder().decode(blob.subarray(at, at + 23))).toBe("0123456789ABCDEFGHIJKLM");
    expect(blob[at + 23]).toBe(0);
  });
});
