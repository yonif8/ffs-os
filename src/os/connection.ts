// FFS Glasses OS — connection supervisor / all-day reliability layer
// (FUT-136, ported off @mentra onto our ffs-ble driver — FUT-163, Phase 1)
//
// WHAT THIS DOES — AND THE ONE HONEST DIFFERENCE FROM THE @mentra ORIGINAL
// The @mentra port of this module leaned on the SDK's NATIVE reconnect loop
// (G2ReconnectionManager: unlimited every-30s re-scan on unexpected drop) and so it
// deliberately did NOT re-implement reconnect in JS — it only OBSERVED native's loop.
//
// OUR ffs-ble driver has NO native reconnect loop yet (that hardening is tracked
// separately as FUT-162). So here this supervisor is a THIN OS-layer helper that adds:
//
//   1. Reconnect-on-wake NUDGE — when iOS foregrounds the app after a background/lock
//      spell and we're down, fire ONE guarded scan+connect so we recover. With no
//      native loop underneath, this nudge is (for now) the primary recovery path — a
//      full retry loop is FUT-162, intentionally NOT built here (parity, not redesign).
//   2. Reclaim-on-ready — the instant the pair is READY again, re-assert our HUD
//      surface (screenOwner) so the glasses show OUR screen, not a blank/idle one.
//   3. Health + soak observability — one derived ConnectionHealth readout for the UI
//      and a small timestamped transition log so a multi-hour soak produces evidence.
//
// GRAIN: the ffs-ble driver exposes per-side L/R flags + a pairReady flag. We map
// "connected" = at least one lens up, "ready" = both lenses up + characteristics bound
// (bt.pairReady). "degraded" = one lens up but pair not yet ready (radios still booting).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import type { FfsGlassesSession } from "./useFfsBluetooth";
import { screenOwner } from "./reclaim";

/** Derived, human-meaningful connection health for the UI + diagnostics. */
export type ConnectionHealth =
  | "disconnected" // idle: not connected, no known link to recover (never connected / user disconnected)
  | "connecting" //   first connect in flight (scanning / connecting)
  | "reconnecting" // we had a link, it dropped unexpectedly — recovery pending (wake-nudge / FUT-162)
  | "degraded" //     one lens up but pair not yet ready (radios still coming up)
  | "healthy"; //     pair ready — the good state

export type ConnectionEvent = {
  at: number; // epoch ms
  health: ConnectionHealth;
  rawState: string; // underlying driver link state
  note?: string; // e.g. "link dropped", "user disconnect", "reconnect-on-wake nudge"
};

export type ConnectionSupervisor = {
  health: ConnectionHealth;
  /** Rolling transition log (most-recent-last), capped. For the soak. */
  log: ConnectionEvent[];
  /** Disconnect that records user intent (so the label reads "disconnected", not
   *  "reconnecting") AND tears the link down via the driver. */
  disconnect: () => void;
  /** Manual reconnect (clears user-disconnect intent + fires scan+connect). */
  reconnect: () => void;
};

export type SupervisorOptions = {
  /** Max entries kept in the in-memory transition log. */
  logCap?: number;
  /** Optional external sink for every transition (e.g. console / file for the soak). */
  onEvent?: (event: ConnectionEvent) => void;
};

const DEFAULTS: Required<Omit<SupervisorOptions, "onEvent">> = {
  logCap: 200,
};

function deriveHealth(
  connected: boolean,
  ready: boolean,
  rawState: string,
  droppedUnexpectedly: boolean,
): ConnectionHealth {
  if (connected) return ready ? "healthy" : "degraded";
  if (rawState === "scanning" || rawState === "connecting") return "connecting";
  if (droppedUnexpectedly) return "reconnecting"; // recovery pending (wake-nudge / FUT-162)
  return "disconnected";
}

/**
 * The all-day reliability supervisor. Layer it over a useFfsBluetooth session; it
 * observes connection state, nudges a reconnect on wake, re-asserts our HUD surface on
 * reconnect, and exposes health + a transition log.
 *
 *   const bt = useFfsBluetooth();
 *   const sup = useConnectionSupervisor(bt);
 *   // render sup.health; call sup.disconnect() for the user's Disconnect button.
 */
export function useConnectionSupervisor(
  bt: FfsGlassesSession,
  options: SupervisorOptions = {},
): ConnectionSupervisor {
  const connected = bt.sides.L || bt.sides.R;
  const ready = bt.pairReady; // both lenses up + characteristics bound
  const rawState = bt.state;

  const [log, setLog] = useState<ConnectionEvent[]>([]);
  const [droppedUnexpectedly, setDroppedUnexpectedly] = useState(false);

  // Refs so listeners read live values without re-subscribing every render.
  const userDisconnectedRef = useRef(false); // user pressed Disconnect → stay down, label "disconnected"
  const wasConnectedRef = useRef(false); // did we have an established link last tick?
  const btRef = useRef(bt);
  btRef.current = bt;
  const optsRef = useRef<Required<Omit<SupervisorOptions, "onEvent">> & Pick<SupervisorOptions, "onEvent">>({
    ...DEFAULTS,
    ...options,
  });
  optsRef.current = { ...DEFAULTS, ...options };

  const append = useCallback((health: ConnectionHealth, note?: string) => {
    const { logCap, onEvent } = optsRef.current;
    const evt: ConnectionEvent = { at: Date.now(), health, rawState: btRef.current.state, note };
    onEvent?.(evt);
    setLog((prev) => {
      const next = prev.length >= logCap ? prev.slice(prev.length - logCap + 1) : prev.slice();
      next.push(evt);
      return next;
    });
  }, []);

  // React to every connection-state change: detect drops / recoveries, reclaim on ready.
  useEffect(() => {
    if (connected) {
      const wasDown = !wasConnectedRef.current;
      wasConnectedRef.current = true;
      if (droppedUnexpectedly) setDroppedUnexpectedly(false);
      if (wasDown) append(ready ? "healthy" : "degraded", "connected");
      // The moment the pair is READY, re-assert our HUD surface. Deferred a tick so it
      // sequences AFTER the launcher's own connect effects (screenOwner.start + setSurface)
      // rather than racing them onto the BLE write path. reclaimNow no-ops if no surface.
      if (ready) {
        const t = setTimeout(() => screenOwner.reclaimNow(), 0);
        return () => clearTimeout(t);
      }
      return;
    }

    // Not connected.
    const wasUp = wasConnectedRef.current;
    wasConnectedRef.current = false;
    if (wasUp && !userDisconnectedRef.current) {
      // Unexpected drop from an established link. No native retry loop underneath us yet
      // (FUT-162) — surface "reconnecting"; the foreground wake-nudge is the recovery.
      setDroppedUnexpectedly(true);
      append("reconnecting", "link dropped");
    } else {
      setDroppedUnexpectedly(false);
      append(userDisconnectedRef.current ? "disconnected" : deriveHealth(false, false, rawState, false));
    }
  }, [connected, ready, rawState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconnect-on-wake: on foreground, if we're down (and the user didn't ask for that),
  // fire ONE guarded scan+connect so we recover. Guarded on an idle state so we never
  // fire while the driver is already mid-scan/connect.
  useEffect(() => {
    const onAppState = (next: AppStateStatus) => {
      if (next !== "active") return;
      const b = btRef.current;
      if (b.sides.L || b.sides.R || userDisconnectedRef.current) return;
      if (b.state !== "idle") return; // driver already working
      append("connecting", "reconnect-on-wake nudge");
      b.startScan();
      b.connect();
    };
    const sub = AppState.addEventListener("change", onAppState);
    return () => sub.remove();
  }, [append]);

  const disconnect = useCallback(() => {
    userDisconnectedRef.current = true;
    setDroppedUnexpectedly(false);
    append("disconnected", "user disconnect");
    try {
      btRef.current.disconnect();
    } catch {
      // swallow — state settles via the connection-state effect
    }
  }, [append]);

  const reconnect = useCallback(() => {
    userDisconnectedRef.current = false;
    append("connecting", "user reconnect");
    try {
      btRef.current.startScan();
      btRef.current.connect();
    } catch {
      // best-effort
    }
  }, [append]);

  const health = useMemo(
    () => deriveHealth(connected, ready, rawState, droppedUnexpectedly),
    [connected, ready, rawState, droppedUnexpectedly],
  );

  return { health, log, disconnect, reconnect };
}

/** Short human label for a health state (for the connection pill). */
export function healthLabel(h: ConnectionHealth): string {
  switch (h) {
    case "healthy":
      return "Connected";
    case "degraded":
      return "Booting…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "disconnected":
      return "Disconnected";
  }
}
