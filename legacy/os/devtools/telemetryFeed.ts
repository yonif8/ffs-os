// Pure, native-free core of the telemetry feed — the reducer + per-lens split + the payload
// constant. Kept separate from useTelemetry.ts so this logic is unit-testable without pulling in
// react-native / the FfsBle native module.

import type { Telemetry } from "../../sdk/telemetry";

export const HISTORY_CAP = 60;
export const DEFAULT_INTERVAL_MS = 4000;

/**
 * Framed FXP1 base64 of g2flash/payloads/ffs_telemetry.c (Carrier A, tag 0x7D), default (with the
 * lens stamp). crc=0x82CB6966, body 186 B. Rebuild with:
 *   python3 patches/build.py payloads/ffs_telemetry.c && \
 *   python3 tools/frame_payload.py obj/ffs_telemetry.text.bin
 */
export const TELEMETRY_PAYLOAD_B64 =
  "RlhQMboAAABmacuC8LWBsEX2cyZAJU/0gDTA8kcGAL8gRrBHKLkBPaT1gGT40QAlAuAG8UQBiEdE9jhQwvIHAAFoT/R8RrHxAF9P8AAEKNOIDYAoT/AAByTYCGgAKAi/SGiw8QBfHdOBDYApGtgBaQCIsfEAXxHTig2AKg7YCmhE8kZjxPJTE5pCB9HR+EART/TgIgLqAURP9AAngAKGsgDgACdK9nkAwPJFAIBHReoEATlDAPADADFDQeqAUEDw+kABsPC9";

export interface TelemetryReading {
  t: Telemetry;
  at: number;
}

/**
 * Append a reading, dropping an exact-duplicate consecutive Carrier-A value (the same last_ret
 * echoed by a second device-info read inside the poll window) and bounding length.
 */
export function appendReading(
  history: TelemetryReading[],
  reading: TelemetryReading,
  cap = HISTORY_CAP,
): TelemetryReading[] {
  const last = history[history.length - 1];
  if (
    last &&
    last.t.source === "A" &&
    reading.t.source === "A" &&
    last.t.lastRet === reading.t.lastRet &&
    reading.at - last.at < 1500
  ) {
    return history;
  }
  const next = history.concat(reading);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Split a reading history by the self-reported lens stamp (1=right, 2=left, else unknown). */
export function splitReadingsByLens(history: TelemetryReading[]) {
  const out = { right: [] as TelemetryReading[], left: [] as TelemetryReading[], unknown: [] as TelemetryReading[] };
  for (const r of history) {
    if (r.t.lens === 1) out.right.push(r);
    else if (r.t.lens === 2) out.left.push(r);
    else out.unknown.push(r);
  }
  return out;
}
