// On-glass telemetry decoder — Carrier A (payload return, tag 0x7D) + Carrier B (LD05 always-on).
//
// Design of record: g2flash/docs/ONGLASS-TELEMETRY.md. It changes NO wire contract
// (patches/ffs_prog.h is untouched); tag 0x7D is a house payload-return convention.
//
// TWO carriers, decoded transparently by decodeTelemetryField104():
//   • Carrier A (no flash): the diagnostic payload (g2flash/payloads/ffs_telemetry.c) returns a
//     packed u32 from payload_main(); the loader stores it in st->ldr_last_ret and it surfaces in
//     protobuf FIELD 104 (the "LD04"/"LD05" loader record) at +12. Requires a 0x7D push to have
//     run. `source: "A"`.
//   • Carrier B (flash-gated, always-on): patches/loader.c's LD04→LD05 appends a structured
//     telemetry block at +68, present on EVERY device-info read with NO push. `source: "B"`.
//
// The bit layout of Carrier A matches payloads/ffs_telemetry.c EXACTLY. ⚠️ 2026-08-14: bit 19 is
// `vm_present`, NOT the low bit of a reject code (the payload can't see bidi_state_t's rej_code;
// it comes from the LD04 block at +56 instead). vm_present disambiguates the 3-bit vm_status
// sentinel: read vm_status only when vm_present === 1.

import { parseFields, sub } from "./proto";

/** Byte offsets inside the field-104 loader record (see g2flash/patches/loader.c). */
const LD = {
  MARKER: 0, // "LD04" (68 B) or "LD05" (88 B) ASCII
  GEN: 4, // frames ACCEPTED
  RAN_GEN: 8, // frames EXECUTED
  LAST_RET: 12, // payload_main()'s return — where Carrier-A tag-0x7D telemetry lands
  LEN: 16,
  REJ: 52, // how many frames were refused
  REJ_CODE: 56, // LDR_REJ_* of the most recent refusal (0 = last frame accepted)
  LD04_LEN: 68, // LD04 total; the reject block is +52..+68
  // --- Carrier B (LD05) appended telemetry block ---
  B_FREE_BYTES: 68, // u32 largest MALLOC that succeeded this emit (bytes)
  B_ACTIVE_NODE: 72, // u32 mgr[0] (0 if mgr NULL/insane)
  B_ACTIVE_ID: 76, // u16 *(u16*)(mgr[0]+0x00)
  B_GATES: 78, // u8  b0 sane, b1 root, b2 overlay, b3 base-active, b4 vm_present
  B_LENS: 79, // u8  G2FW_LENS_SIDE (1 right / 2 left)
  B_VM_STATUS: 80, // u32 resident FFSP_ST_* (0xFFFFFFFF if no VM)
  B_VM_GEN: 84, // u32 resident VM generation
  LD05_LEN: 88, // LD05 total
} as const;

/** House telemetry tag in the top byte of the Carrier-A return value. */
export const TELEMETRY_TAG_A = 0x7d;

/** Loader frame-reject reasons (patches/loader.c LDR_REJ_*). */
export const LDR_REJ: Record<number, string> = {
  0: "NONE(accepted)",
  1: "SHORT(no header)",
  2: "CAP(over max payload)",
  3: "NOMAGIC(no FXP1 — not ours)",
  4: "BADLEN(body_len 0 or > arrived)",
  5: "CRC(payload CORRUPT)",
  6: "OOM(malloc failed)",
  7: "BUSY(payload executing)",
};

/** FFSP program status (patches/ffs_prog.h FFSP_ST_*). */
export const FFSP_ST: Record<number, string> = {
  0: "OK",
  1: "MAGIC",
  2: "ABI",
  3: "CRC",
  4: "LEN",
  5: "UNKNOWN_REQUIRED",
  6: "CTOR_NULL",
  7: "DATUM",
};

/** Lens the reply came from (G2FW_LENS_SIDE: 2=left, 1=right). */
export const LENS_SIDE: Record<number, string> = { 0: "unknown", 1: "right", 2: "left" };

/**
 * Decode the low 6 bits of the active page id into a known page, if recognised.
 * Known ids (ffs_prog.h §4 + even_menu_mirror.c): 0x0FF5 overlay, 0x0FF6 base, 3 Even's menu.
 * Carrier A packs only 6 bits, so we match on `id & 0x3F`; Carrier B carries the full 16.
 */
export function activePageLabel(id: number): string {
  const low6 = id & 0x3f;
  switch (low6) {
    case 0x0ff5 & 0x3f: // 0x35
      return "overlay(0x0FF5)";
    case 0x0ff6 & 0x3f: // 0x36
      return "base(0x0FF6)";
    case 3:
      return "even-menu(3)";
    case 0x3f:
      return "none/unknown";
    default:
      return `id&0x3F=0x${low6.toString(16)}`;
  }
}

/** Structured telemetry. The first five fields are the task's minimal contract. */
export interface Telemetry {
  /** Pool A largest contiguous free block, in KB. The number that predicts OOM. */
  pool_free_kb: number;
  /** Active page id (Carrier A: low 6 bits; Carrier B: full 16). 0x3F/0 = none/unknown. */
  active_id: number;
  /** FFSP_ST_* of the resident VM. ONLY meaningful when vm_present is true. */
  vm_status: number;
  /** Last loader frame-reject code (LDR_REJ_*), read from the LD0x block at +56. */
  rej_code: number;
  /** Which lens produced this reply: 1=right, 2=left, 0=unknown. Self-reported by the firmware. */
  lens: number;

  // --- provenance / disambiguation ---
  /** "A" = Carrier-A payload return (needed a push); "B" = Carrier-B always-on LD05 block. */
  source: "A" | "B";
  /** True if a resident FFSP VM was found (bit 19 in A; gate bit 4 in B). vm_status valid iff set. */
  vm_present: boolean;
  /** Human labels for the enum fields. */
  labels: { active: string; vmStatus: string; rejCode: string; lens: string };
  /** Carrier A only: true iff the last_ret tag byte was 0x7D (i.e. really telemetry). */
  valid: boolean;
  /** The raw value decoded (Carrier A: last_ret; Carrier B: 0). */
  lastRet: number;
  /** Carrier B extras (0/absent for Carrier A). */
  active_node?: number;
  vm_gen?: number;
  gates?: number;
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function u16le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8)) & 0xffff;
}

function labelsFor(active_id: number, vm_status: number, rej_code: number, lens: number) {
  return {
    active: activePageLabel(active_id),
    vmStatus: FFSP_ST[vm_status] ?? `?${vm_status}`,
    rejCode: LDR_REJ[rej_code] ?? `?${rej_code}`,
    lens: LENS_SIDE[lens] ?? `?${lens}`,
  };
}

/**
 * Decode a Carrier-A payload return value (ldr_last_ret) — the tag-0x7D u32.
 * `rejCode` is not carried in this value; pass it from the LD0x block (+56) or leave 0.
 */
export function decodeTelemetryA(lastRet: number, rejCode = 0): Telemetry {
  const r = lastRet >>> 0;
  const tag = (r >>> 24) & 0xff;
  const pool_free_kb = r & 0x3ff; // bits 0..9
  const active_id = (r >>> 10) & 0x3f; // bits 10..15
  const vm_status = (r >>> 16) & 0x07; // bits 16..18
  const vm_present = ((r >>> 19) & 0x01) === 1; // bit 19
  const lens = (r >>> 22) & 0x03; // bits 22..23
  const rej_code = rejCode & 0x7;
  return {
    pool_free_kb,
    active_id,
    vm_status,
    rej_code,
    lens,
    source: "A",
    vm_present,
    labels: labelsFor(active_id, vm_status, rej_code, lens),
    valid: tag === TELEMETRY_TAG_A,
    lastRet: r,
  };
}

/** Decode the Carrier-B (LD05) appended block. `body` must be a >=88-byte LD05 record. */
export function decodeTelemetryB(body: Uint8Array): Telemetry {
  const freeBytes = u32le(body, LD.B_FREE_BYTES);
  const active_node = u32le(body, LD.B_ACTIVE_NODE);
  const active_id = u16le(body, LD.B_ACTIVE_ID);
  const gates = body[LD.B_GATES];
  const lens = body[LD.B_LENS] & 0x03;
  const vmStatusRaw = u32le(body, LD.B_VM_STATUS);
  const vm_gen = u32le(body, LD.B_VM_GEN);
  const rej_code = u32le(body, LD.REJ_CODE) & 0x7;
  const vm_present = (gates & 0x10) !== 0 && vmStatusRaw !== 0xffffffff;
  const vm_status = vm_present ? vmStatusRaw & 0x7 : 0;
  return {
    pool_free_kb: Math.floor(freeBytes / 1024),
    active_id,
    vm_status,
    rej_code,
    lens,
    source: "B",
    vm_present,
    labels: labelsFor(active_id, vm_status, rej_code, lens),
    valid: true,
    lastRet: 0,
    active_node,
    vm_gen,
    gates,
  };
}

/**
 * Decode the raw protobuf FIELD 104 loader record into telemetry, transparently across carriers.
 *
 *  • "LD05" (>=88 B): decode the always-on Carrier-B block (authoritative, no push needed).
 *  • "LD04" (>=20 B): decode Carrier-A from last_ret (+12), rej_code from +56 — valid only if a
 *    0x7D telemetry payload actually ran (check `.valid`).
 *
 * Returns null if the buffer is not a recognised loader record.
 */
export function decodeTelemetryField104(body: Uint8Array): Telemetry | null {
  if (body.length < 4) return null;
  const marker = String.fromCharCode(body[0], body[1], body[2], body[3]);
  if (marker === "LD05" && body.length >= LD.LD05_LEN) return decodeTelemetryB(body);
  if (marker !== "LD04" && marker !== "LD05") return null;
  if (body.length < 20) return null; // need at least through last_ret
  const lastRet = u32le(body, LD.LAST_RET);
  const rejCode = body.length >= LD.LD04_LEN ? u32le(body, LD.REJ_CODE) : 0;
  return decodeTelemetryA(lastRet, rejCode);
}

/** Outer protobuf field carrying the loader record (settings_ext.c: field 104, `0xC2 0x06`). */
export const DEVICE_INFO_FIELD_104 = 104;

/**
 * Decode telemetry straight from a raw service-0x09 (G2_SETTING) device-info frame — the bytes
 * the native driver hands JS on `onServiceRaw`. Pulls outer field 104 (the LD04/LD05 loader
 * record) and decodes it transparently across carriers. This is the numeric path the dev view
 * prefers over regex-scraping the version string; it also picks up the always-on Carrier-B block
 * with no push once the LD05 loader is flashed. Returns null if the frame carries no field 104.
 */
export function telemetryFromDeviceFrame(payload: Uint8Array): Telemetry | null {
  const f = parseFields(payload);
  const ld = sub(f, DEVICE_INFO_FIELD_104);
  if (!ld) return null;
  return decodeTelemetryField104(ld);
}

/**
 * Extract a Carrier-A telemetry value from a device-info version string that embeds the loader
 * record as `⟨LOADER … ret=0xNNNN …⟩` (how the native driver surfaces field 104 today, so the
 * dev view needs NO native change). Returns null if no 0x7D ret is present.
 */
export function decodeTelemetryFromVersionString(version: string | null | undefined): Telemetry | null {
  if (!version) return null;
  const m = version.match(/ret=0x([0-9A-Fa-f]+)/);
  if (!m) return null;
  const v = parseInt(m[1], 16) >>> 0;
  if ((v >>> 24) !== TELEMETRY_TAG_A) return null;
  // rej_code, if present, rides the same string as `rej=N/…`.
  const rm = version.match(/rej=\d+\/([A-Z]+)/);
  let rej = 0;
  if (rm) {
    const idx = Object.entries(LDR_REJ).find(([, s]) => s.startsWith(rm[1]));
    if (idx) rej = Number(idx[0]);
  }
  return decodeTelemetryA(v, rej);
}

/**
 * Group a stream of readings by the lens that produced them (self-reported stamp). This is how the
 * dev view shows BOTH lenses without depending on the BLE layer's deduped "whichever answered":
 * each reading carries its own lens, so right- and left-sourced readings separate themselves.
 * ⚠️ In practice today only the RIGHT lens both runs the pushed payload and replies (the push path
 * is RIGHT-hardwired and the LEFT arm is silent on async events, FUT-159) — see
 * ONGLASS-TELEMETRY.md §6. A left-labelled reading appearing here is itself the on-glass proof
 * that the per-lens path works.
 */
export function groupByLens(readings: Telemetry[]): { right: Telemetry[]; left: Telemetry[]; unknown: Telemetry[] } {
  const out = { right: [] as Telemetry[], left: [] as Telemetry[], unknown: [] as Telemetry[] };
  for (const t of readings) {
    if (t.lens === 1) out.right.push(t);
    else if (t.lens === 2) out.left.push(t);
    else out.unknown.push(t);
  }
  return out;
}
