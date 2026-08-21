// FFSC — the phone→app DATA CHANNEL. "Here is a value for app N", and nothing else.
//
// WHAT THIS IS. GOAL.md §2 splits the system as *phone = the brain* (data, network, app
// logic) and *glasses = the face* (render, animate, scroll, handle input). The face was
// built first and works; this is the wire into it. The CFW loader already routes an FXP1
// body by its first four bytes — "FFSA" is an app image — and "FFSC" is a value addressed
// to one app_id, which the glasses copy into a small resident mailbox and hand to that app
// through `ctx->api->data(ctx, &d)`.
//
// ★ IT IS DELIBERATELY IGNORANT OF ITS CARGO. A channel frame carries an app_id, a
//   sequence number, a length and a CRC. What is inside is between the phone-side source
//   and the app: `messages` reads an FFSM store (ffsm.ts), a weather app would read its own
//   layout. That is the whole reason this exists instead of an FFSM-specific route — one
//   mechanism, no new wire opcode per app, and `ffs_prog.h` (the FROZEN FFSP contract) is
//   not involved at all.
//
// ★ THE LAYOUT LIVES IN THREE PLACES AND MUST NOT DRIFT:
//     g2flash/tools/ffsc_ref.py       the reference encoder + the golden vectors
//     g2flash/patches/ffs_data.h      the on-glass parser (ffs_data_consume)
//     this file                       the phone's encoder
//   `g2flash/tools/test_data_channel.c` proves the C parser reads the Python encoder's
//   bytes; `__tests__/ffsc.test.ts` pins THIS encoder to the very same bytes. Change the
//   layout in one commit or not at all.
//
// [M] Nothing here is proven on glass. It emits bytes and is unit-tested; the frames it
//     produces have been accepted by the shipping parser only on a PC.
//
// ⛔ PRIVACY: a blob may one day be message bodies. Nothing in this module logs, stringifies
//    or persists a blob, and nothing added to it should — ffs_os is PUBLIC and its telemetry
//    pipe is off-device. Metadata (appId, byte count, seq) only.

import { crc32 } from "./ble/crc";

export const FFSC_MAGIC = "FFSC";
export const FFSC_VER = 1;
export const FFSC_HDR_LEN = 16;

export const FFSC_OP_PUT = 0;
export const FFSC_OP_CLEAR = 1;

/** patches/ffs_data.h `G2D_MAX_BLOB`. A larger value is refused with G2D_ERR_SIZE. */
export const FFSC_MAX_BLOB = 1024;
/** patches/ffs_data.h `G2D_MAX_CH`. A third app's value EVICTS the least recently written. */
export const FFSC_MAX_CHANNELS = 2;

export interface FfscFrameOptions {
  appId: number;
  /** Wraps at 0x10000. Two consecutive pushes MUST differ or the glasses treat the second
   *  as a duplicate — correct behaviour that looks exactly like a failure if unintended. */
  seq: number;
  blob?: Uint8Array;
  op?: number;
}

/**
 * Build one FFSC frame — the FXP1 *body*. Wrap it with `fxp1Frame()` from `ble/fxp1` before
 * it goes on the wire.
 *
 * Every refusal the glasses would make is made HERE instead, as a thrown Error on a machine
 * with a stack trace, rather than as an `err=` nibble on a face. That asymmetry is the point:
 * a silent no-op on the HUD is this project's most expensive recurring bug.
 */
export function encodeFfsc(opts: FfscFrameOptions): Uint8Array {
  const { appId, seq } = opts;
  const op = opts.op ?? FFSC_OP_PUT;
  if (!Number.isInteger(appId) || appId < 1 || appId > 0xfffe) {
    throw new Error(`FFSC: app_id ${appId} outside 1..0xFFFE (the glasses answer G2D_ERR_HDR)`);
  }
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`FFSC: seq ${seq} must be a non-negative integer`);

  let blob = opts.blob ?? new Uint8Array(0);
  if (op === FFSC_OP_CLEAR) {
    blob = new Uint8Array(0);
  } else if (op === FFSC_OP_PUT) {
    if (blob.length === 0) throw new Error("FFSC: a PUT with an empty blob (the glasses answer G2D_ERR_SIZE)");
    if (blob.length > FFSC_MAX_BLOB) {
      throw new Error(
        `FFSC: blob ${blob.length} B exceeds G2D_MAX_BLOB (${FFSC_MAX_BLOB}) — the glasses answer G2D_ERR_SIZE`
      );
    }
  } else {
    throw new Error(`FFSC: unknown op ${op}`);
  }

  const out = new Uint8Array(FFSC_HDR_LEN + blob.length);
  out[0] = 0x46; // F
  out[1] = 0x46; // F
  out[2] = 0x53; // S
  out[3] = 0x43; // C
  out[4] = FFSC_VER;
  out[5] = op;
  const dv = new DataView(out.buffer);
  dv.setUint16(6, appId & 0xffff, true);
  dv.setUint16(8, seq & 0xffff, true);
  dv.setUint16(10, blob.length, true);
  dv.setUint32(12, crc32(blob), true);
  out.set(blob, FFSC_HDR_LEN);
  return out;
}

export interface FfscHeader {
  ver: number;
  op: number;
  appId: number;
  seq: number;
  blob: Uint8Array;
}

/**
 * Read a frame back. Exists for the round-trip tests — a second, independent reading of the
 * same layout is how a field-order slip gets caught instead of being encoded consistently
 * wrong on both sides.
 */
export function decodeFfsc(frame: Uint8Array): FfscHeader {
  if (frame.length < FFSC_HDR_LEN) throw new Error("FFSC: short frame");
  if (frame[0] !== 0x46 || frame[1] !== 0x46 || frame[2] !== 0x53 || frame[3] !== 0x43) {
    throw new Error("FFSC: bad magic");
  }
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const blobLen = dv.getUint16(10, true);
  if (FFSC_HDR_LEN + blobLen > frame.length) throw new Error("FFSC: blob_len runs past the frame");
  const blob = frame.slice(FFSC_HDR_LEN, FFSC_HDR_LEN + blobLen);
  if (crc32(blob) !== dv.getUint32(12, true)) throw new Error("FFSC: blob CRC mismatch");
  return { ver: frame[4], op: frame[5], appId: dv.getUint16(6, true), seq: dv.getUint16(8, true), blob };
}

// ─────────────────────────────────────────────────────────────────────── the ret= word

/** patches/ffs_data.h `G2D_ERR_*`, in the order the firmware defines them. */
export const FFSC_ERR = [
  "NONE",
  "SHORT",
  "VER",
  "HDR",
  "SIZE",
  "CRC",
  "SLOTS",
  "OOM",
  "NOCH",
  "NORT",
] as const;

export interface FfscRet {
  /** false when the word is not a data-channel word at all (tag != 0x64). */
  isChannel: boolean;
  err: number;
  errName: string;
  op: number;
  /** LOW BYTE of the seq — enough to tell two consecutive pushes apart, not to identify one. */
  seqLow: number;
  /** null when nothing was written. */
  slot: number | null;
  /** another app's channel was dropped to make room. */
  evicted: boolean;
  /** the value was byte-identical to the one already held: nothing copied, nothing repainted. */
  duplicate: boolean;
  channels: number;
}

/**
 * Decode the `ret=` word the glasses put on their `⟨LOADER … ret=0x…⟩` line. The phone can
 * therefore say "the value LANDED" rather than "the value was SENT", which are different
 * claims and have been confused here before.
 */
export function decodeFfscRet(word: number): FfscRet {
  const w = word >>> 0;
  const err = (w >>> 20) & 0xf;
  const slot = (w >>> 4) & 0xf;
  return {
    isChannel: (w >>> 24) === 0x64,
    err,
    errName: FFSC_ERR[err] ?? `?${err}`,
    op: (w >>> 16) & 0xf,
    seqLow: (w >>> 8) & 0xff,
    slot: slot === 0xf ? null : slot,
    evicted: (w & 0x08) !== 0,
    duplicate: (w & 0x04) !== 0,
    channels: w & 0x03,
  };
}
