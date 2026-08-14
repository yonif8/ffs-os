// The aa21 BLE transport envelope — pure TypeScript, byte-identical to the proven native driver
// (modules/ffs-ble/android/.../G2Protocol.kt `G2Transport.buildPackets`).
//
// Until now this framing lived ONLY in Kotlin/Swift: the pure-TS SDK produced the inner protobuf
// (wire.ts, settings.ts) and handed it to `FfsBle.sendEvenHub` / `pushToService`, which wrapped it
// in the transport envelope out of reach of any bun test. This module lifts that last unproven-by-
// unit-test step into pure TS so the WHOLE wire — envelope included — can be byte-pinned offline.
//
// Frame layout (phone -> glasses):
//   [0]=0xAA [1]=0x21 [2]=syncId [3]=payloadLen(+2 on last) [4]=totalPackets [5]=serial(1-based)
//   [6]=sid [7]=flag  <chunk...>  [CRC16-LE on last packet only]
//   (glasses -> phone uses 0xAA 0x12; same layout.)
//
// The CRC-16/CCITT-FALSE covers the CONCATENATED inner pb of every fragment and is appended little-
// endian to the last fragment only. All fragments of one message share ONE syncId — the firmware
// keys reassembly on it; a per-fragment increment makes it drop the message and emit an 8-byte
// abort on sid 0xe0 flag 0x02.

import { crc16CcittFalse } from "./crc";

export const SYNC_TX = [0xaa, 0x21] as const; // phone -> glasses
export const SYNC_RX = [0xaa, 0x12] as const; // glasses -> phone

/**
 * The proven native chunk size (`G2Wire.MAX_PACKET_PAYLOAD`). The reference kit and older notes use
 * 232 (Mirai's value); the on-glass driver ships 236, so that is the default here. Both reassemble.
 */
export const MAX_PACKET_PAYLOAD = 236;

/** Transport status byte (frame[7]). */
export const Flag = {
  /** phone REQUEST — EvenHub renders/settings writes ride this (native `reserveFlag=true`). */
  REQUEST: 0x20,
  /** OS RESPONSE / ack. */
  RESPONSE: 0x00,
  /** device NOTIFY (events). */
  NOTIFY: 0x01,
  NOTIFY_ALT: 0x06,
} as const;

/**
 * Service ids (appId) — the authoritative `service_id_def.SID` enum the firmware routes on
 * (FINDINGS-ble-command-surface §3). `forbidden: true` marks the one sid an SDK must NEVER emit.
 */
export const SID = {
  /** app-launch handshake + widget touch. */
  UI_DEFAULT_APP: 0x01,
  /** foreground notification page. */
  UI_FOREGROUND_NOTIFICATION: 0x04,
  /** display control + status/telemetry — the primary SAFE control channel. */
  UI_SETTING: 0x09,
  /** fw -> app state bus (read-only). */
  STATE_CHANGE: 0x0d,
  /** widget transform. */
  WIDGET_XFORM: 0x0e,
  /** module config (caution). */
  SERVICE_MODULE_CONFIGURE: 0x20,
  /** system alert / close pages. */
  SYSTEM_ALERT: 0x21,
  SYSTEM_CLOSE: 0x22,
  /**
   * ⛔ UX_DEVICE_SETTINGS (dev_config) — developer/debug knobs. Writing it BRICKED a pair during
   * early RE (recoverable via power-cycle + re-pair). `frameMessage` THROWS on this sid.
   */
  UX_DEVICE_SETTINGS_FORBIDDEN: 0x80,
  /** container / image / text render — the primary SAFE render channel (and the FXP1 CFW door). */
  UI_BACKGROUND_EVENHUB: 0xe0,
} as const;

/** The one sid an SDK must never put on the wire. */
export const FORBIDDEN_SID = 0x80;

export interface FrameOptions {
  /** reassembly group key; ONE value shared by every fragment of this message. */
  syncId: number;
  sid: number;
  flag: number;
  /** transport chunk size; defaults to the proven 236. */
  maxPayload?: number;
}

/**
 * Split one inner-pb payload into aa21 transport frames, CRC-16 on the last fragment.
 *
 * Faithful to `G2Transport.buildPackets`, INCLUDING the edge case: when the final data chunk is
 * exactly `maxPayload` bytes, an empty trailing packet is appended to carry the CRC, so a full
 * final chunk is never mistaken for a non-terminal one.
 *
 * ⛔ Throws if `sid === 0x80` (dev_config) — that channel is never a legitimate SDK target.
 */
export function frameMessage(pb: Uint8Array, opts: FrameOptions): Uint8Array[] {
  if (opts.sid === FORBIDDEN_SID) {
    throw new Error(
      "refusing to frame sid 0x80 (UX_DEVICE_SETTINGS / dev_config) — writing it has bricked a " +
        "pair; use sid 0x09 (UI_SETTING) for brightness/wear/silent/head-up/lens instead."
    );
  }
  if (opts.sid < 0 || opts.sid > 0xff) throw new RangeError(`sid out of byte range: ${opts.sid}`);
  const maxPayload = opts.maxPayload ?? MAX_PACKET_PAYLOAD;

  // Chunk the payload.
  const chunks: Uint8Array[] = [];
  let off = 0;
  while (off < pb.length) {
    const end = Math.min(off + maxPayload, pb.length);
    chunks.push(pb.subarray(off, end));
    off = end;
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  if (chunks[chunks.length - 1]!.length === maxPayload) chunks.push(new Uint8Array(0));

  const totalPackets = chunks.length;
  const crc = crc16CcittFalse(pb);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < totalPackets; i++) {
    const chunk = chunks[i]!;
    const isLast = i === totalPackets - 1;
    const payloadLen = chunk.length + (isLast ? 2 : 0);
    const frame = new Uint8Array(8 + payloadLen);
    frame[0] = SYNC_TX[0];
    frame[1] = SYNC_TX[1];
    frame[2] = opts.syncId & 0xff;
    frame[3] = payloadLen & 0xff;
    frame[4] = totalPackets & 0xff;
    frame[5] = (i + 1) & 0xff; // serial, 1-based
    frame[6] = opts.sid & 0xff;
    frame[7] = opts.flag & 0xff;
    frame.set(chunk, 8);
    if (isLast) {
      frame[8 + chunk.length] = crc & 0xff;
      frame[8 + chunk.length + 1] = (crc >> 8) & 0xff;
    }
    frames.push(frame);
  }
  return frames;
}

export interface ParsedFrame {
  ok: boolean;
  isTx: boolean;
  syncId: number;
  payloadLen: number;
  totalPackets: number;
  serial: number;
  sid: number;
  flag: number;
  /** this fragment's chunk, CRC stripped when this is the last fragment. */
  chunk: Uint8Array;
}

/** Parse a single aa21/aa12 transport frame. Returns `ok:false` on a malformed header. */
export function parseFrame(buf: Uint8Array): ParsedFrame {
  const bad: ParsedFrame = {
    ok: false, isTx: false, syncId: 0, payloadLen: 0, totalPackets: 0,
    serial: 0, sid: 0, flag: 0, chunk: new Uint8Array(0),
  };
  if (buf.length < 8 || buf[0] !== 0xaa || (buf[1] !== 0x21 && buf[1] !== 0x12)) return bad;
  const isTx = buf[1] === 0x21;
  const payloadLen = buf[3]!;
  const totalPackets = buf[4]!;
  const serial = buf[5]!;
  const isLast = serial === totalPackets;
  const dataLen = payloadLen - (isLast ? 2 : 0);
  const start = 8;
  const chunk = buf.subarray(start, Math.min(buf.length, start + Math.max(0, dataLen)));
  return {
    ok: true, isTx, syncId: buf[2]!, payloadLen, totalPackets, serial,
    sid: buf[6]!, flag: buf[7]!, chunk,
  };
}

/**
 * Reassemble the inner pb from a full, ordered set of a message's frames and verify the trailing
 * CRC-16. Returns null if the CRC does not match — the round-trip guarantee `frameMessage` upholds.
 */
export function reassemble(frames: readonly Uint8Array[]): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let total = 0;
  let last: Uint8Array | null = null;
  for (const f of frames) {
    const p = parseFrame(f);
    if (!p.ok) return null;
    parts.push(p.chunk);
    total += p.chunk.length;
    last = f;
  }
  if (!last) return null;
  const pb = new Uint8Array(total);
  let o = 0;
  for (const c of parts) { pb.set(c, o); o += c.length; }
  // Trailing CRC lives in the last frame after its data chunk.
  const lp = parseFrame(last);
  const crcOff = 8 + lp.chunk.length;
  if (last.length < crcOff + 2) return null;
  const got = last[crcOff]! | (last[crcOff + 1]! << 8);
  return crc16CcittFalse(pb) === got ? pb : null;
}

/**
 * Per-connection counters — the pure-TS twin of native `G2SendCounters`. `syncId` keys transport
 * reassembly; `magic` (MagicRandom) matches EvenHub acks to requests. Both wrap at 256, matching
 * the driver's `and 0xFF`.
 */
export class Counters {
  private _sync: number;
  private _magic: number;
  constructor(syncId = 0, magic = 0) {
    this._sync = syncId & 0xff;
    this._magic = magic & 0xff;
  }
  nextSyncId(): number {
    const v = this._sync;
    this._sync = (this._sync + 1) & 0xff;
    return v;
  }
  nextMagic(): number {
    const v = this._magic;
    this._magic = (this._magic + 1) & 0xff;
    return v;
  }
}
