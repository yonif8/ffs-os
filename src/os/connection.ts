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
import {
  deriveHealth,
  reduceConnection,
  type ConnectionEvent,
  type ConnectionHealth,
} from "./connectionCore";

// The health types + the pure derivation/reducer live in connectionCore.ts (no react-native,
// so `bun test` can load them). Re-exported here so existing importers ("./connection") are
// unaffected.
export { deriveHealth, healthLabel, reduceConnection } from "./connectionCore";
export type {
  ConnectionEvent,
  ConnectionHealth,
  ConnTransition,
  ConnTransitionInput,
  ConnTransitionPrev,
} from "./connectionCore";

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

  // React to every connection-state change: detect drops / recoveries, reclaim on ready. The
  // decision itself is the pure `reduceConnection` (tested in connectionCore); this effect only
  // applies its result — advance the wasConnected latch, update the drop flag, append the event.
  //
  // ⛔ NOTE (2026-08-07): coming-ready no longer re-asserts the JS HUD surface. With the legacy
  // phone-OS no longer owning the HUD (see App.tsx), re-claiming on every reconnect is precisely
  // the behaviour that repainted over natively-declared pages — and because this link re-pairs on
  // its own, it fired repeatedly without user action (it also made one connect produce TWO paints).
  useEffect(() => {
    const t = reduceConnection(
      { wasConnected: wasConnectedRef.current, droppedUnexpectedly },
      { connected, ready, rawState, userDisconnected: userDisconnectedRef.current },
    );
    wasConnectedRef.current = t.wasConnected;
    if (t.droppedUnexpectedly !== droppedUnexpectedly) setDroppedUnexpectedly(t.droppedUnexpectedly);
    if (t.event) append(t.event.health, t.event.note);
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
