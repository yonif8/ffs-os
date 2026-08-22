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
import { mediaSource } from "../data/sources/media";
import { navigationSource } from "../data/sources/navigation";
import { weatherSource, type WeatherPlace } from "../data/sources/weather";
import { ReplyDispatcher, type ReplyOutcome, type ReplyTarget } from "../data/actions";
import {
  EMPTY_STATS,
  getCaptureEnabled,
  getStats,
  listenerConnected,
  listenerEnabled,
  mediaControl,
  mediaNowElapsedMs,
  notifyAvailable,
  onNotifyChange,
  readMediaSessions,
  readNav,
  readThreads,
  replyViaRemoteInput,
  requestRebind,
  type NotifyStats,
} from "./native";

/**
 * ── APP-ID MAP (must match each on-glass app's `@app id=` directive) ──────────────────────────
 * Each source targets ONE app's data channel; the id is the same key `ffs_appload.h` slots use.
 *   3 messages (apps/messages.c) · 4 music (apps/music.c) · 5 navigation · 6 weather (apps/weather.c)
 * ⚠️ ffs_data.h holds G2D_MAX_CH = 2 channels at once (LRU-evicted). With more than two sources
 *    emitting, the least-recently-pushed app's value is dropped on glass — for a clean two-app
 *    proof (e.g. music + weather), keep only those two emitting (turn notification capture off,
 *    and nav only emits while navigating).
 */
const APP_MESSAGES = 3;
const APP_MUSIC = 4;
const APP_NAV = 5;
const APP_WEATHER = 6;

/**
 * A placeholder weather location so the source is self-contained for a desk/worn proof. It is NOT
 * the wearer's location (that would be content in a PUBLIC repo) — the wearer configures a real
 * place; this default just makes the weather channel produce a real, verifiable value on its own.
 */
const DEFAULT_WEATHER_PLACE: WeatherPlace = { name: "London", latitude: 51.51, longitude: -0.13 };

/** A tiny keyless JSON GET for the weather source. Injected so the source stays offline-testable. */
async function weatherFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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
  /**
   * Act-back: reply to a message over the source app's own transport (RCS via RemoteInput).
   * GOAL Plane 2, condition 8. ⚠️ There is no glass→phone wire that calls this yet (S6) — it is
   * exposed so the worn proof of an on-glass reply is a one-line addition, not new plumbing.
   * ⛔ `text` is content: passed straight to the native call, never logged.
   */
  reply: (target: ReplyTarget, text: string, requestId: string) => ReplyOutcome;
  /**
   * Act-back: drive the phone's active media session (play|pause|playpause|next|prev|seek).
   * The phone half of a transport gesture from apps/music.c. Same S6 caveat as `reply`.
   */
  mediaControl: (pkg: string, action: string, argMs?: number) => boolean;
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
        // ⭐ Music / now-playing — its OWN app now (apps/music.c, appId 4), no longer piggybacking
        // on the messages reader. `media` only emits a frame while something is PLAYING (fetch
        // throws otherwise → the pump skips the tick). The source's everyMs is 5 s and the pump
        // ticks every 5 s (tickMs below), so the playhead is re-fetched and re-pushed each tick;
        // apps/music.c re-reads ctx->api->data every draw, so the bar advances. (This is the fix
        // for the old "stuck at 00:10", which was the 30 s pump tick, not the app.)
        mediaSource({
          read: readMediaSessions,
          nowElapsedMs: mediaNowElapsedMs,
          appId: APP_MUSIC,
          enabled: () => listenerEnabled(),
        }),
        // ⭐ Navigation — turn-by-turn parsed from the ongoing nav notification (appId 5). Emits
        // only while a maps app is actively navigating (navToThreads throws otherwise). Same
        // listener grant; no location permission. Ready for a worn proof — start navigation and
        // launch the (future) nav app, or reuse the messages reader on appId 5.
        navigationSource({
          read: readNav,
          appId: APP_NAV,
          enabled: () => listenerEnabled(),
        }),
        // ⭐ Weather — a NON-notification live source (apps/weather.c, appId 6): the phone fetches
        // keyless Open-Meteo, words it, encodes FFSM. This is the second half of GOAL Outcome B.7 —
        // a DIFFERENT app reading a DIFFERENT live source with NO new wire code, just another
        // declared DataSource on the same channel. Self-contained: it produces a real value from
        // DEFAULT_WEATHER_PLACE with no live external event needed.
        weatherSource({
          place: DEFAULT_WEATHER_PLACE,
          fetchJson: weatherFetchJson,
          appId: APP_WEATHER,
        }),
      ],
      // Fire-and-forget: "sent" is not "landed" (the ⟨LOADER … ret=0x64…⟩ line is the truth).
      send: async (frame) => {
        if (!linkRef.current) throw new Error("link down");
        FfsBle.pushPayloadViaImage(toBase64(frame));
      },
      linkUp: () => linkRef.current,
      // 5 s so a live source (media now-playing, everyMs 5 s) actually refreshes its playhead
      // instead of freezing between 30 s ticks. Sources that are unchanged still dedupe to silence
      // in the pump, so notifications add no extra radio — only a changing frame is sent.
      tickMs: 5_000,
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

  // Act-back dispatcher — RemoteInput only (SEND_SMS not requested by default, so no `sms`).
  // De-dup + validation live in ReplyDispatcher; this hook just owns the one instance.
  const replier = useMemo(() => new ReplyDispatcher({ remoteInput: replyViaRemoteInput }), []);
  const reply = useCallback(
    (target: ReplyTarget, text: string, requestId: string): ReplyOutcome =>
      replier.reply(target, text, requestId),
    [replier],
  );
  const control = useCallback(
    (pkg: string, action: string, argMs = 0): boolean => mediaControl(pkg, action, argMs),
    [],
  );

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

  return {
    available, canSend, pairReady, granted, bound, capture, stats, breakerOpen, pushNow, refresh,
    reply, mediaControl: control,
  };
}
