// The two sources, offline. What is being checked is the PARSING and the WORDING — the two
// places a live feed can be silently wrong on a HUD — plus the property that matters most
// for the transport: whatever the network says, the blob fits the channel.

import { describe, expect, it } from "bun:test";
import { decodeFfsm } from "../../sdk/ffsm";
import { FFSC_MAX_BLOB } from "../../sdk/ffsc";
import { describeWmo, openMeteoUrl, weatherSource, weatherToThreads } from "../sources/weather";
import { HN_TOP, headlinesSource, hnItem, storiesToThreads } from "../sources/headlines";

const HOME = { name: "London", latitude: 51.5072, longitude: -0.1276 };

// A real-shaped Open-Meteo response. `now` is 2026-08-20T14:07Z.
const NOW = Date.parse("2026-08-20T14:07:00Z");
const METEO = {
  current: { time: "2026-08-20T14:00", temperature_2m: 21.4, weather_code: 3, wind_speed_10m: 9.2 },
  hourly: {
    time: [
      "2026-08-20T10:00",
      "2026-08-20T11:00",
      "2026-08-20T12:00",
      "2026-08-20T13:00",
      "2026-08-20T14:00",
      "2026-08-20T15:00", // the FUTURE — must not appear
    ],
    temperature_2m: [17.1, 18.6, 19.9, 20.8, 21.4, 22.0],
    weather_code: [1, 2, 2, 3, 3, 3],
  },
};

describe("weather", () => {
  it("asks for UTC and no location permission — the place is a config value", () => {
    const url = openMeteoUrl(HOME);
    expect(url).toContain("timezone=UTC");
    expect(url).toContain("latitude=51.5072");
    expect(url.startsWith("https://")).toBe(true);
    expect(url).not.toContain("key");
    expect(url).not.toContain("token");
  });

  it("puts the CURRENT reading last, where the app opens the thread", () => {
    const [t] = weatherToThreads(METEO, NOW, HOME);
    expect(t.name).toBe("London");
    const newest = t.messages[t.messages.length - 1];
    expect(newest.body).toBe("21C overcast w9");
    expect(newest.ageMin).toBe(7); // 14:00 reading, 14:07 now
  });

  it("never encodes a future hour as an age-0 reading", () => {
    const [t] = weatherToThreads(METEO, NOW, HOME);
    const bodies = t.messages.map((m) => m.body);
    expect(bodies.some((b) => b.startsWith("15:00"))).toBe(false);
    expect(bodies).toContain("13:00 21C");
    expect(t.messages.every((m) => m.ageMin >= 0)).toBe(true);
  });

  it("ages the past hours from their own timestamps", () => {
    const [t] = weatherToThreads(METEO, NOW, HOME);
    const tenAm = t.messages.find((m) => m.body.startsWith("10:00"));
    expect(tenAm?.ageMin).toBe(4 * 60 + 7);
  });

  it("parses the stamp as UTC, not as the phone's local time", () => {
    // If `utcMs` guessed local, this age would be off by the runner's offset — which on this
    // Windows box is +0, so the test forces the point with an explicit far-away instant.
    const [t] = weatherToThreads(
      { current: { time: "2026-08-20T00:00", temperature_2m: 5 } },
      Date.parse("2026-08-20T02:00:00Z"),
      HOME
    );
    expect(t.messages[0].ageMin).toBe(120);
  });

  it("THROWS on a response with no current reading, rather than rendering an empty screen", () => {
    expect(() => weatherToThreads({}, NOW, HOME)).toThrow(/no current reading/);
    expect(() => weatherToThreads({ current: { time: "x" } }, NOW, HOME)).toThrow(/no current reading/);
    expect(() =>
      weatherToThreads({ current: { time: "not-a-date", temperature_2m: 1 } }, NOW, HOME)
    ).toThrow(/unparseable/);
  });

  it("survives a response with no hourly block at all", () => {
    const [t] = weatherToThreads({ current: { time: "2026-08-20T14:00", temperature_2m: 21 } }, NOW, HOME);
    expect(t.messages.length).toBe(1);
    expect(t.messages[0].body).toBe("21C");
  });

  it("names the WMO codes it knows and admits the ones it does not", () => {
    expect(describeWmo(0)).toBe("clear");
    expect(describeWmo(95)).toBe("storm");
    expect(describeWmo(1234)).toBe("?"); // visible, never blank
  });

  it("produces a blob the channel accepts", async () => {
    const src = weatherSource({ place: HOME, fetchJson: async () => METEO });
    const blob = await src.fetch(NOW);
    expect(blob.length).toBeLessThanOrEqual(FFSC_MAX_BLOB);
    const back = decodeFfsm(blob);
    expect(back[0].name).toBe("London");
    expect(back[0].messages[back[0].messages.length - 1].body).toBe("21C overcast w9");
    expect(src.appId).toBe(3);
  });

  it("lets the failure out instead of swallowing it", async () => {
    const src = weatherSource({
      place: HOME,
      fetchJson: async () => {
        throw new Error("HTTP 503");
      },
    });
    await expect(src.fetch(NOW)).rejects.toThrow(/503/);
  });
});

// ── headlines ────────────────────────────────────────────────────────────────────────
const STORIES = [
  { title: "Rust 2.0 announced", time: Math.floor(NOW / 1000) - 600, score: 431 },
  { title: "A tiny LVGL port", time: Math.floor(NOW / 1000) - 3600, score: 88 },
  { title: "Show HN: my glasses", time: Math.floor(NOW / 1000) - 7200, score: 12 },
];

describe("headlines", () => {
  it("★ puts the #1 story LAST, so tapping in opens the top story", () => {
    const [t] = storiesToThreads(STORIES, NOW);
    expect(t.name).toBe("HN");
    expect(t.messages[t.messages.length - 1].body).toBe("431 Rust 2.0 announced");
    expect(t.messages[0].body).toBe("12 Show HN: my glasses");
  });

  it("ages each story from its own unix timestamp", () => {
    const [t] = storiesToThreads(STORIES, NOW);
    expect(t.messages[t.messages.length - 1].ageMin).toBe(10);
    expect(t.messages[0].ageMin).toBe(120);
  });

  it("throws on a response with nothing usable in it", () => {
    expect(() => storiesToThreads([], NOW)).toThrow(/no usable stories/);
    expect(() => storiesToThreads([{ title: "", time: 0 }], NOW)).toThrow(/no usable stories/);
  });

  it("fetches the id list once and then one item each", async () => {
    const seen: string[] = [];
    const src = headlinesSource({
      count: 3,
      fetchJson: async (url) => {
        seen.push(url);
        if (url === HN_TOP) return [11, 22, 33, 44, 55];
        return STORIES[seen.length - 2];
      },
    });
    const blob = await src.fetch(NOW);
    expect(seen[0]).toBe(HN_TOP);
    expect(seen.slice(1)).toEqual([hnItem(11), hnItem(22), hnItem(33)]);
    expect(blob.length).toBeLessThanOrEqual(FFSC_MAX_BLOB);
    expect(decodeFfsm(blob)[0].messages.length).toBe(3);
  });

  it("★ one dead item does not lose the others", async () => {
    let n = 0;
    const src = headlinesSource({
      count: 3,
      fetchJson: async (url) => {
        if (url === HN_TOP) return [11, 22, 33];
        n += 1;
        if (n === 2) throw new Error("HTTP 404");
        return STORIES[n - 1];
      },
    });
    expect(decodeFfsm(await src.fetch(NOW))[0].messages.length).toBe(2);
  });

  it("refuses a topstories response that is not a list", async () => {
    const src = headlinesSource({ fetchJson: async () => ({ oops: true }) });
    await expect(src.fetch(NOW)).rejects.toThrow(/did not return a list/);
  });

  it("stays inside the channel cap even with 12 long headlines", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `${i} ${"a headline that goes on and on and on".repeat(3)}`,
      time: Math.floor(NOW / 1000) - i * 60,
      score: 100 + i,
    }));
    const src = headlinesSource({
      count: 12,
      fetchJson: async (url) => (url === HN_TOP ? many.map((_, i) => i) : many[0]),
    });
    const blob = await src.fetch(NOW);
    expect(blob.length).toBeLessThanOrEqual(FFSC_MAX_BLOB);
  });
});
