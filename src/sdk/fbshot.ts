/**
 * fbshot.ts — JS-side assembler for on-glass screenshots sent over BLE.
 *
 * The firmware's `payloads/fb_shot.c` (FB_XPORT=1, FB_MODE=2) reads the panel A4
 * framebuffer (0x20080000, 576×288, 4bpp, 82944 bytes) and ships it as aa21-framed
 * chunks on serviceId 0x30 (SCREENSHOT) via SETTINGS_SEND. The phone's G2Protocol
 * reassembler extracts (serviceId, payload) from every aa21 frame and fires
 * `onServiceRaw(serviceId, payload)` — this module subscribes to that event, filters
 * on serviceId === 0x30, strips the 10-byte FBSH header, and assembles the raw A4
 * buffer. When complete, it writes `fbshot.a4` to the app's files dir.
 *
 * A4 layout: 1 byte = 2 pixels, even-x = high nibble (FB_HIGH_FIRST=1 default).
 * The Python reconstructor `g2flash/tools/fb_shot.py --raw-a4 <file>` turns that
 * into a green PNG.
 *
 * This is the clean path: no raw-byte matching, no characteristic changes, no audio
 * guard risk. The aa21 framing and onServiceRaw routing are proven end-to-end by
 * the settings readback path (sid 0x09 → Device screen renders live).
 */

import FfsBle from "../../modules/ffs-ble";
import { toBase64, fromBase64 } from "./base64";

// ── Constants (mirror fb_shot.c) ──────────────────────────────────────────

const FB_SIZE = 82944;           // 576×288 / 2
const FB_SCREENSHOT_SID = 0x30;  // dedicated screenshot service id
const FB_HDR_LEN = 10;           // FBSH(4) + seq(1) + total(1) + mode(1) + offset(3)
const FB_RAW_PAY = 216;          // A4 bytes per chunk (= FB_SEND_PAY_MAX)
const FB_NPKTS = 384;            // ceil(82944 / 216)

// ── Assembly state ────────────────────────────────────────────────────────

let buf = new Uint8Array(FB_SIZE);
let mask = new Uint8Array(FB_SIZE); // 1 = byte received
let received = 0;
let totalExpected = FB_NPKTS;
let lastSeq = -1;
let lastActivity = 0;
let autoWritten = false;
let unsub: (() => void) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const FB_IDLE_FLUSH_MS = 900;    // write partial if packets stop this long

export interface FbShotState {
  received: number;
  totalExpected: number;
  lastSeq: number;
  elapsedMs: number;
  done: boolean;
}

/**
 * Start listening for fb_shot chunks via onServiceRaw(sid=0x30). Idempotent.
 * Auto-writes `fbshot.a4` to the app's files dir when assembly is complete.
 * Returns the unsubscribe function.
 */
export function startListening(): () => void {
  console.log("[fbshot] armed (onServiceRaw sid 0x30)");
  unsub?.();
  reset();
  const sub = FfsBle.addListener("onServiceRaw", onServicePayload);
  unsub = () => sub.remove();
  return () => { unsub?.(); unsub = null; };
}

/** Current assembly progress snapshot. */
export function state(): FbShotState {
  return {
    received,
    totalExpected,
    lastSeq,
    elapsedMs: Date.now() - lastActivity,
    done: received >= FB_SIZE,
  };
}

/** Reset the assembler for a new capture. */
export function reset(): void {
  buf = new Uint8Array(FB_SIZE);
  mask = new Uint8Array(FB_SIZE);
  received = 0;
  totalExpected = FB_NPKTS;
  lastSeq = -1;
  lastActivity = Date.now();
  autoWritten = false;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/**
 * Concatenate assembled A4 bytes into a single Uint8Array. Returns null if
 * no bytes have been received. Missing bytes are zero-filled.
 */
export function assemble(): Uint8Array | null {
  if (received === 0) return null;
  const out = new Uint8Array(FB_SIZE);
  for (let i = 0; i < FB_SIZE; i++) {
    if (mask[i]) out[i] = buf[i];
  }
  return out;
}

// ── Internal ──────────────────────────────────────────────────────────────

function onServicePayload(p: { serviceId: number; payload: string }): void {
  // Filter: only screenshot chunks (sid 0x30).
  if (p.serviceId !== FB_SCREENSHOT_SID) return;

  lastActivity = Date.now();
  const raw = fromBase64(p.payload);
  if (!raw || raw.length < FB_HDR_LEN) return;
  // Payload is the raw aa21 message body: FBSH + seq + total + mode + offset + A4 bytes.
  if (raw[0] !== 0x46 || raw[1] !== 0x42 || raw[2] !== 0x53 || raw[3] !== 0x48) return;

  const seq = raw[4];
  const total = raw[5];
  const mode = raw[6];

  // Update expected count from the first chunk we see.
  if (total > 0 && totalExpected === FB_NPKTS) {
    totalExpected = total;
  }

  // Skip if not raw-mode (mode 2).
  if (mode !== 2) return;

  // Copy A4 payload bytes into the buffer. The 24-bit offset is at bytes 7-9.
  const offBase = raw[7] | (raw[8] << 8) | (raw[9] << 16);

  // New capture starts at offset 0 — if we already wrote a prior frame, reset
  // so repeated screenshots work without relaunching the app.
  if (offBase === 0 && autoWritten) reset();
  if (offBase === 0) console.log("[fbshot] capture start, paylen", raw.length - FB_HDR_LEN);
  lastSeq = seq;
  for (let k = FB_HDR_LEN; k < raw.length; k++) {
    const off = offBase + (k - FB_HDR_LEN);
    if (off < FB_SIZE) {
      if (!mask[off]) {
        mask[off] = 1;
        received++;
      }
      buf[off] = raw[k];
    }
  }

  // Complete on full framebuffer (all bytes filled). `received` counts unique
  // BYTES, so the terminal condition is FB_SIZE — NOT the packet count (which is
  // 384, truncates to 128 in the u8 `total` field, and is a different unit).
  if (!autoWritten && received >= FB_SIZE) {
    flush();
    return;
  }
  // Idle flush: if packets stop arriving mid-stream (a dropped chunk means we
  // never hit FB_SIZE), write whatever we have after a quiet gap so a near-
  // complete capture still lands. Missing bytes are zero-filled by assemble().
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!autoWritten && received > 0) flush();
  }, FB_IDLE_FLUSH_MS);
}

function flush(): void {
  if (autoWritten) return;
  autoWritten = true;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const a4 = assemble();
  console.log("[fbshot] FLUSH received", received, "of", FB_SIZE, "assembled", a4 ? a4.length : -1);
  if (a4) FfsBle.writeFbShot(toBase64(a4));
}