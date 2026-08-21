// useNotificationBridge — the notification→glasses pump, RUNNING AT APP SCOPE.
//
// ⭐ WHY THIS IS NOT IN NotificationsPanel. It used to be, and that was a real bug: the panel
//    mounts only while the Drive tab is on screen, so the DataService — the thing that forwards
//    every message to the glasses, auto-rebinds the listener, and runs the crash circuit-breaker —
//    only lived while the user was LOOKING at the notifications screen. Switch to Link and messages
//    silently stopped reaching the glasses (found on hardware 2026-08-21). A bridge that only works
//    while you are watching it is not a bridge. This hook is called once from AppInner, which is
//    always mounted, so the pump runs for the whole life of the app regardless of tab.
//
// It owns the SERVICE (pump, timer, reconnect, breaker) and the native listener's connection state.
// The panel keeps only its own UI — the allowlist toggles — and reads everything else from here.
//
// ⛔ PRIVACY unchanged: nothing here reads or holds a message body. `stats` is counts; the bodies
//    live in the native store and go only to the FFSM encoder and the BLE wire (see NotifyStore.kt).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import FfsBle from "../../modules/ffs-ble";
import { toBase64 } from "../sdk/base64";
import { DataService } from "../data/service";
import { notificationsSource } from "../data/sources/notifications";
import {
  EMPTY_STATS,
  getCaptureEnabled,
  getStats,
  listenerConnected,
  listenerEnabled,
  notifyAvailable,
  onNotifyChange,
  readThreads,
  requestRebind,
  type NotifyStats,
} from "./native";

export interface NotificationBridge {
  /** Android with the native module present. iOS and web are false — the panel shows a stub. */
  available: boolean;
  /** Both lenses linked AND the CFW loader proven — the only state in which a push is delivered. */
  canSend: boolean;
  pairReady: boolean;
  /** The listener is enabled in Android settings. */
  granted: boolean;
  /** The listener is actually bound and receiving. Can be false while granted after a force-stop. */
  bound: boolean;
  /** The capture master-switch (separate from the OS grant). */
  capture: boolean;
  /** Metadata counts only — never a body. */
  stats: NotifyStats;
  /** The crash circuit-breaker is open: a push was followed by a lens drop, twice. */
  breakerOpen: boolean;
  /** Deliberately (re-)push the current inbox now — the only thing that re-arms the breaker. */
  pushNow: () => void;
  /** Re-read native state after the panel edits the allowlist or the capture switch. */
  refresh: () => void;
}

export function useNotificationBridge(pairReady: boolean, loaderPresent: boolean): NotificationBridge {
  const available = useMemo(() => notifyAvailable(), []);
  const [granted, setGranted] = useState(false);
  const [bound, setBound] = useState(false);
  const [capture, setCapture] = useState(false);
  const [stats, setStats] = useState<NotifyStats>(EMPTY_STATS);
  const [breakerOpen, setBreakerOpen] = useState(false);

  // "The link is up" for this feature means BOTH lenses linked AND the CFW loader proven — a value
  // pushed at stock firmware is not delivered. Read through a ref so `linkUp` sees the CURRENT
  // link without the service (and its outbox, which holds a message across a reconnect) being torn
  // down on every blip.
  const canSend = pairReady && loaderPresent;
  const linkRef = useRef(canSend);
  linkRef.current = canSend;
  const svcRef = useRef<DataService | null>(null);

  const refresh = useCallback(() => {
    setGranted(listenerEnabled());
    setBound(listenerConnected());
    setCapture(getCaptureEnabled());
    setStats(getStats());
  }, []);

  const service = useMemo(() => {
    if (!available) return null;
    const svc = new DataService({
      sources: [
        notificationsSource({
          read: readThreads,
          enabled: () => listenerEnabled() && getCaptureEnabled(),
        }),
      ],
      // Fire-and-forget: "sent" is not "landed" (the ⟨LOADER … ret=0x64…⟩ line is the truth).
      send: async (frame) => {
        if (!linkRef.current) throw new Error("link down");
        FfsBle.pushPayloadViaImage(toBase64(frame));
      },
      linkUp: () => linkRef.current,
      tickMs: 30_000,
      log: (ev) => {
        if (ev.kind === "breaker-tripped") setBreakerOpen(true);
        else if (ev.kind === "breaker-reset") setBreakerOpen(false);
      },
    });
    svcRef.current = svc;
    return svc;
  }, [available]);

  // App-wide lifecycle: start the pump, subscribe to arrivals, poll native connection state.
  useEffect(() => {
    if (!available) return;
    refresh();
    const off = onNotifyChange((s) => {
      setStats(s); // ⛔ METADATA ONLY — see FfsNotifyModule.emitChange.
      svcRef.current?.nudge("notifications");
    });
    const poll = setInterval(refresh, 3000);
    service?.start();
    return () => {
      off();
      clearInterval(poll);
      service?.stop();
    };
  }, [available, refresh, service]);

  // A lens dropping off the link is the crash signal the breaker watches for. Report it PROMPTLY
  // (on the prop change) rather than at the next 30 s tick, or the reconnect re-send beats the trip.
  const prevPairRef = useRef(pairReady);
  useEffect(() => {
    if (prevPairRef.current && !pairReady) svcRef.current?.noteLinkDown();
    prevPairRef.current = pairReady;
  }, [pairReady]);

  // AUTO-REBIND. A force-stop (or an app update) leaves the listener granted-but-unbound and Android
  // does not always rebind it on its own. While that is true, keep asking — the alternative is the
  // silent hole where messages post to the phone and never reach the glasses because nothing is
  // listening. Throttled by the 3 s `bound` poll above; requestRebind is cheap and idempotent.
  useEffect(() => {
    if (available && granted && !bound) requestRebind();
  }, [available, granted, bound]);

  const pushNow = useCallback(() => {
    const svc = svcRef.current;
    if (!svc) return;
    // A manual push is a DELIBERATE retry — the one thing allowed to re-arm a tripped channel.
    svc.pump.resetBreaker();
    setBreakerOpen(false);
    svc.pump.forgetLanded();
    svc.nudge("notifications");
    void svc.tick();
  }, []);

  return { available, canSend, pairReady, granted, bound, capture, stats, breakerOpen, pushNow, refresh };
}
