// `src/data` — THE BRAIN. Network in, bytes out, addressed to an app on the glasses.
//
//     source.fetch()  →  a blob the app understands  (ffsm.ts, or an app's own layout)
//     pump            →  is it new? is it small enough? is the link up?
//     ffsc.ts         →  "here is a value for app N"
//     ble/fxp1.ts     →  the frame the CFW loader already knows how to receive
//
// Wiring it up is four lines:
//
//     const pump = new DataPump({
//       sources: [weatherSource({ place: HOME, fetchJson })],
//       send: (frame) => FfsBle.pushPayloadViaImage(toBase64(frame)),
//       linkUp: () => ble.connected,
//       now: Date.now,
//       log: (ev) => log.emit("data", ev.kind, ev),   // metadata only — see types.ts
//     });
//     setInterval(() => void pump.tick(), 30_000);
//
// ⛔ Nothing in here is proven on glass yet. It is pure, unit-tested and offline; the
//    on-glass half is `g2flash/patches/ffs_data.h`, whose parser is tested against the same
//    bytes. What has NOT happened is a value going over a real radio into a real lens.

export { DataPump } from "./pump";
export type { PumpDeps, PumpStats } from "./pump";
export { DataService } from "./service";
export type { DataServiceDeps } from "./service";
export { Outbox } from "./outbox";
export type { DataEvent, DataLogger, DataSource, Pending } from "./types";
export { weatherSource, weatherToThreads, openMeteoUrl, describeWmo } from "./sources/weather";
export type { WeatherPlace, WeatherSourceOptions } from "./sources/weather";
export { headlinesSource, storiesToThreads, HN_TOP, hnItem } from "./sources/headlines";
export type { HeadlinesOptions, HnStory } from "./sources/headlines";
// ⭐ The notification source. It is deliberately just another `DataSource` — the transport, the
// outbox, the frame, the loader route and the on-glass app are identical to weather's. What makes
// it different lives entirely behind `src/notifications/native.ts`: an Android listener whose
// FIRST act is an allowlist test. It is exported here WITHOUT importing the native module, so
// `src/data` stays pure and offline-testable; the panel injects `readThreads`.
export { notificationsSource, threadsToFfsm, quantiseAgeMin } from "./sources/notifications";
export type { NotificationsOptions } from "./sources/notifications";
// ⭐ Media / now-playing — the phone's active media session on-glass. Ported from the MIT
// takemotions-media-bridge (`MediaHub.kt`); the three documented fixes are the pure functions here.
export {
  mediaSource,
  resolveNowPlaying,
  nowPlayingToThreads,
  projectPosition,
  pickNowPlaying,
  seekTarget,
  PB_PLAYING,
  PB_PAUSED,
  PB_STOPPED,
  PB_NONE,
  STALE_PAUSE_MS,
  SEEK_DEDUP_MS,
} from "./sources/media";
export type { MediaSnapshot, NowPlaying, MediaSourceOptions, SeekState } from "./sources/media";
// ⭐ Navigation — turn-by-turn parsed out of the ongoing nav notification. Technique re-derived
// (appsbridge is unlicensed); no code copied.
export {
  navigationSource,
  parseNav,
  parseDistance,
  parseEta,
  parseInstruction,
  navToThreads,
  isNavPackage,
  NAV_PACKAGES,
} from "./sources/navigation";
export type { NavNotification, NavInfo, NavigationSourceOptions } from "./sources/navigation";
// ⭐ Act-back — reply to a message from the glasses over the source app's own transport (RCS via
// RemoteInput; SMS only as fallback). GOAL Plane 2, condition 8.
export { ReplyDispatcher } from "./actions";
export type { ReplyOutcome, ReplyTarget, ReplyVia, ReplyDispatcherDeps } from "./actions";

/**
 * A tiny JSON fetcher with a timeout, for callers that do not already have one. Kept here
 * rather than inside a source so the sources stay injectable and offline-testable.
 *
 * ⚠️ It throws on a non-2xx rather than returning `{}` — a source that quietly encodes an
 *    empty screen out of an HTTP 503 is the silent failure this whole layer is shaped to
 *    avoid.
 */
export async function jsonFetcher(timeoutMs = 8000): Promise<(url: string) => Promise<unknown>> {
  return async (url: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
}
