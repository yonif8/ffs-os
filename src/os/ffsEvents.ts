// ffsEvents.ts — phone-side decoder for the FFS inbound event bus (glasses → phone).
//
// This is the INBOUND twin of the FXP1 push (sid 0x90, phone → glasses): our own,
// Even-free event channel on service id 0x91. Frames ride the SAME transport as the
// screenshot (aa21 reassembly → native `onServiceRaw(serviceId, base64)`); this module
// subscribes to that event, filters serviceId === 0x91, and parses the frozen envelope.
//
// ⛔ FROZEN CONTRACT — mirror `g2flash/patches/ffs_event.h` (contract version 1) EXACTLY:
//   header [ver(1) | src(1) | type(1) | flags(1) | seq(2 LE) | len(2 LE)] = 8 bytes, then
//   payload[len]. Change the layout only by bumping FFS_EVT_VER and updating BOTH ends +
//   the byte-goldens (src/os/__tests__/ffsEvents.test.ts) in lockstep.
//
// NOTE (proof status): this decoder is READY but proves NOTHING on-glass until Stream B's
// CFW `g2_emit()` (g2_api ABI 4) + the gesture-seam tap actually emit sid-0x91 frames.
// Mapped ≠ proven; the byte-goldens pin the contract, not the live link.

import { fromBase64 } from "../sdk/base64";

// Native BLE + logger are pulled in LAZILY (inside startFfsEvents/onServicePayload) rather
// than at module top: a static `import FfsBle`/`glog` drags react-native into the module
// graph, which the `bun test` runner cannot parse — that would leave the pure decoder below
// (the whole point of this file) untestable. base64 is pure, so it stays a static import.
type NativeBle = {
  addListener: (
    event: "onServiceRaw",
    cb: (p: { serviceId: number; payload: string }) => void,
  ) => { remove(): void };
};
type Logger = { emit: (cat: string, event: string, data?: Record<string, unknown>) => void };

function nativeBle(): NativeBle {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../modules/ffs-ble").default as NativeBle;
}
function logger(): Logger {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./log").glog as Logger;
}

// ── Wire constants (mirror ffs_event.h) ────────────────────────────────────

/** The service id this bus rides, glasses → phone. Mirrors 0x90 (FXP1, phone → glasses). */
export const FFS_EVT_SID = 0x91;
/** Envelope version. Bump on ANY layout change; both ends check it and the goldens pin it. */
export const FFS_EVT_VER = 0x01;
/** Fixed header length: ver+src+type+flags+seq(2)+len(2). */
export const FFS_EVT_HDR_LEN = 8;

/** flags bit0: set when the event originated on the right (master) lens. */
export const FFS_EVT_F_LENS_R = 0x01;

// ── src namespaces ──
/** system / shell events; app_id 0 is never a real app. */
export const FFS_EVT_SRC_SYS = 0x00;

// ── SYSTEM event types (src === FFS_EVT_SRC_SYS) ──
export const FFS_EVT_SYS_GESTURE = 0x01;
export const FFS_EVT_SYS_SENSOR = 0x02;
export const FFS_EVT_SYS_WEAR = 0x03;
export const FFS_EVT_SYS_VOICE = 0x04;
export const FFS_EVT_SYS_BATTERY = 0x05;

/** GESTURE payload: { code(1) | x(2 LE int16) | y(2 LE int16) }. */
export const FFS_EVT_GESTURE_LEN = 5;

// ── APP event types (src === the emitting app's app_id) ──
/** SELECT — { uint16 index }: the user chose item `index` in the app's on-glass list. */
export const FFS_EVT_APP_SELECT = 0x01;

// ── G2_G_* gesture vocabulary (one vocabulary across the whole system) ──
// The UPROLL/DOWNROLL header names in Even's tree are backwards — trust the NUMBER:
// 0x44 = physical down-roll, 0x45 = physical up-roll.
export const G2_G_TAP = 0x0a;
export const G2_G_DOUBLE = 0x48;
export const G2_G_ROLL_DOWN = 0x44;
export const G2_G_ROLL_UP = 0x45;
export const G2_G_LONG = 0x60;

// ── Typed model ────────────────────────────────────────────────────────────

export type FfsEvent = {
  ver: number;
  src: number;
  type: number;
  flags: number;
  seq: number;
  payload: Uint8Array;
};

/** Decoded system-gesture payload (src===0, type===GESTURE). x/y are signed int16. */
export type FfsGesture = {
  code: number;
  x: number;
  y: number;
};

// ── Decode ─────────────────────────────────────────────────────────────────

/** Sign-extend a 16-bit little-endian pair. */
function int16le(bytes: Uint8Array, off: number): number {
  const u = bytes[off] | (bytes[off + 1] << 8);
  return (u << 16) >> 16;
}

/**
 * Parse one sid-0x91 envelope. Returns null on a short frame, a version mismatch,
 * or a `len` that runs past the buffer. Little-endian seq/len; payload is sliced
 * to exactly `len` bytes (a copy, so callers can retain it safely).
 */
export function decodeFfsEvent(bytes: Uint8Array): FfsEvent | null {
  if (!bytes || bytes.length < FFS_EVT_HDR_LEN) return null;
  const ver = bytes[0];
  if (ver !== FFS_EVT_VER) return null;
  const src = bytes[1];
  const type = bytes[2];
  const flags = bytes[3];
  const seq = bytes[4] | (bytes[5] << 8);
  const len = bytes[6] | (bytes[7] << 8);
  if (FFS_EVT_HDR_LEN + len > bytes.length) return null; // truncated payload
  const payload = bytes.slice(FFS_EVT_HDR_LEN, FFS_EVT_HDR_LEN + len);
  return { ver, src, type, flags, seq, payload };
}

/**
 * Decode a system GESTURE event's payload into { code, x, y }. Returns null unless
 * the event is a system gesture (src===0, type===GESTURE) with a full 5-byte payload.
 */
export function decodeGesture(evt: FfsEvent): FfsGesture | null {
  if (evt.src !== FFS_EVT_SRC_SYS || evt.type !== FFS_EVT_SYS_GESTURE) return null;
  if (evt.payload.length < FFS_EVT_GESTURE_LEN) return null;
  return {
    code: evt.payload[0],
    x: int16le(evt.payload, 1),
    y: int16le(evt.payload, 3),
  };
}

// ── Human-readable labels (for the activity log) ────────────────────────────

const GESTURE_NAME: Record<number, string> = {
  [G2_G_TAP]: "TAP",
  [G2_G_DOUBLE]: "DOUBLE",
  [G2_G_ROLL_DOWN]: "ROLL_DOWN",
  [G2_G_ROLL_UP]: "ROLL_UP",
  [G2_G_LONG]: "LONG",
};

const SYS_TYPE_NAME: Record<number, string> = {
  [FFS_EVT_SYS_GESTURE]: "GESTURE",
  [FFS_EVT_SYS_SENSOR]: "SENSOR",
  [FFS_EVT_SYS_WEAR]: "WEAR",
  [FFS_EVT_SYS_VOICE]: "VOICE",
  [FFS_EVT_SYS_BATTERY]: "BATTERY",
};

/** A short readable one-liner for an event, for the activity log. */
export function describeFfsEvent(evt: FfsEvent): string {
  if (evt.src === FFS_EVT_SRC_SYS) {
    const typeName = SYS_TYPE_NAME[evt.type] ?? `0x${evt.type.toString(16)}`;
    if (evt.type === FFS_EVT_SYS_GESTURE) {
      const g = decodeGesture(evt);
      if (g) {
        const name = GESTURE_NAME[g.code] ?? "?";
        return `src=0 type=GESTURE code=0x${g.code.toString(16)}(${name}) x=${g.x} y=${g.y} seq=${evt.seq}`;
      }
    }
    return `src=0 type=${typeName} len=${evt.payload.length} seq=${evt.seq}`;
  }
  return `src=${evt.src} type=0x${evt.type.toString(16)} len=${evt.payload.length} seq=${evt.seq}`;
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const listeners = new Set<(evt: FfsEvent) => void>();

/**
 * Subscribe to decoded FFS events (for future app handlers). Returns an unsubscribe.
 * Handlers are wrapped so a throwing one can never break the bus.
 */
export function subscribeFfsEvents(cb: (evt: FfsEvent) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function dispatch(evt: FfsEvent): void {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch {
      /* a bad handler must never break the event bus */
    }
  }
}

let unsub: (() => void) | null = null;

function onServicePayload(p: { serviceId: number; payload: string }): void {
  if (p.serviceId !== FFS_EVT_SID) return;
  const raw = fromBase64(p.payload);
  const evt = decodeFfsEvent(raw);
  if (!evt) {
    logger().emit("ffs-evt", "malformed", { paylen: raw ? raw.length : 0 });
    return;
  }
  logger().emit("ffs-evt", "rx", { line: describeFfsEvent(evt) });
  dispatch(evt);
}

/**
 * Start listening for FFS events via onServiceRaw(sid=0x91). Idempotent. Decodes each
 * frame, logs a readable line to the activity log, and fans it out to subscribeFfsEvents
 * handlers. Returns the unsubscribe function (matches fbshot.ts's shape).
 */
export function startFfsEvents(): () => void {
  logger().emit("ffs-evt", "armed", { sid: FFS_EVT_SID });
  unsub?.();
  const sub = nativeBle().addListener("onServiceRaw", onServicePayload);
  unsub = () => sub.remove();
  return () => {
    unsub?.();
    unsub = null;
  };
}
