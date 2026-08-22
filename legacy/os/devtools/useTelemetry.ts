// useTelemetry — a live on-glass diagnostic feed for debugging the OS without a camera.
//
// Drives the Carrier-A loop (docs/ONGLASS-TELEMETRY.md): periodically push the tag-0x7D
// diagnostic payload (g2flash/payloads/ffs_telemetry.c) and request device info; decode the
// loader record out of field 104; keep a bounded history so pool_free can be watched TREND
// (the OOM/fragmentation early-warning). Once the LD05 loader is flashed, the same feed picks up
// the always-on Carrier-B block with no push — telemetryFromDeviceFrame handles both.
//
// DUAL-LENS: every reading self-reports its lens (the payload's G2FW_LENS_SIDE stamp), so
// right- and left-sourced readings separate themselves regardless of the BLE layer's deduped
// "whichever answered". `probeLens` attempts a per-lens device-info query (the phone-side lever
// that exists); whether the LEFT lens actually answers is the on-glass unknown — see
// ONGLASS-TELEMETRY.md §6.

import { useCallback, useEffect, useRef, useState } from "react";

import FfsBle from "../../../modules/ffs-ble";
import { fromBase64 } from "../../sdk/base64";
import {
  decodeTelemetryFromVersionString,
  telemetryFromDeviceFrame,
  type Telemetry,
} from "../../sdk/telemetry";
import {
  appendReading,
  DEFAULT_INTERVAL_MS,
  splitReadingsByLens,
  TELEMETRY_PAYLOAD_B64,
  type TelemetryReading,
} from "./telemetryFeed";

export { TELEMETRY_PAYLOAD_B64, type TelemetryReading } from "./telemetryFeed";

const SID_G2_SETTING = 0x09;

export interface TelemetryFeed {
  latest: TelemetryReading | null;
  history: TelemetryReading[];
  byLens: { right: TelemetryReading[]; left: TelemetryReading[]; unknown: TelemetryReading[] };
  polls: number;
  /** Manually fire one push + request cycle. */
  refresh: () => void;
  /** Attempt to read a specific lens (per-lens device-info query, if the native build supports it). */
  probeLens: (side: "L" | "R") => void;
  clear: () => void;
}

export function useTelemetry(opts: {
  enabled: boolean;
  pairReady: boolean;
  intervalMs?: number;
}): TelemetryFeed {
  const { enabled, pairReady, intervalMs = DEFAULT_INTERVAL_MS } = opts;
  const [history, setHistory] = useState<TelemetryReading[]>([]);
  const [polls, setPolls] = useState(0);

  const ingest = useCallback((t: Telemetry | null) => {
    if (!t) return;
    if (t.source === "A" && !t.valid) return; // a non-0x7D ret is some other payload's mask
    setHistory((h) => appendReading(h, { t, at: Date.now() }));
  }, []);

  // Inbound: prefer the raw service-0x09 frame (numeric, and picks up Carrier B once flashed);
  // fall back to the ⟨LOADER ret=⟩ version string (works today with no native change).
  useEffect(() => {
    if (!enabled) return;
    const subs = [
      FfsBle.addListener("onServiceRaw", ({ serviceId, payload }) => {
        if (serviceId !== SID_G2_SETTING) return;
        try {
          ingest(telemetryFromDeviceFrame(fromBase64(payload)));
        } catch {
          /* a malformed frame is not a telemetry event */
        }
      }),
      FfsBle.addListener("onDeviceInfo", (e: { leftVersion?: string | null; rightVersion?: string | null }) => {
        ingest(
          decodeTelemetryFromVersionString(e.leftVersion) ??
            decodeTelemetryFromVersionString(e.rightVersion),
        );
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [enabled, ingest]);

  const refresh = useCallback(() => {
    if (!pairReady) return;
    setPolls((n) => n + 1);
    // Push the diagnostic payload so this read's last_ret carries fresh Carrier-A telemetry, then
    // ask for device info. If LD05 is flashed the request alone suffices (Carrier B is always-on).
    try {
      FfsBle.pushPayloadViaImage(TELEMETRY_PAYLOAD_B64);
    } catch {
      /* not connected */
    }
    setTimeout(() => {
      try {
        FfsBle.requestDeviceInfo();
      } catch {
        /* not connected */
      }
    }, 500);
  }, [pairReady]);

  const probeLens = useCallback((side: "L" | "R") => {
    if (!pairReady) return;
    setPolls((n) => n + 1);
    // Per-lens device-info query — the phone-side lever for defeating the deduped "whichever
    // answered". Falls back to the both-lenses request if the native build predates it.
    const anyBle = FfsBle as unknown as { requestDeviceInfoSide?: (s: string) => void };
    if (typeof anyBle.requestDeviceInfoSide === "function") anyBle.requestDeviceInfoSide(side);
    else FfsBle.requestDeviceInfo();
  }, [pairReady]);

  const clear = useCallback(() => {
    setHistory([]);
    setPolls(0);
  }, []);

  // Periodic polling while enabled + linked.
  useEffect(() => {
    if (!enabled || !pairReady) return;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [enabled, pairReady, intervalMs, refresh]);

  return {
    latest: history.length ? history[history.length - 1] : null,
    history,
    byLens: splitReadingsByLens(history),
    polls,
    refresh,
    probeLens,
    clear,
  };
}
