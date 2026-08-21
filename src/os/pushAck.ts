/** Pure loader acknowledgement logic for native FXP1 pushes. */

export type LoaderRecord = {
  gen: number;
  ran: number;
  len: number;
  rxlen: number;
  rej: number;
  ret: number | null;
};

export type PushAckVerdict =
  | { state: "accepted"; record: LoaderRecord }
  | { state: "pending"; reason: string; record: LoaderRecord | null }
  | { state: "failed"; reason: string; record: LoaderRecord };

export function loaderRecordFromVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): LoaderRecord | null {
  for (const text of [left ?? "", right ?? ""]) {
    const block = text.match(/⟨LOADER\s+([^⟩]+)⟩/);
    if (!block) continue;
    const field = (name: string): string | null => {
      const m = block[1].match(new RegExp(`(?:^|\\s)${name}=(0x[0-9A-Fa-f]+|\\d+)`));
      return m ? m[1] : null;
    };
    const gen = field("gen"), ran = field("ran"), len = field("len");
    const rxlen = field("rxlen"), rej = field("rej"), ret = field("ret");
    if (gen === null || ran === null || len === null || rxlen === null || rej === null) continue;
    return {
      gen: Number(gen), ran: Number(ran), len: Number(len), rxlen: Number(rxlen),
      rej: Number(rej), ret: ret === null ? null : Number(ret),
    };
  }
  return null;
}

/**
 * Does a device-info readback prove OUR CFW is resident on the glasses? Pushing a native FXP1
 * frame at STOCK firmware is destructive (the stock BMP decoder parses our Thumb-2 as a bitmap →
 * blank lens → watchdog reboot), so this predicate gates every native push AND the data-plane
 * media/notification frames. It must be FALSE on stock and TRUE on our CFW.
 *
 * Two independent, firmware-authored signals, EITHER of which is conclusive:
 *
 *   • "EVENCFW" — the magic of the CFW capability advertisement. `settings_ext.c` answers the
 *     sid-0x09 device-info read with protobuf field 100 = "EVENCFW/<ver> <tokens…>", which
 *     `G2Protocol.parseDeviceInfo` folds into the version string as ⟨CAPS=EVENCFW/1 img576 imgz
 *     xordelta stereo fontprobe rxok peer=… ⟩. This is emitted on EVERY read, BEFORE any payload
 *     is pushed — so it is the marker that recognises a FRESHLY FLASHED image. (The ⟨LOADER⟩
 *     block below is only a push RECEIPT, so on a fresh flash with no push yet it is absent, and
 *     the ⟨CAPS⟩ advertisement is the ONLY proof the loader is present. Gating media on ⟨LOADER⟩
 *     alone was an unsatisfiable chicken-and-egg: no push without the loader, no ⟨LOADER⟩ receipt
 *     without a push.)
 *
 *   • "LOADER" — the ⟨LOADER gen=… ran=… ⟩ receipt the loader appends after it has TAKEN a push.
 *     Kept for backward compatibility and for a CFW build whose `settings_ext.c` is absent (no
 *     ⟨CAPS⟩): once such an image has acked one frame it still reads as present.
 *
 * SAFETY on stock: stock firmware sends neither protobuf field 100 (so no ⟨CAPS⟩ / "EVENCFW") nor
 * any ⟨LOADER⟩ block. A bare stock version string ("2.2.7.14") therefore contains neither token
 * and reads as NOT present — the destructive push stays blocked. Both markers are magic strings
 * our own firmware writes; nothing on a stock version line matches either.
 */
const CFW_PRESENT_MARKERS = ["EVENCFW", "LOADER"] as const;

export function loaderMarkerPresent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const text = `${left ?? ""} ${right ?? ""}`;
  return CFW_PRESENT_MARKERS.some((marker) => text.includes(marker));
}

/** Decoded byte length without relying on atob/Buffer (both vary across RN runtimes). */
export function base64ByteLength(value: string): number {
  const b64 = value.trim();
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error("payload is not canonical base64");
  }
  const firstPad = b64.indexOf("=");
  if (firstPad >= 0 && firstPad < b64.length - (b64.endsWith("==") ? 2 : 1)) {
    throw new Error("payload has interior base64 padding");
  }
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/**
 * Corrupt only byte 8 (the first CRC-32 byte) of a canonical FXP1 frame.
 * Base64 character 11 carries the low six bits of byte 8; changing it leaves magic,
 * body length, body bytes, and total frame length untouched. This produces a safe
 * loader-level CRC rejection for proving the phone's negative acknowledgement path.
 */
export function corruptFxp1CrcBase64(value: string): string {
  const b64 = value.trim();
  if (base64ByteLength(b64) < 13 || b64.length <= 11) {
    throw new Error("FXP1 frame is too short for a CRC rejection probe");
  }
  const replacement = b64[11] === "A" ? "B" : "A";
  return b64.slice(0, 11) + replacement + b64.slice(12);
}

function newer(next: number, before: number): boolean {
  const delta = (next - before) >>> 0;
  return delta !== 0 && delta < 0x80000000;
}

export function verifyPushAck(
  baseline: Pick<LoaderRecord, "gen" | "ran"> | null,
  record: LoaderRecord | null,
  frameLen: number,
): PushAckVerdict {
  if (!record) return { state: "pending", reason: "no loader record yet", record: null };
  if (!baseline) {
    return { state: "pending", reason: "no pre-push loader generation snapshot", record };
  }
  // Reject/length fields are sticky. Never convict the new push from an older frame's
  // telemetry: receipt generation must advance before any field is attributable at all.
  if (!newer(record.gen, baseline.gen)) {
    return { state: "pending", reason: "loader receipt has not advanced past the pre-push snapshot", record };
  }
  if (record.rej !== 0) {
    return { state: "failed", reason: `loader rejected frame (rej=${record.rej})`, record };
  }
  if (record.rxlen !== frameLen) {
    return { state: "failed", reason: `foreign frame rxlen=${record.rxlen}, expected ${frameLen}`, record };
  }
  if (record.len !== frameLen - 12) {
    return { state: "failed", reason: `stale body len=${record.len}, expected ${frameLen - 12}`, record };
  }
  if (!newer(record.ran, baseline.ran)) {
    return { state: "pending", reason: "received frame has not executed yet", record };
  }
  return { state: "accepted", record };
}
