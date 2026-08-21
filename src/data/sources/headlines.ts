// Headlines — the second source, and its real job is to prove the channel is not
// weather-shaped or messages-shaped. Different API, different parsing, different wording,
// same 60 lines of shape; the transport and the on-glass app change not at all.
//
// ── WHY IT NEEDS NO PERMISSION ───────────────────────────────────────────────────────
// The Hacker News Firebase API (https://github.com/HackerNews/API) is public, keyless and
// account-less over HTTPS. INTERNET is the only Android permission involved, and there is no
// token to leak into this PUBLIC repo. As with weather, the phone does the fetching, the
// ranking and the wording; the glasses render bytes.
//
// ⚠️ TWO ROUND TRIPS BY DESIGN. `topstories.json` returns ~500 ids and each item is its own
//    GET, so this fetches the id list once and then `count` items. That is chatty for a
//    battery, which is why `everyMs` defaults to 10 minutes and `count` to 6 — and why the
//    pump's `unchanged` check matters: a quiet front page costs one radio push, not none and
//    not many.

import { encodeFfsm, type FfsmThread } from "../../sdk/ffsm";
import type { DataSource } from "../types";

export interface HeadlinesOptions {
  /** Injected so every branch below is testable with no network. */
  fetchJson: (url: string) => Promise<unknown>;
  /** Thread name on the glasses. Short — 15 chars max on the wire. */
  label?: string;
  /** Which on-glass app renders it. 3 = `messages`, the first FFSM reader. */
  appId?: number;
  everyMs?: number;
  /** How many stories. Each costs one HTTP round trip. */
  count?: number;
}

export const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
export const hnItem = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

export interface HnStory {
  title: string;
  /** unix seconds */
  time: number;
  score?: number;
}

/**
 * Rank + word the stories for a 13-character line.
 *
 * ★ ORDER MATTERS AND IS NOT COSMETIC. FFSM messages are OLDEST FIRST and `apps/messages.c`
 *   opens a thread at its NEWEST message — so the #1 story goes LAST, and tapping in shows
 *   the top story rather than the sixth. Getting this backwards would render perfectly and
 *   show the wrong thing, which is the only kind of bug that survives a camera check.
 *
 * Throws on an empty list rather than encoding an empty screen.
 */
export function storiesToThreads(stories: HnStory[], now: number, label = "HN"): FfsmThread[] {
  const usable = stories.filter((s) => s && typeof s.title === "string" && s.title.length > 0);
  if (usable.length === 0) throw new Error("hn: no usable stories in the response");
  const messages = usable
    .slice()
    .reverse() // #1 last — see above
    .map((s) => ({
      fromMe: false,
      ageMin: Number.isFinite(s.time) ? Math.max(0, Math.round((now - s.time * 1000) / 60000)) : 0,
      // The score is worth its 4 characters: it is the one number that says "is this big".
      body: typeof s.score === "number" ? `${s.score} ${s.title}` : s.title,
    }));
  return [{ name: label, unread: true, messages }];
}

export function headlinesSource(opts: HeadlinesOptions): DataSource {
  const { fetchJson } = opts;
  const count = opts.count ?? 6;
  const label = opts.label ?? "HN";
  return {
    id: `headlines:${label}`,
    appId: opts.appId ?? 3,
    everyMs: opts.everyMs ?? 10 * 60_000,
    async fetch(now: number): Promise<Uint8Array> {
      const ids = await fetchJson(HN_TOP);
      if (!Array.isArray(ids)) throw new Error("hn: topstories did not return a list");
      const wanted = ids.filter((n) => typeof n === "number").slice(0, count) as number[];
      if (wanted.length === 0) throw new Error("hn: topstories was empty");
      // Settled, not `all`: one dead item must not lose the other five. A source that
      // returns five good headlines is doing its job; one that returns nothing because the
      // sixth 404'd is not.
      const results = await Promise.allSettled(wanted.map((id) => fetchJson(hnItem(id))));
      const stories = results
        .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled")
        .map((r) => r.value as HnStory)
        .filter((s) => s && typeof s.title === "string");
      return encodeFfsm(storiesToThreads(stories, now, label));
    },
  };
}
