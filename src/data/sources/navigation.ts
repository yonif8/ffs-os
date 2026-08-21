// Navigation — turn-by-turn on the HUD, pulled out of the ongoing navigation NOTIFICATION with no
// Maps API key and no location permission beyond the notification grant we already hold.
//
// ── PROVENANCE (technique RE-DERIVED, not copied) ─────────────────────────────────────────────
// The *idea* — that a maps app publishes its live turn-by-turn as an ongoing notification whose
// title/text carry the instruction, distance, ETA and arrival, and that you can read navigation off
// that instead of any routing API — was observed in **appsbridge** (homeauto.cc/appsbridge). That
// project ships with **NO licence (all rights reserved)**, so NONE of its code or regexes are used
// here. The package set below and the parsers are our own, authored against the observable shape of
// the notifications and independently written. appsbridge is a design reference only.
//
// ── WHY THIS IS JUST ANOTHER DataSource ───────────────────────────────────────────────────────
// A turn instruction is *named lines of short text*, so — like `weather`, `headlines` and `media` —
// it encodes as FFSM and the existing `messages` reader draws it. No new on-glass renderer.
//
// ⛔ PRIVACY. A destination or a street name is content. `fetch` is the only place it lives, for one
//    `encodeFfsm` call. Nothing here logs, stringifies or persists it; this module reports only
//    numbers about itself. `ffs_os` is PUBLIC.

import { encodeFfsm, type FfsmThread } from "../../sdk/ffsm";
import type { DataSource } from "../types";

/**
 * The maps apps whose ongoing notification we read. Kept small and explicit — the native scanner
 * only ever looks at these packages, so no other app's ongoing notification is even inspected.
 */
export const NAV_PACKAGES: readonly string[] = [
  "com.google.android.apps.maps",
  "com.waze",
  "net.osmand",
  "net.osmand.plus",
  "com.sygic.aura",
] as const;

export function isNavPackage(pkg: string): boolean {
  return NAV_PACKAGES.includes(pkg);
}

/** The raw ongoing nav notification, exactly as native scanned it. Strings, uninterpreted. */
export interface NavNotification {
  pkg: string;
  title: string;
  text: string;
  /** Some apps put the distance in a third line (EXTRA_SUB_TEXT / big-text). Optional. */
  sub?: string;
}

/** What we parsed out of it. Every field optional — a real notification rarely has them all. */
export interface NavInfo {
  active: boolean;
  pkg: string;
  instruction?: string;
  /** Normalised "500 m" / "1.2 km" / "300 ft" as the app wrote it (spacing tidied). */
  distance?: string;
  /** Clock ETA, e.g. "14:37" or "2:05 PM". */
  eta?: string;
  /** True when the notification signals the route is finished. */
  arrived?: boolean;
}

// ── re-derived parsers (authored here; see provenance note) ───────────────────────────────────

/**
 * Distance: a number (optionally decimal, comma or dot) followed by a distance unit. Written from
 * scratch — capture-grouped, case-insensitive, and covering the units these apps actually emit
 * (metric, imperial and yards). Returns the tidied "<value> <unit>" or undefined.
 */
const DISTANCE_RE = /(\d+(?:[.,]\d+)?)\s*(kilometou?res?|kilometers?|kilometres?|meters?|metres?|miles?|yards?|feet|foot|km|mi|yd|ft|m)\b/i;

/** Compact the matched distance unit to something that fits a 13-char line. */
const UNIT_SHORT: Record<string, string> = {
  kilometers: "km", kilometres: "km", kilometre: "km", kilometer: "km", kilometres_: "km",
  meters: "m", metres: "m", meter: "m", metre: "m",
  miles: "mi", mile: "mi",
  yards: "yd", yard: "yd",
  feet: "ft", foot: "ft",
  km: "km", mi: "mi", yd: "yd", ft: "ft", m: "m",
};

export function parseDistance(s: string): string | undefined {
  const m = DISTANCE_RE.exec(s);
  if (!m) return undefined;
  const value = m[1].replace(",", ".");
  const unit = UNIT_SHORT[m[2].toLowerCase()] ?? m[2].toLowerCase();
  return `${value} ${unit}`;
}

/** A clock ETA like 14:37 or 2:05 PM. Independently written. */
const ETA_RE = /\b(\d{1,2}:\d{2})\s*([AaPp][Mm])?\b/;

export function parseEta(s: string): string | undefined {
  const m = ETA_RE.exec(s);
  if (!m) return undefined;
  return m[2] ? `${m[1]} ${m[2].toUpperCase()}` : m[1];
}

/**
 * Words that mark a line as a maneuver instruction rather than a status chip ("syncing", "GPS
 * signal lost"). Our own list, matched as whole words, case-insensitive.
 */
const TURN_RE = /\b(turn|keep|exit|merge|ramp|roundabout|continue|straight|head|arrive|u[-\s]?turn|bear|slight|take|onto|toward|towards|follow|stay|left|right|north|south|east|west)\b/i;

/** Phrases that mean the route is over. Authored here. */
const ARRIVAL_RE = /\b(arrived|you have arrived|destination reached|route complete|navigation ended|you'?re here|reached your destination)\b/i;

export function looksLikeInstruction(s: string): boolean {
  return TURN_RE.test(s);
}

/**
 * Pull a clean instruction out of a line. Strips a leading "distance • instruction" prefix (the
 * bullet layout Google Maps uses) so the instruction is not doubled with the distance we already
 * parse separately. Returns undefined when the line carries no maneuver.
 */
const DISTANCE_INSTRUCTION_SPLIT = /^\s*\d+(?:[.,]\d+)?\s*(?:km|mi|yd|ft|m)\s*[•·*|\-–—]\s*(.+)$/i;

export function parseInstruction(title: string, text: string): string | undefined {
  for (const raw of [title, text]) {
    if (!raw) continue;
    const split = DISTANCE_INSTRUCTION_SPLIT.exec(raw);
    const candidate = (split ? split[1] : raw).trim();
    if (candidate && looksLikeInstruction(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Parse a raw nav notification (or its absence) into structured turn-by-turn. Pure — this is where
 * every extraction decision lives, and therefore where the tests point.
 *
 * A null notification, or one that carries no instruction / distance / ETA / arrival at all, is
 * `{ active: false }`: navigation is not on, and the source will decline to push rather than paint
 * a stale or empty direction on the HUD.
 */
export function parseNav(raw: NavNotification | null): NavInfo {
  if (!raw || !isNavPackage(raw.pkg)) return { active: false, pkg: raw?.pkg ?? "" };
  const blob = [raw.title, raw.text, raw.sub ?? ""].join("\n");

  const arrived = ARRIVAL_RE.test(blob);
  const instruction = parseInstruction(raw.title, [raw.text, raw.sub ?? ""].join("\n"));
  const distance = parseDistance(blob);
  const eta = parseEta(blob);

  const active = arrived || !!instruction || !!distance || !!eta;
  return { active, pkg: raw.pkg, instruction, distance, eta, arrived: arrived || undefined };
}

// ---------------------------------------------------------------- encoding

const NAV_LABEL: Record<string, string> = {
  "com.google.android.apps.maps": "Maps",
  "com.waze": "Waze",
  "net.osmand": "OsmAnd",
  "net.osmand.plus": "OsmAnd",
  "com.sygic.aura": "Sygic",
};

/**
 * Turn parsed navigation into the FFSM thread the glasses draw. Messages are OLDEST-first and the
 * app opens at the LAST line, so the instruction — the thing you steer by — goes last.
 *
 * Throws when navigation is not active: an inactive nav screen is not a screen, and pushing one
 * would replace whatever the glasses hold. ⛔ The message names no place.
 */
export function navToThreads(info: NavInfo): FfsmThread[] {
  if (!info.active) throw new Error("navigation: not active");

  const messages: FfsmThread["messages"] = [];
  if (info.arrived) {
    messages.push({ fromMe: false, ageMin: 0, body: "arrived" });
  } else {
    if (info.eta) messages.push({ fromMe: false, ageMin: 0, body: `ETA ${info.eta}` });
    if (info.distance) messages.push({ fromMe: false, ageMin: 0, body: info.distance });
    messages.push({ fromMe: false, ageMin: 0, body: info.instruction || "continue" });
  }

  const name = NAV_LABEL[info.pkg] ?? "Nav";
  return [{ name, unread: false, messages }];
}

export interface NavigationSourceOptions {
  /**
   * Injected so every branch runs on a PC with no phone. In the app this is `readNav` from
   * `src/notifications/native.ts`, which calls the native `NavScanner` (a filtered
   * getActiveNotifications on the nav packages).
   */
  read: () => NavNotification | null;
  /** Which on-glass app renders it. Distinct from messages(3) and media(4). */
  appId?: number;
  /** ~2 s: maps updates its notification in place, so re-scanning beats trusting the post callback. */
  everyMs?: number;
  enabled?: () => boolean;
}

/** The `DataSource` the pump polls. */
export function navigationSource(opts: NavigationSourceOptions): DataSource {
  const { read } = opts;
  const enabled = opts.enabled;
  return {
    id: "navigation",
    appId: opts.appId ?? 5,
    everyMs: opts.everyMs ?? 2_000,
    async fetch(): Promise<Uint8Array> {
      if (enabled && !enabled()) throw new Error("navigation: listener not enabled");
      return encodeFfsm(navToThreads(parseNav(read())));
    },
  };
}
