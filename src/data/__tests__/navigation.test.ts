// Navigation, as tests. What is checked is the PARSING — the place a nav feed can be silently
// wrong on a HUD — driven from notification shapes these apps actually post, plus the property
// that matters for the transport: whatever the notification says, the blob fits the channel.
//
// ⛔ Every place name / instruction here is INVENTED. `ffs_os` is PUBLIC.

import { describe, expect, it } from "bun:test";

import { DataPump } from "../pump";
import {
  NAV_PACKAGES,
  type NavNotification,
  isNavPackage,
  navToThreads,
  navigationSource,
  parseDistance,
  parseEta,
  parseInstruction,
  parseNav,
} from "../sources/navigation";
import { decodeFfsm } from "../../sdk/ffsm";
import { decodeFfsc } from "../../sdk/ffsc";
import type { DataEvent } from "../types";

const MAPS = "com.google.android.apps.maps";

describe("parseDistance", () => {
  it("reads metric and imperial with decimals and commas, and compacts the unit", () => {
    expect(parseDistance("500 m")).toBe("500 m");
    expect(parseDistance("1.2 km")).toBe("1.2 km");
    expect(parseDistance("1,2 km")).toBe("1.2 km"); // European decimal comma
    expect(parseDistance("300 ft")).toBe("300 ft");
    expect(parseDistance("0.4 miles")).toBe("0.4 mi");
    expect(parseDistance("250 meters")).toBe("250 m");
    expect(parseDistance("80 yards")).toBe("80 yd");
  });

  it("returns undefined when there is no distance", () => {
    expect(parseDistance("Turn right")).toBeUndefined();
  });
});

describe("parseEta", () => {
  it("reads a 24h or 12h clock", () => {
    expect(parseEta("Arriving 14:37")).toBe("14:37");
    expect(parseEta("ETA 2:05 pm")).toBe("2:05 PM");
  });
  it("returns undefined with no clock", () => {
    expect(parseEta("500 m")).toBeUndefined();
  });
});

describe("parseInstruction", () => {
  it("keeps a maneuver line and rejects a status chip", () => {
    expect(parseInstruction("Turn right onto Elm Street", "")).toBe("Turn right onto Elm Street");
    expect(parseInstruction("Syncing offline maps", "")).toBeUndefined();
  });

  it("strips a leading 'distance • instruction' prefix so distance is not doubled", () => {
    expect(parseInstruction("500 m • Keep left onto A40", "")).toBe("Keep left onto A40");
  });

  it("falls back to the text line when the title is not the instruction", () => {
    expect(parseInstruction("13 min", "Continue straight")).toBe("Continue straight");
  });
});

describe("parseNav", () => {
  it("extracts instruction, distance and ETA from a Maps-shaped notification", () => {
    const info = parseNav({ pkg: MAPS, title: "Turn left onto High St", text: "200 m", sub: "ETA 14:37" });
    expect(info.active).toBe(true);
    expect(info.instruction).toBe("Turn left onto High St");
    expect(info.distance).toBe("200 m");
    expect(info.eta).toBe("14:37");
    expect(info.arrived).toBeUndefined();
  });

  it("detects arrival", () => {
    const info = parseNav({ pkg: "com.waze", title: "You have arrived", text: "" });
    expect(info.active).toBe(true);
    expect(info.arrived).toBe(true);
  });

  it("is inactive for a null notification or a non-nav package", () => {
    expect(parseNav(null).active).toBe(false);
    expect(parseNav({ pkg: "com.whatsapp", title: "Turn right", text: "500 m" }).active).toBe(false);
  });

  it("is inactive when a nav app posts a notification with no turn data", () => {
    expect(parseNav({ pkg: MAPS, title: "Google Maps", text: "Tap to resume" }).active).toBe(false);
  });

  it("covers every declared nav package", () => {
    for (const pkg of NAV_PACKAGES) expect(isNavPackage(pkg)).toBe(true);
    expect(isNavPackage("com.example")).toBe(false);
  });
});

describe("navToThreads", () => {
  it("puts the INSTRUCTION last, where the app opens the thread", () => {
    const [t] = navToThreads(parseNav({ pkg: MAPS, title: "Turn left onto High St", text: "200 m", sub: "14:37" }));
    const last = t.messages[t.messages.length - 1];
    expect(last.body).toBe("Turn left onto High St");
    expect(t.messages.some((m) => m.body === "200 m")).toBe(true);
    expect(t.messages.some((m) => m.body === "ETA 14:37")).toBe(true);
  });

  it("shows a single 'arrived' line at the end of the route", () => {
    const [t] = navToThreads(parseNav({ pkg: MAPS, title: "You have arrived", text: "" }));
    expect(t.messages.map((m) => m.body)).toEqual(["arrived"]);
  });

  it("throws when navigation is not active", () => {
    expect(() => navToThreads(parseNav(null))).toThrow(/not active/);
  });
});

describe("navigationSource end to end", () => {
  it("re-scans on a ~2s cadence and produces a blob the channel accepts", async () => {
    let raw: NavNotification | null = { pkg: MAPS, title: "Continue straight", text: "1.2 km", sub: "ETA 09:15" };
    const src = navigationSource({ read: () => raw });
    expect(src.everyMs).toBe(2_000);
    const w = { sent: [] as Uint8Array[], events: [] as DataEvent[] };
    const p = new DataPump({
      sources: [src],
      send: async (f) => void w.sent.push(f),
      linkUp: () => true,
      now: () => 0,
      log: (ev) => w.events.push(ev),
    });
    await p.tick();
    expect(w.sent.length).toBe(1);
    const threads = decodeFfsm(decodeFfsc(w.sent[0].slice(12)).blob);
    expect(threads[0].messages[threads[0].messages.length - 1].body).toBe("Continue straight");
    expect(src.appId).toBe(5);
  });

  it("declines to push when navigation is off", async () => {
    const src = navigationSource({ read: () => null });
    const w = { sent: [] as Uint8Array[], events: [] as DataEvent[] };
    const p = new DataPump({
      sources: [src],
      send: async (f) => void w.sent.push(f),
      linkUp: () => true,
      now: () => 0,
      log: (ev) => w.events.push(ev),
    });
    await p.tick();
    expect(w.sent.length).toBe(0);
    expect(w.events.some((e) => e.kind === "fetch-failed")).toBe(true);
  });

  it("is disabled cleanly when the listener is not granted", async () => {
    const src = navigationSource({ read: () => ({ pkg: MAPS, title: "Turn right", text: "50 m" }), enabled: () => false });
    await expect(src.fetch(0)).rejects.toThrow(/not enabled/);
  });
});

describe("privacy", () => {
  it("NO place / instruction reaches any event or telemetry record", async () => {
    const PLACE = "ZZ-NAV-PLACE-8b17-DO-NOT-LEAK";
    const src = navigationSource({ read: () => ({ pkg: MAPS, title: `Turn left onto ${PLACE}`, text: "50 m" }) });
    const w = { sent: [] as Uint8Array[], events: [] as DataEvent[] };
    const p = new DataPump({
      sources: [src],
      send: async (f) => void w.sent.push(f),
      linkUp: () => true,
      now: () => 0,
      log: (ev) => w.events.push(ev),
    });
    await p.tick();
    expect(w.sent.length).toBeGreaterThan(0);
    const spilled = JSON.stringify([w.events, p.stats]);
    expect(spilled).not.toContain(PLACE);
    expect(spilled).not.toContain("NAV-PLACE");
  });
});
