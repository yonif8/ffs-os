// Media / now-playing — the song, artist and transport position the phone is playing, rendered
// on-glass as a live readout.
//
// ── PROVENANCE (MIT — attribution required) ───────────────────────────────────────────────────
// The Android acquisition technique this source is built on — reading now-playing from
// `MediaSessionManager.getActiveSessions()` + `MediaController` gated behind an (otherwise empty)
// `NotificationListenerService`, and the three pieces of hard-won engineering below — is ported
// from **takemotions-media-bridge** (`MediaHub.kt`), MIT-licensed:
//
//     takemotions-media-bridge — Copyright (c) r-tkbyc — MIT License
//     https://github.com/r-tkbyc/takemotions-media-bridge
//
// The native `MediaHub.kt` in `modules/ffs-notify` carries the same attribution. This TypeScript
// file is our own re-expression of the three fixes as PURE, offline-testable functions so the
// native side can stay a thin surface over the framework APIs.
//
// ── WHY THIS IS JUST ANOTHER DataSource ───────────────────────────────────────────────────────
// Like `weather` and `headlines`, now-playing is *named lines of short text*, so it encodes as
// FFSM and is drawn by the `messages` reader that already exists on glass — no second renderer
// invented to prove a transport. When a dedicated now-playing app arrives it gets its own appId
// and its own blob; the channel does not change.
//
// ⛔ PRIVACY. A track title/artist is content. `fetch` is the only place it exists in this
//    process, and it exists for one `encodeFfsm` call. Nothing here logs, stringifies or persists
//    a snapshot; everything this module reports about itself is a number. `ffs_os` is PUBLIC.

import { encodeFfsm, type FfsmThread } from "../../sdk/ffsm";
import type { DataSource } from "../types";

/** PlaybackState.STATE_* — the subset we act on. Mirrors android.media.session.PlaybackState. */
export const PB_NONE = 0;
export const PB_STOPPED = 1;
export const PB_PAUSED = 2;
export const PB_PLAYING = 3;

/**
 * One active media session, exactly as the native `MediaHub.getSessions()` hands it over — raw
 * framework fields, no interpretation. The interpretation (which one is "now playing", where the
 * playhead really is) lives in the pure functions below so it is testable with no phone.
 */
export interface MediaSnapshot {
  /** Owning app package — the stable identity used to address a transport control back. */
  pkg: string;
  title: string;
  artist: string;
  album: string;
  /** PlaybackState.getState(). */
  state: number;
  /** PlaybackState.getPosition() — a LAZILY UPDATED SNAPSHOT (see projectPosition). ms. */
  positionMs: number;
  /** PlaybackState.getLastPositionUpdateTime() — SystemClock.elapsedRealtime basis, ms. */
  lastUpdateMs: number;
  /** PlaybackState.getPlaybackSpeed() — 1.0 normal, 0 while paused for most apps. */
  speed: number;
  /** METADATA_KEY_DURATION, or <= 0 for a live/unknown-length stream. ms. */
  durationMs: number;
  /**
   * Recency for the paused-vs-dead decision: the newest of the session's own last-update and the
   * moment WE last paused it. The native side supplies it on the same elapsedRealtime basis as
   * `nowElapsedMs` so the two are comparable. ms.
   */
  lastActiveMs: number;
}

/** The single session chosen to display, with its playhead already projected to "now". */
export interface NowPlaying {
  pkg: string;
  title: string;
  artist: string;
  album: string;
  state: number;
  /** Projected forward from the snapshot — the real playhead, not the stale one. ms. */
  positionMs: number;
  durationMs: number;
  live: boolean;
}

export interface MediaSourceOptions {
  /**
   * Injected so every branch runs on a PC with no phone. In the app this is `readMediaSessions`
   * from `src/notifications/native.ts`, which calls the native `MediaHub`.
   */
  read: () => MediaSnapshot[];
  /**
   * The native clock on the SAME basis as `lastUpdateMs`/`lastActiveMs`
   * (SystemClock.elapsedRealtime). Injected — `Date.now()` is a DIFFERENT clock and mixing the two
   * makes the projection jump. In the app this is `mediaNowElapsedMs` from native.
   */
  nowElapsedMs: () => number;
  /** Which on-glass app renders it. Distinct from messages(3) so the two do not evict each other. */
  appId?: number;
  everyMs?: number;
  /** Skip entirely when the listener grant is absent, so the panel's state is the truth. */
  enabled?: () => boolean;
}

/**
 * How long a PAUSED session stays "resumable" before it is treated as a dead leftover. media-bridge
 * uses five minutes: a track the wearer paused is worth keeping so the glasses can resume it, but a
 * closed app that left a PAUSED session behind should drop off the readout.
 */
export const STALE_PAUSE_MS = 5 * 60_000;

/**
 * ★ BUG 1 — the position is a stale snapshot. `PlaybackState.getPosition()` is only refreshed when
 * the app posts a new state, so a progress bar built on it FREEZES between updates. Project it
 * forward by `speed * (now - lastUpdate)` while playing; leave it put while paused. This is the
 * exact staleness we would have hit on the on-glass progress bar.
 *
 * Pure and clamped: a projection past the known duration is pinned to the end rather than allowed
 * to run off, and a live stream (duration <= 0) is left unclamped.
 */
export function projectPosition(s: Pick<MediaSnapshot, "state" | "positionMs" | "lastUpdateMs" | "speed" | "durationMs">, nowElapsedMs: number): number {
  let pos = s.positionMs;
  if (s.state === PB_PLAYING) {
    const speed = s.speed > 0 ? s.speed : 1;
    pos = s.positionMs + Math.max(0, nowElapsedMs - s.lastUpdateMs) * speed;
  }
  if (pos < 0) pos = 0;
  if (s.durationMs > 0 && pos > s.durationMs) pos = s.durationMs;
  return Math.round(pos);
}

/**
 * ★ BUG 2 — paused-vs-dead. Among the active sessions, pick the one that is really "now playing":
 *
 *   1. any PLAYING session wins (newest-active first if several);
 *   2. otherwise the most-recently-active PAUSED session, but only if it is within STALE_PAUSE_MS —
 *      a user-paused track is resumable, a closed app's leftover is not;
 *   3. otherwise nothing is playing.
 *
 * Pure: `pausedByUs` recency arrives already folded into each snapshot's `lastActiveMs` by native,
 * so the choice is a function of the snapshots and the clock alone.
 */
export function pickNowPlaying(sessions: MediaSnapshot[], nowElapsedMs: number): MediaSnapshot | null {
  const playing = sessions.filter((s) => s.state === PB_PLAYING);
  if (playing.length > 0) {
    return playing.reduce((best, s) => (s.lastActiveMs > best.lastActiveMs ? s : best));
  }
  const paused = sessions
    .filter((s) => s.state === PB_PAUSED && nowElapsedMs - s.lastActiveMs <= STALE_PAUSE_MS)
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return paused[0] ?? null;
}

export interface SeekState {
  /** The absolute target the last relative seek asked for, or null if none is pending. ms. */
  target: number | null;
  /** elapsedRealtime the pending target was set, for the de-dup window. ms. */
  atMs: number;
}

/**
 * ★ BUG 3 — seek de-dup. A player does not publish its new position the instant you seek (measured
 * on YouTube), so a second "+30s" tapped quickly would recompute off the STALE reported position
 * and lose the first jump. Inside a short window, count the next relative delta from what we last
 * ASKED for, not from what the player currently reports — so two quick +30s add up to +60s.
 *
 * Pure: returns the new absolute target and the SeekState to carry to the next call. `reported` is
 * the projected current position; `prev` is the SeekState from the previous seek (or a fresh one).
 */
export const SEEK_DEDUP_MS = 4_000;

export function seekTarget(
  reportedMs: number,
  deltaMs: number,
  durationMs: number,
  prev: SeekState,
  nowElapsedMs: number,
): { target: number; next: SeekState } {
  const base = prev.target !== null && nowElapsedMs - prev.atMs <= SEEK_DEDUP_MS ? prev.target : reportedMs;
  let target = base + deltaMs;
  if (target < 0) target = 0;
  if (durationMs > 0 && target > durationMs) target = durationMs;
  target = Math.round(target);
  return { target, next: { target, atMs: nowElapsedMs } };
}

// ---------------------------------------------------------------- encoding

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STATE_WORD: Record<number, string> = {
  [PB_PLAYING]: "play",
  [PB_PAUSED]: "paused",
  [PB_STOPPED]: "stopped",
  [PB_NONE]: "-",
};

/**
 * Turn the chosen session into the FFSM thread the glasses draw. Messages are OLDEST-first and the
 * app opens the thread at its LAST line, so the title — the thing a glance wants — goes last.
 *
 * Throws when nothing is playing: an empty now-playing screen is not a screen, and pushing one
 * would replace whatever the glasses hold with nothing (the silent-failure shape this layer avoids).
 * ⛔ The message says nothing about the track.
 */
export function nowPlayingToThreads(np: NowPlaying | null): FfsmThread[] {
  if (!np) throw new Error("media: nothing playing");

  const messages: FfsmThread["messages"] = [];
  if (np.artist) messages.push({ fromMe: false, ageMin: 0, body: np.artist });

  const word = STATE_WORD[np.state] ?? "-";
  const posLine = np.live
    ? `live ${word}`
    : np.durationMs > 0
      ? `${mmss(np.positionMs)}/${mmss(np.durationMs)} ${word}`
      : `${mmss(np.positionMs)} ${word}`;
  messages.push({ fromMe: false, ageMin: 0, body: posLine });

  // Title last — the app opens here. Fall back to the package so the thread always has a body.
  messages.push({ fromMe: false, ageMin: 0, body: np.title || np.pkg });

  const name = np.artist || np.title || "Now Playing";
  return [{ name, unread: false, messages }];
}

/**
 * Resolve the raw sessions to a single projected NowPlaying, or null when nothing qualifies. Kept
 * separate from `fetch` so the whole decision is testable without building a source.
 */
export function resolveNowPlaying(sessions: MediaSnapshot[], nowElapsedMs: number): NowPlaying | null {
  const s = pickNowPlaying(sessions, nowElapsedMs);
  if (!s) return null;
  return {
    pkg: s.pkg,
    title: s.title,
    artist: s.artist,
    album: s.album,
    state: s.state,
    positionMs: projectPosition(s, nowElapsedMs),
    durationMs: s.durationMs,
    live: s.durationMs <= 0,
  };
}

/** The `DataSource` the pump polls. */
export function mediaSource(opts: MediaSourceOptions): DataSource {
  const { read, nowElapsedMs } = opts;
  const enabled = opts.enabled;
  return {
    id: "media",
    appId: opts.appId ?? 4,
    everyMs: opts.everyMs ?? 5_000,
    async fetch(): Promise<Uint8Array> {
      if (enabled && !enabled()) throw new Error("media: listener not enabled");
      return encodeFfsm(nowPlayingToThreads(resolveNowPlaying(read(), nowElapsedMs())));
    },
  };
}
