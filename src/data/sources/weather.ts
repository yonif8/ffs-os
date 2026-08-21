// Weather — the first live value the glasses ever showed that the phone went and got.
//
// ── WHY THIS SOURCE, AND WHY IT NEEDS NO PERMISSION ──────────────────────────────────
// Open-Meteo (https://open-meteo.com) is a free, keyless, account-less HTTPS weather API.
// It needs no API key to sign up for, no OAuth, no token in this PUBLIC repo — and, because
// the place is a value the wearer configures rather than something the phone measures, it
// needs **no ACCESS_COARSE_LOCATION either**. The only Android permission involved is
// INTERNET, which is normal-level and granted at install.
//
// ⛔ That is deliberate and not just convenient. Notifications are OUT OF SCOPE by Yoni's
//    explicit decision (no NotificationListenerService), and the honest reading of that
//    decision rules out routing around it via SMS or call-log permissions too. A network
//    source proves the architecture *properly*: the phone does the fetching, the parsing and
//    the wording; the glasses do nothing but render bytes they were handed. That is GOAL.md
//    §2 with no asterisk.
//
// ── WHY IT ENCODES AS FFSM ───────────────────────────────────────────────────────────
// FFSM is not "the messages format" — it is *named threads of short, dated lines*, and that
// is exactly what a weather readout is. The `messages` app is the first READER of that
// store, so this is a live value rendered by an app that already exists, without inventing a
// second on-glass renderer to prove a transport. When a weather app of its own arrives it
// gets its own appId and its own blob layout; the channel does not change.
//
// ⚠️ The ages are real: `ageMin` counts back from the reading's own timestamp, so a screen
//    an hour old SAYS it is an hour old. The glasses never advance a clock they cannot check
//    (see ffsm.ts) — the phone re-pushes instead.

import { encodeFfsm, type FfsmThread } from "../../sdk/ffsm";
import type { DataSource } from "../types";

export interface WeatherPlace {
  /** Short — it becomes the FFSM thread name, capped at 15 chars on the wire. */
  name: string;
  latitude: number;
  longitude: number;
}

export interface WeatherSourceOptions {
  place: WeatherPlace;
  /** Injected so every branch below is testable with no network. */
  fetchJson: (url: string) => Promise<unknown>;
  /** Which on-glass app renders it. 3 = `messages`, the first FFSM reader. */
  appId?: number;
  everyMs?: number;
  /** How many PAST hourly readings to include under the current one. */
  hours?: number;
}

/** WMO weather codes → a word that fits a 13-character line. */
const WMO: Array<[number, string]> = [
  [0, "clear"],
  [1, "clear"],
  [2, "cloudy"],
  [3, "overcast"],
  [45, "fog"],
  [48, "fog"],
  [51, "drizzle"],
  [53, "drizzle"],
  [55, "drizzle"],
  [56, "freez rain"],
  [57, "freez rain"],
  [61, "rain"],
  [63, "rain"],
  [65, "heavy rain"],
  [66, "freez rain"],
  [67, "freez rain"],
  [71, "snow"],
  [73, "snow"],
  [75, "heavy snow"],
  [77, "snow"],
  [80, "showers"],
  [81, "showers"],
  [82, "downpour"],
  [85, "snow"],
  [86, "snow"],
  [95, "storm"],
  [96, "storm"],
  [99, "storm"],
];

export function describeWmo(code: number): string {
  for (const [c, word] of WMO) if (c === code) return word;
  return "?";
}

export function openMeteoUrl(place: WeatherPlace): string {
  const q = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,weather_code,wind_speed_10m",
    hourly: "temperature_2m,weather_code",
    forecast_days: "1",
    past_days: "1",
    timezone: "UTC",
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

interface OpenMeteo {
  current?: { time?: string; temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
  hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[] };
}

/**
 * Open-Meteo emits `YYYY-MM-DDTHH:MM` (occasionally with seconds) and attaches NO zone —
 * we asked for `timezone=UTC`, so say so explicitly. Letting the JS engine guess would make
 * it LOCAL time, i.e. silently wrong by the phone's offset, which on a screen whose whole
 * job is "how old is this reading" is the worst possible kind of wrong.
 */
function utcMs(stamp: string): number {
  const s = stamp.endsWith("Z") ? stamp : stamp.length === 16 ? `${stamp}:00Z` : `${stamp}Z`;
  return Date.parse(s);
}

function hhmm(stamp: string): string {
  const t = stamp.slice(11, 16);
  return t.length === 5 ? t : stamp;
}

const round = (n: number) => Math.round(n);

/**
 * Turn one Open-Meteo response into the FFSM threads the glasses will draw. Pure — this is
 * where every parsing decision lives, and therefore where the tests point.
 *
 * Throws on a response that does not carry a current reading. A source that returned a
 * plausible-looking empty screen instead would be the exact failure this project keeps
 * paying for: something renders, nothing is wrong, and the number is a lie.
 */
export function weatherToThreads(json: unknown, now: number, place: WeatherPlace, hours = 5): FfsmThread[] {
  const w = json as OpenMeteo;
  const cur = w?.current;
  if (!cur || typeof cur.temperature_2m !== "number" || typeof cur.time !== "string") {
    throw new Error("open-meteo: response carries no current reading");
  }
  const curMs = utcMs(cur.time);
  if (Number.isNaN(curMs)) throw new Error(`open-meteo: unparseable timestamp "${cur.time}"`);

  const messages = [];
  const h = w.hourly;
  if (h?.time && h.temperature_2m) {
    // Past hours only: FFSM's `age` is minutes AGO and cannot express the future, and a
    // forecast smuggled in as an age-0 reading would be a number that quietly lies.
    const rows: Array<{ ms: number; i: number }> = [];
    for (let i = 0; i < h.time.length; i++) {
      const ms = utcMs(h.time[i]);
      if (!Number.isNaN(ms) && ms <= now && ms < curMs && typeof h.temperature_2m[i] === "number") {
        rows.push({ ms, i });
      }
    }
    rows.sort((a, b) => a.ms - b.ms);
    for (const { ms, i } of rows.slice(-Math.max(0, hours))) {
      messages.push({
        fromMe: false,
        ageMin: Math.max(0, Math.round((now - ms) / 60000)),
        body: `${hhmm(h.time[i])} ${round(h.temperature_2m[i])}C`,
      });
    }
  }

  const wind = typeof cur.wind_speed_10m === "number" ? ` w${round(cur.wind_speed_10m)}` : "";
  const code = typeof cur.weather_code === "number" ? ` ${describeWmo(cur.weather_code)}` : "";
  messages.push({
    fromMe: false,
    ageMin: Math.max(0, Math.round((now - curMs) / 60000)),
    body: `${round(cur.temperature_2m)}C${code}${wind}`,
  });

  return [{ name: place.name, unread: true, messages }];
}

/** The `DataSource` the pump polls. */
export function weatherSource(opts: WeatherSourceOptions): DataSource {
  const { place, fetchJson } = opts;
  return {
    id: `weather:${place.name}`,
    appId: opts.appId ?? 3,
    everyMs: opts.everyMs ?? 15 * 60_000,
    async fetch(now: number): Promise<Uint8Array> {
      const json = await fetchJson(openMeteoUrl(place));
      return encodeFfsm(weatherToThreads(json, now, place, opts.hours));
    },
  };
}
