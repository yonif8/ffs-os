// Media / now-playing, as tests. The three fixes media-bridge documents are the point: each is a
// PURE function here, so a projected playhead, a paused-vs-dead pick and a de-duped seek are all
// checked with no phone and no clock of their own.
//
// ⛔ Every title/artist in this file is INVENTED. `ffs_os` is PUBLIC.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DataPump } from "../pump";
import {
  PB_PAUSED,
  PB_PLAYING,
  PB_STOPPED,
  SEEK_DEDUP_MS,
  STALE_PAUSE_MS,
  type MediaSnapshot,
  mediaSource,
  nowPlayingToThreads,
  pickNowPlaying,
  projectPosition,
  resolveNowPlaying,
  seekTarget,
} from "../sources/media";
import { decodeFfsm } from "../../sdk/ffsm";
import { decodeFfsc } from "../../sdk/ffsc";
import type { DataEvent } from "../types";

const snap = (over: Partial<MediaSnapshot> = {}): MediaSnapshot => ({
  pkg: "com.example.player",
  title: "A Song",
  artist: "An Artist",
  album: "An Album",
  state: PB_PLAYING,
  positionMs: 30_000,
  lastUpdateMs: 1_000_000,
  speed: 1,
  durationMs: 240_000,
  lastActiveMs: 1_000_000,
  ...over,
});

// ── BUG 1: position projection ─────────────────────────────────────────────────────────────
describe("projectPosition", () => {
  it("projects a playing playhead forward by speed*elapsed instead of freezing on the snapshot", () => {
    const s = snap({ positionMs: 30_000, lastUpdateMs: 1_000_000, speed: 1 });
    expect(projectPosition(s, 1_000_000)).toBe(30_000);
    expect(projectPosition(s, 1_005_000)).toBe(35_000); // +5 s later, +5 s of playhead
  });

  it("honours playback speed", () => {
    const s = snap({ positionMs: 0, lastUpdateMs: 0, speed: 2 });
    expect(projectPosition(s, 10_000)).toBe(20_000);
  });

  it("does NOT advance a paused playhead", () => {
    const s = snap({ state: PB_PAUSED, positionMs: 42_000, lastUpdateMs: 0, speed: 0 });
    expect(projectPosition(s, 999_000)).toBe(42_000);
  });

  it("clamps to the known duration and never below zero", () => {
    expect(projectPosition(snap({ positionMs: 239_000, lastUpdateMs: 0, durationMs: 240_000 }), 100_000)).toBe(240_000);
    expect(projectPosition(snap({ positionMs: -5, state: PB_PAUSED, speed: 0 }), 0)).toBe(0);
  });

  it("leaves a live stream (duration <= 0) unclamped", () => {
    const s = snap({ positionMs: 0, lastUpdateMs: 0, durationMs: 0, speed: 1 });
    expect(projectPosition(s, 60_000)).toBe(60_000);
  });
});

// ── BUG 2: paused-vs-dead session pick ──────────────────────────────────────────────────────
describe("pickNowPlaying", () => {
  it("prefers a PLAYING session over any paused one", () => {
    const chosen = pickNowPlaying([snap({ pkg: "a", state: PB_PAUSED }), snap({ pkg: "b", state: PB_PLAYING })], 1_000_000);
    expect(chosen?.pkg).toBe("b");
  });

  it("among several playing, takes the most recently active", () => {
    const chosen = pickNowPlaying(
      [snap({ pkg: "old", state: PB_PLAYING, lastActiveMs: 10 }), snap({ pkg: "new", state: PB_PLAYING, lastActiveMs: 99 })],
      1_000_000,
    );
    expect(chosen?.pkg).toBe("new");
  });

  it("keeps a recently user-paused track (resumable) but DROPS a stale dead session", () => {
    const now = 10_000_000;
    const fresh = snap({ pkg: "fresh", state: PB_PAUSED, lastActiveMs: now - 1_000 });
    const dead = snap({ pkg: "dead", state: PB_PAUSED, lastActiveMs: now - STALE_PAUSE_MS - 1 });
    expect(pickNowPlaying([fresh, dead], now)?.pkg).toBe("fresh");
    expect(pickNowPlaying([dead], now)).toBeNull();
  });

  it("returns null when nothing is playing or resumable", () => {
    expect(pickNowPlaying([], 0)).toBeNull();
    expect(pickNowPlaying([snap({ state: PB_STOPPED })], 0)).toBeNull();
  });
});

// ── BUG 3: seek de-dup ──────────────────────────────────────────────────────────────────────
describe("seekTarget", () => {
  it("two quick relative seeks ADD UP even though the player has not published the first yet", () => {
    const dur = 300_000;
    // player still reports 30 s (stale) for both taps
    const first = seekTarget(30_000, 30_000, dur, { target: null, atMs: 0 }, 1_000);
    expect(first.target).toBe(60_000);
    const second = seekTarget(30_000, 30_000, dur, first.next, 1_500); // within the window, still stale report
    expect(second.target).toBe(90_000); // 30 + 30 + 30, not 30 + 30
  });

  it("counts from the real position again once the de-dup window has passed", () => {
    const dur = 300_000;
    const first = seekTarget(30_000, 30_000, dur, { target: null, atMs: 0 }, 1_000);
    const later = seekTarget(65_000, 30_000, dur, first.next, 1_000 + SEEK_DEDUP_MS + 1);
    expect(later.target).toBe(95_000); // 65 (now real) + 30
  });

  it("clamps to [0, duration]", () => {
    expect(seekTarget(10_000, -30_000, 300_000, { target: null, atMs: 0 }, 0).target).toBe(0);
    expect(seekTarget(290_000, 30_000, 300_000, { target: null, atMs: 0 }, 0).target).toBe(300_000);
  });
});

// ── encoding + end-to-end ───────────────────────────────────────────────────────────────────
describe("nowPlayingToThreads", () => {
  it("puts the TITLE last, where the app opens the thread", () => {
    const np = resolveNowPlaying([snap()], 1_000_000)!;
    const [t] = nowPlayingToThreads(np);
    const last = t.messages[t.messages.length - 1];
    expect(last.body).toBe("A Song");
  });

  it("shows a mm:ss/mm:ss progress line with the play state", () => {
    const np = resolveNowPlaying([snap({ positionMs: 83_000, durationMs: 240_000, lastUpdateMs: 1_000_000 })], 1_000_000)!;
    const [t] = nowPlayingToThreads(np);
    expect(t.messages.some((m) => m.body === "1:23/4:00 play")).toBe(true);
  });

  it("marks a live stream instead of a bogus progress bar", () => {
    const np = resolveNowPlaying([snap({ durationMs: 0 })], 1_000_000)!;
    const [t] = nowPlayingToThreads(np);
    expect(t.messages.some((m) => m.body.startsWith("live"))).toBe(true);
  });

  it("throws when nothing is playing — an empty now-playing screen is not a screen", () => {
    expect(() => nowPlayingToThreads(null)).toThrow(/nothing playing/);
  });
});

describe("mediaSource end to end", () => {
  it("produces a blob the channel accepts and the messages parser reads", async () => {
    let clock = 1_000_000;
    const src = mediaSource({ read: () => [snap()], nowElapsedMs: () => clock });
    const w = { sent: [] as Uint8Array[], events: [] as DataEvent[], up: true };
    const p = new DataPump({
      sources: [src],
      send: async (f) => void w.sent.push(f),
      linkUp: () => w.up,
      now: () => clock,
      log: (ev) => w.events.push(ev),
    });
    await p.tick();
    expect(w.sent.length).toBe(1);
    const threads = decodeFfsm(decodeFfsc(w.sent[0].slice(12)).blob);
    expect(threads[0].messages[threads[0].messages.length - 1].body).toBe("A Song");
    expect(src.appId).toBe(4);
  });

  it("says nothing when the session is a dead paused leftover", async () => {
    const now = 10_000_000;
    const src = mediaSource({
      read: () => [snap({ state: PB_PAUSED, lastActiveMs: now - STALE_PAUSE_MS - 1 })],
      nowElapsedMs: () => now,
    });
    const w = { sent: [] as Uint8Array[], events: [] as DataEvent[] };
    const p = new DataPump({
      sources: [src],
      send: async (f) => void w.sent.push(f),
      linkUp: () => true,
      now: () => now,
      log: (ev) => w.events.push(ev),
    });
    await p.tick();
    expect(w.sent.length).toBe(0);
    expect(w.events.some((e) => e.kind === "fetch-failed")).toBe(true);
  });

  it("is disabled cleanly when the listener is not granted", async () => {
    const src = mediaSource({ read: () => [snap()], nowElapsedMs: () => 0, enabled: () => false });
    await expect(src.fetch(0)).rejects.toThrow(/not enabled/);
  });
});

// ── privacy: no title/artist in any log, event or stat ──────────────────────────────────────
describe("privacy", () => {
  it("NO track content reaches any event or telemetry record", async () => {
    const TITLE = "ZZ-MEDIA-TITLE-7c21-DO-NOT-LEAK";
    const ARTIST = "ZZ-MEDIA-ARTIST-4d90";
    let clock = 1_000_000;
    const src = mediaSource({ read: () => [snap({ title: TITLE, artist: ARTIST })], nowElapsedMs: () => clock });
    const w = { sent: [] as Uint8Array[], events: [] as DataEvent[] };
    const p = new DataPump({
      sources: [src],
      send: async (f) => void w.sent.push(f),
      linkUp: () => true,
      now: () => clock,
      log: (ev) => w.events.push(ev),
    });
    await p.tick();
    expect(w.sent.length).toBeGreaterThan(0);
    const spilled = JSON.stringify([w.events, p.stats]);
    expect(spilled).not.toContain(TITLE);
    expect(spilled).not.toContain(ARTIST);
    expect(spilled).not.toContain("MEDIA-TITLE");
  });

  it("the native MediaHub has no logging on the intake path", () => {
    const f = join(
      import.meta.dir, "..", "..", "..",
      "modules", "ffs-notify", "android", "src", "main", "java", "expo", "modules", "ffsnotify", "MediaHub.kt",
    );
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bandroid\.util\.Log\b/);
    expect(src).not.toMatch(/\bLog\.[vdiwe]\s*\(/);
    expect(src).not.toMatch(/\bprintln\s*\(/);
  });
});
