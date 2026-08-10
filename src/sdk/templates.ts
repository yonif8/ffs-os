// templates.ts — the phone's half of the CFW payload SDK, on the phone at last.
//
// WHAT THIS REPLACES
// ------------------
// `g2flash/payloads/ffs_screen.c` and `ffs_dashboard.c` are INTERPRETERS: each carries a
// fixed-size descriptor in .rodata and renders whatever it finds there. A new screen — or a
// new dashboard configuration — is therefore DATA: find the descriptor in a prebuilt
// template, overwrite it, recompute the frame CRC, push. No compiler, no rebuild, no reflash.
//
// That rewriting used to live only in `g2flash/tools/patch_dash.py` / `patch_screen.py`, so
// every configuration had to be produced on a dev machine and injected with
//     adb shell am broadcast -a com.futurefounders.ffs.PUSH_PAYLOAD --es b64 <base64>
// This file is a faithful port of both, so the app can build its own descriptor at runtime
// and push it through `FfsBle.pushPayloadViaImage` like any other payload.
//
// ⚠️ THIS FILE, patch_dash.py, patch_screen.py, patches/ffs_screen.h AND ffs_dashboard.c ALL
// DESCRIBE THE SAME BYTES. Change one, change the others, and bump the version — the
// interpreters refuse a version they do not know, so a drift surfaces as a clean bit in the
// ret= mask (dashboard bit 15) instead of a garbage screen.
//
// Pure logic on purpose: no react-native import, so `bun test src/sdk` can check every byte
// against goldens produced by the Python tools (see __tests__/templates.test.ts).

import { toBase64, fromBase64 } from "./base64";
import { TEMPLATE_DASHBOARD, TEMPLATE_SCREEN, type PayloadTemplate } from "./templates.generated";

// ── the loader's frame (g2flash/patches/loader.c) ─────────────────────────────
//   +0  "FXP1"   +4 u32 body_len   +8 u32 crc32(body)   +12 body
const FRAME_MAGIC = [0x46, 0x58, 0x50, 0x31]; // "FXP1"
/** loader.c LDR_MAX_PAYLOAD. Over this the loader refuses with REJ_CAP. */
export const LDR_MAX_PAYLOAD = 8192;

/**
 * zlib/PKZIP CRC-32 (reflected, poly 0xEDB88320, init+xorout 0xFFFFFFFF).
 *
 * NOT the CRC32C in G2Flash.kt — that one is Castagnoli, MSB-first, and is for the OTA
 * component headers. Using it here produces a frame the loader rejects.
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Wrap a raw blob in the loader's FXP1 frame. */
export function frame(body: Uint8Array): Uint8Array {
  if (body.length === 0) throw new Error("empty payload");
  if (body.length > LDR_MAX_PAYLOAD)
    throw new Error(`payload ${body.length} B exceeds LDR_MAX_PAYLOAD (${LDR_MAX_PAYLOAD}) — the loader would REJ_CAP`);
  const out = new Uint8Array(12 + body.length);
  out.set(FRAME_MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, body.length, true);
  dv.setUint32(8, crc32(body), true);
  out.set(body, 12);
  return out;
}

/**
 * Locate the descriptor by its magic rather than by the offset baked in at generation time:
 * the offset moves whenever the interpreter's code size changes, and a stale offset would
 * silently corrupt CODE instead of data. Refuses on 0 or >1 matches for the same reason —
 * guessing would produce a blob that pushes "successfully" and does something else.
 */
export function findDescriptor(blob: Uint8Array, tpl: PayloadTemplate): number {
  const needle = [tpl.magic & 0xff, (tpl.magic >>> 8) & 0xff, (tpl.magic >>> 16) & 0xff, (tpl.magic >>> 24) & 0xff];
  let at = -1;
  for (let i = 0; i + 4 <= blob.length; i++) {
    if (blob[i] === needle[0] && blob[i + 1] === needle[1] && blob[i + 2] === needle[2] && blob[i + 3] === needle[3]) {
      if (at >= 0) throw new Error(`${tpl.id}: more than one descriptor magic in the blob; refusing to guess`);
      at = i;
    }
  }
  if (at < 0)
    throw new Error(
      `${tpl.id}: descriptor magic not found. The optimiser folds an all-scalar descriptor into ` +
        "the code unless the asm barrier is present — rebuild and check the blob grew a .rodata section.",
    );
  if (at + tpl.descBytes > blob.length)
    throw new Error(`${tpl.id}: descriptor at ${at} + ${tpl.descBytes} B runs past the ${blob.length} B blob — header drift?`);
  return at;
}

/** Overwrite a template's descriptor, re-frame, base64 — i.e. produce something pushable. */
export function patchTemplate(tpl: PayloadTemplate, desc: Uint8Array): string {
  if (desc.length !== tpl.descBytes)
    throw new Error(`${tpl.id}: descriptor is ${desc.length} B, template holds ${tpl.descBytes} B`);
  const blob = fromBase64(tpl.b64);
  if (blob.length !== tpl.bytes) throw new Error(`${tpl.id}: template decoded to ${blob.length} B, expected ${tpl.bytes}`);
  blob.set(desc, findDescriptor(blob, tpl));
  return toBase64(frame(blob));
}

// ═══ DASHBOARD — Even's real dashboard, our configuration ═════════════════════
//
// What is being configured is EVEN'S OWN dashboard: their watchface fonts, their date,
// their icons, their bordered widgets. We choose the design and the geometry; their code
// draws every pixel. Port of tools/patch_dash.py.

export const DASH_VERSION = 1;

export type DashConfig = {
  /** 0 = LEFT, 1 = CENTER, 2 = RIGHT. Where the watchface sits; the widget column takes the other side. */
  basePos: number;
  /** 0..5. CENTER with any widgets is rejected by their own layout validator. */
  widgetCount: number;
  /** widget types, 0..4; only the first `widgetCount` are read. Padded to 5 on the wire. */
  widgetOrder: number[];
  /** watchface DESIGN, 1..4: 1 big clock · 2 list face · 3 date+temperature · 4 world clocks */
  kind: number;
  /**
   * The watchface union, flattened; meaning depends on `kind` (payloads/ffs_dashboard.c):
   *   1: a=clock      b=left(<10)   c=right(<10)
   *   2: a=align(<3)  b=clock(<2)   c=date_en(<2)        n=list_count(<4)
   *   3: a=align(<3)  b=date_en(<2) c=temperature_en(<2)
   *   4: a=align(<3)  b=-                                n=world_clock_count(<4)
   */
  wf: [number, number, number];
  /** kind 2 and 4 only — the list / world-clock count. */
  n: number;
};

/** Even's own configuration, read out of the firmware's default template at 0x006dbb1c. */
export const DASH_STOCK: DashConfig = {
  basePos: 0,
  widgetCount: 5,
  widgetOrder: [0, 1, 2, 4, 3],
  kind: 1,
  wf: [0, 1, 4],
  n: 0,
};

export const BASE_POS_LABELS = ["LEFT", "CENTER", "RIGHT"] as const;

/**
 * The four watchface designs, as the firmware numbers them. Labels are what the design IS,
 * not what we wish it were — a wrong label here sends the next experiment the wrong way.
 */
export const WATCHFACE_KINDS: { kind: number; label: string; note: string }[] = [
  { kind: 1, label: "Big clock", note: "two-line clock + two side fields" },
  { kind: 2, label: "List face", note: "clock + date over a short list" },
  { kind: 3, label: "Date + temp", note: "date and temperature, no big clock" },
  { kind: 4, label: "World clocks", note: "up to 4 zones" },
];

/** Presets ported 1:1 from patch_dash.py's DEMOS, so a phone push and an adb push agree. */
export const DASH_PRESETS: { id: string; label: string; note: string; cfg: DashConfig }[] = [
  { id: "stock", label: "Stock", note: "Even's dashboard exactly as shipped — the A/B reference", cfg: { ...DASH_STOCK } },
  { id: "mirror", label: "Mirror", note: "the same thing with ONE byte changed: watchface right, widgets left", cfg: { ...DASH_STOCK, basePos: 2 } },
  { id: "centre", label: "Centre", note: "no widgets, so their apply_geo centres the face at x=188", cfg: { ...DASH_STOCK, basePos: 1, widgetCount: 0 } },
  { id: "temp", label: "Date+temp", note: "a different watchface DESIGN, not just a different position", cfg: { ...DASH_STOCK, basePos: 2, kind: 3, wf: [0, 1, 1] } },
  { id: "two", label: "Two widgets", note: "fewer widgets, reordered — the column is content-addressable too", cfg: { ...DASH_STOCK, basePos: 2, widgetCount: 2, widgetOrder: [3, 0, 0, 0, 0] } },
];

/**
 * Refuse here exactly what the firmware refuses.
 *
 * THIS IS THE WHOLE POINT OF VALIDATING CLIENT-SIDE: a descriptor the firmware rejects falls
 * back to the STOCK dashboard, which on the HUD is indistinguishable from "the push did
 * nothing". Same limits as ffs_dashboard.c's own `bad` check, in the same order.
 *
 * @returns null when the config is pushable, otherwise a human-readable reason.
 */
export function validateDashConfig(cfg: DashConfig): string | null {
  if (!Number.isInteger(cfg.basePos) || cfg.basePos < 0 || cfg.basePos > 2)
    return "base_pos must be 0 (LEFT), 1 (CENTER) or 2 (RIGHT)";
  if (!Number.isInteger(cfg.widgetCount) || cfg.widgetCount < 0 || cfg.widgetCount > 5)
    return "widget_count must be 0..5";
  if (cfg.basePos === 1 && cfg.widgetCount > 0)
    return "their layout validator rejects CENTER with widget_count>0 — drop the widgets or move the face";
  if (!Number.isInteger(cfg.kind) || cfg.kind < 1 || cfg.kind > 4) return "watchface kind must be 1..4";
  for (let i = 0; i < cfg.widgetCount; i++) {
    const w = cfg.widgetOrder[i];
    if (!Number.isInteger(w) || w < 0 || w > 4) return `widget ${i + 1} type ${w} out of range (0..4)`;
  }
  // Not a firmware rule — a packing rule. Silently wrapping a field would produce a valid
  // descriptor that says something we did not ask for.
  for (const [name, v] of [["wf_a", cfg.wf[0]], ["wf_b", cfg.wf[1]], ["wf_c", cfg.wf[2]]] as const)
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return `${name} must fit in a u32`;
  if (!Number.isInteger(cfg.n) || cfg.n < 0 || cfg.n > 0xffff) return "wf_n must fit in a u16";
  return null;
}

/** Pack a 32-byte `ffs_dash_desc_t`. `<IHBB5sB2xIIIHH` in patch_dash.py's terms. */
export function packDashDescriptor(cfg: DashConfig): Uint8Array {
  const out = new Uint8Array(TEMPLATE_DASHBOARD.descBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, TEMPLATE_DASHBOARD.magic, true);
  dv.setUint16(4, DASH_VERSION, true);
  out[6] = cfg.basePos;
  out[7] = cfg.widgetCount;
  for (let i = 0; i < 5; i++) out[8 + i] = cfg.widgetOrder[i] ?? 0;
  out[13] = cfg.kind;
  // out[14..15] are the struct's two pad bytes — left zero, as the C compiler leaves them.
  dv.setUint32(16, cfg.wf[0], true);
  dv.setUint32(20, cfg.wf[1], true);
  dv.setUint32(24, cfg.wf[2], true);
  dv.setUint16(28, cfg.n, true);
  dv.setUint16(30, 0, true); // _rsv
  return out;
}

/**
 * apply_geo restated, so the UI can say what the glasses SHOULD report back — and so a push
 * that "worked" can be graded against a number decided before it was sent.
 * The payload grades itself the same way (ret= bits 13/14, and watchface_x>>3 in bits 16..22).
 */
export function dashGeometry(cfg: DashConfig): { watchfaceX: number; widgetColX: number } {
  if (cfg.widgetCount === 0) return { watchfaceX: [0, 188, 376][cfg.basePos] ?? 0, widgetColX: 0 };
  return cfg.basePos === 2 ? { watchfaceX: 376, widgetColX: 0 } : { watchfaceX: 0, widgetColX: 224 };
}

/** Descriptor → framed → base64, ready for `FfsBle.pushPayloadViaImage`. Throws if invalid. */
export function buildDashboardPush(cfg: DashConfig): string {
  const bad = validateDashConfig(cfg);
  if (bad) throw new Error(bad);
  return patchTemplate(TEMPLATE_DASHBOARD, packDashDescriptor(cfg));
}

// ═══ SCREEN — our own containers, drawn by their firmware ═════════════════════
// Port of tools/patch_screen.py + patches/ffs_screen.h.

export const SCREEN_VERSION = 1;
export const SCREEN_MAX_SLOTS = 6;
export const SCREEN_MAX_ITEMS = 8;
export const SCREEN_TEXT_LEN = 24;
const SLOT_BYTES = 232;

const KIND = { none: 0, text: 1, list: 2 } as const;
const FLAG_BOUNCE_IN = 0x01;

export type ScreenSlot = {
  kind: keyof typeof KIND;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  items?: string[];
  /** bounce_animation_play on entry */
  bounce?: boolean;
  borderW?: number;
  /** GREY INDEX 0..15 — NOT rgb; 16 trips Even's off-by-one. */
  borderColor?: number;
  radius?: number;
  padding?: number;
  /** text cfg +0x10. Even always writes 1; whether it selects a font is still unproven. */
  font?: number;
};

/**
 * Presets ported from patch_screen.py, INCLUDING its hard-won constraint: every screen that
 * has worked on-glass is exactly one text slot plus one list. Two text slots renders only the
 * first and reports ret bit 6 (constructor returned NULL) with bit 15 clear — reproduced on a
 * freshly rebooted lens, so it is not heap exhaustion. Do not "improve" these into two texts.
 */
export const SCREEN_PRESETS: { id: string; label: string; note: string; slots: ScreenSlot[] }[] = [
  {
    id: "home",
    label: "Home",
    note: "launcher: FFS OS plate + a 5-row list",
    slots: [
      { kind: "text", x: 40, y: 18, w: 496, h: 46, text: "FFS OS", borderW: 2, radius: 10, padding: 6 },
      { kind: "list", x: 40, y: 78, w: 496, h: 190, bounce: true, items: ["CLOCK", "CAMERA", "MESSAGES", "SETTINGS", "ABOUT"] },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    note: "different in every visible way — pushing it after Home from the SAME blob is the proof that a screen is data",
    slots: [
      { kind: "text", x: 80, y: 30, w: 400, h: 40, text: "SETTINGS", borderW: 0, radius: 0, padding: 4 },
      { kind: "list", x: 80, y: 86, w: 400, h: 150, bounce: true, items: ["BRIGHTNESS", "SOUND", "HEBREW", "ABOUT"] },
    ],
  },
  {
    id: "dash",
    label: "Mirror dash",
    note: "our own containers mirroring Even's layout: clock RIGHT, widget column LEFT",
    slots: [
      { kind: "text", x: 300, y: 60, w: 250, h: 130, text: "14:32 MON 10", font: 1, borderW: 0, radius: 0, padding: 4 },
      {
        kind: "list",
        x: 30,
        y: 40,
        w: 250,
        h: 200,
        bounce: true,
        borderW: 2,
        radius: 10,
        padding: 8,
        items: ["NEWS  3 NEW", "WEATHER 24C", "STEPS  8421", "CAL  2 TODAY"],
      },
    ],
  },
];

/** ASCII, NUL-terminated, fixed width — truncating rather than overflowing the field. */
function packText(text: string): Uint8Array {
  const out = new Uint8Array(SCREEN_TEXT_LEN);
  const max = SCREEN_TEXT_LEN - 1;
  for (let i = 0; i < text.length && i < max; i++) {
    const c = text.charCodeAt(i);
    // Python's .encode("ascii", "replace") substitutes '?' for anything non-ASCII.
    out[i] = c < 0x80 ? c : 0x3f;
  }
  return out;
}

/** @returns null when the slots are pushable, otherwise a human-readable reason. */
export function validateScreen(slots: ScreenSlot[]): string | null {
  if (slots.length > SCREEN_MAX_SLOTS)
    return `${slots.length} slots; max is ${SCREEN_MAX_SLOTS} (raise FFS_MAX_SLOTS in ffs_screen.h AND here)`;
  for (const [i, s] of slots.entries()) {
    if (!(s.kind in KIND)) return `slot ${i}: unknown kind "${s.kind}"`;
    const items = s.items ?? [];
    if (items.length > SCREEN_MAX_ITEMS)
      return `slot ${i} has ${items.length} items; max is ${SCREEN_MAX_ITEMS}`;
    // The firmware returns NULL for item_count 0 or >20, which renders as a silent no-draw.
    if (s.kind === "list" && items.length === 0) return `slot ${i}: a list slot needs at least one item`;
  }
  return null;
}

function packSlot(s: ScreenSlot): Uint8Array {
  const out = new Uint8Array(SLOT_BYTES);
  const dv = new DataView(out.buffer);
  const items = s.items ?? [];
  out[0] = KIND[s.kind];
  out[1] = s.bounce ? FLAG_BOUNCE_IN : 0;
  out[2] = s.borderW ?? 2;
  out[3] = Math.min(s.borderColor ?? 15, 15);
  out[4] = s.radius ?? 10;
  out[5] = s.padding ?? 8;
  out[6] = items.length;
  out[7] = s.font ?? 1;
  dv.setInt16(8, s.x ?? 0, true);
  dv.setInt16(10, s.y ?? 0, true);
  dv.setInt16(12, s.w ?? 0, true);
  dv.setInt16(14, s.h ?? 0, true);
  out.set(packText(s.text ?? ""), 16);
  for (let i = 0; i < SCREEN_MAX_ITEMS; i++) out.set(packText(items[i] ?? ""), 40 + i * SCREEN_TEXT_LEN);
  return out;
}

/** Pack the whole `ffs_screen_desc_t`: 12-byte header + SCREEN_MAX_SLOTS fixed slots. */
export function packScreenDescriptor(slots: ScreenSlot[]): Uint8Array {
  const bad = validateScreen(slots);
  if (bad) throw new Error(bad);
  const out = new Uint8Array(TEMPLATE_SCREEN.descBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, TEMPLATE_SCREEN.magic, true);
  dv.setUint16(4, SCREEN_VERSION, true);
  dv.setUint16(6, slots.length, true);
  dv.setUint32(8, 0, true); // _rsv
  for (let i = 0; i < SCREEN_MAX_SLOTS; i++) out.set(packSlot(slots[i] ?? { kind: "none" }), 12 + i * SLOT_BYTES);
  return out;
}

/** Slots → framed → base64, ready for `FfsBle.pushPayloadViaImage`. Throws if invalid. */
export function buildScreenPush(slots: ScreenSlot[]): string {
  return patchTemplate(TEMPLATE_SCREEN, packScreenDescriptor(slots));
}
