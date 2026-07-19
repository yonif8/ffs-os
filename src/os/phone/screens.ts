// FFS Glasses OS — on-glass screen tree (FUT-165).
//
// Stripped to ONLY things that genuinely work on the hardware (Yoni steer, 2026-07-17):
//   Animations · Clock · Image Test · About/Device · Bluetooth.
// No mock/fake apps. Rendered on the HUD, driven by touchpad gestures (see nav.ts).
// ASCII-safe (the G2 LVGL font has partial unicode coverage).
//
// "Animations" drives the firmware's NATIVE "Even AI" swirl (GPU-smooth, dual-lens) via
// FfsBle.showAiSwirl — no pixel streaming. Image Test uses the raw-image path (showImage).

import FfsBle from "../../../modules/ffs-ble";
import type { Screen, MenuItem, PhoneCtx } from "./nav";

// ---- tiny builders --------------------------------------------------------

const text = (id: string, title: string, body: (ctx: PhoneCtx) => string[]): Screen => ({
  id,
  title,
  kind: "text",
  body,
});

const list = (id: string, title: string, items: MenuItem[]): Screen => ({
  id,
  title,
  kind: "list",
  items,
});

const image = (id: string, title: string): Screen => ({ id, title, kind: "image" });

/** An on-glass pixel animation screen (FUT-165) — opening it streams CFW mode-2 frames;
 *  double-tap (back) stops it. */
const anim = (animId: string, title: string): Screen => ({
  id: `anim-${animId}`,
  title,
  kind: "anim",
  animId,
});

// ---- Animations (CFW pixel-frame demos + the native even_ai swirl) ---------
// Tap a demo to play it full-canvas on the HUD; double-tap to stop + go back (FUT-165).

const animations = list("animations", "Animations", [
  { label: "Full-canvas image", hint: ">", target: anim("image", "Image") },
  { label: "Bouncing ball", hint: ">", target: anim("ball", "Bouncing ball") },
  { label: "Spinner", hint: ">", target: anim("spinner", "Spinner") },
  { label: "Expanding rings", hint: ">", target: anim("rings", "Expanding rings") },
  { label: "Plasma", hint: ">", target: anim("plasma", "Plasma") },
  { label: "Starfield", hint: ">", target: anim("starfield", "Starfield") },
  { label: "Marquee text", hint: ">", target: anim("marquee", "Marquee") },
  { label: "Video demo (loop)", hint: ">", target: anim("video", "Video demo") },
  { label: "Even-AI swirl: START", hint: "native", action: () => FfsBle.showAiSwirl(true) },
  { label: "Even-AI swirl: STOP", hint: "", action: () => FfsBle.showAiSwirl(false) },
]);

// ---- Dashboard (OUR own dashboard, our pixels — FUT-176) -------------------
// NOTE (FUT-194, native-first pivot): the old pixel dashboard (kind "ffsdash", mode-2
// tileview) and the bare "release page" stock dash (kind "stockdash") are RETIRED from the
// menu. App #1 is now the NATIVE dashboard below (`nativeDashboard`, kind "nativedash") —
// the firmware renders it, we drive layout + content over BLE. The ffsdash/stockdash kinds
// remain supported in nav.ts as the pixel fallback, just not surfaced here.

// ---- Clock (real live time) -----------------------------------------------

const clock = text("clock", "Clock", () => {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return ["", `     ${time}`, `     ${date}`];
});

// ---- About / Device info (real link state) --------------------------------

const about = text("about", "About", (ctx) => {
  const s = ctx.sides();
  return [
    `FFS Glasses OS ${ctx.version()}`,
    `Link: L ${s.L ? "ok" : "--"}  R ${s.R ? "ok" : "--"}  pair ${ctx.pairReady() ? "ready" : "--"}`,
    `Gestures: ${ctx.gestures()}`,
    "Driver: ffs-ble (our own)",
    "Mentra: gone",
  ];
});

// ---- Bluetooth / connection status (real) ---------------------------------

const bluetooth = text("bt", "Bluetooth", (ctx) => {
  const s = ctx.sides();
  return [
    "Even G2",
    ctx.pairReady() ? "Connected" : "Not connected",
    "",
    `L ${s.L ? "up" : "--"}   R ${s.R ? "up" : "--"}`,
  ];
});

// ---- Dashboard — App #1, NATIVE-FIRST (FUT-194) ---------------------------
// The firmware renders its OWN dashboard (clock/battery + widgets, GPU-smooth, low-power);
// our OS just DRIVES it over BLE — widget layout + 12/24h + °C/°F + our Schedule events. No
// pixels streamed. Replaces the old pixel dashboard (FUT-176). Look up on the glasses to see
// it; any gesture returns to our OS. Schedule content is sample data for v1 (phone-calendar
// wiring is a follow-up).
function nativeDashConfig(): string {
  const tz = -new Date().getTimezoneOffset() * 60; // seconds east of UTC
  // Build events relative to NOW so they're always upcoming (v1 sample data — real phone
  // calendar wiring is the follow-up). endTs is a wall-clock unix + tz shift (Even's format).
  const ev = (id: number, title: string, location: string, inMin: number, lenMin: number) => {
    const start = new Date(Date.now() + inMin * 60_000);
    const end = new Date(Date.now() + (inMin + lenMin) * 60_000);
    const h = start.getHours(), m = start.getMinutes();
    const time = `${((h + 11) % 12) + 1}:${m.toString().padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    return { id, title, location, time, endTs: Math.floor(end.getTime() / 1000) + tz };
  };
  return JSON.stringify({
    halfDay: true, // 12h
    celsius: true, // °C
    widgetOrder: [3, 1, 2, 4, 5], // Schedule, News, Stock, Quicklist, Health
    schedule: [
      ev(1, "Standup", "Zoom", 30, 30),
      ev(2, "Design review", "Office", 120, 60),
      ev(3, "Supplier call", "Phone", 240, 30),
      ev(4, "Gym", "", 360, 60),
    ],
  });
}

const nativeDashboard: Screen = { id: "dashboard", title: "Dashboard", kind: "nativedash", dashConfig: nativeDashConfig };

// ---- Text test (FUT-191) --------------------------------------------------
// A long, scrollable text surface: paste a story (English + Hebrew) in the phone app, it
// renders on the HUD through the firmware's normal label path — English via the bitmap
// font, Hebrew via our FreeType fallback — so we can feel whether FreeType scrolling lags
// vs bitmap. Swipe up/down on the glasses scrolls; double-tap exits. Phone-side only, no
// firmware flash. Word-wrap is a fixed-width approximation (the HUD font is proportional).

const TEXT_WRAP = 46; // approx chars per HUD line at the default size

let textTestLines: string[] = [
  "No text yet.",
  "In the phone app, paste a long",
  "story (English + Hebrew) and tap",
  "Send to glasses. Then swipe up/",
  "down here to scroll it.",
];

/** Word-wrap raw multi-line text into fixed-width display lines for the HUD reader. */
export function setTextTestContent(raw: string): void {
  const out: string[] = [];
  for (const para of raw.replace(/\r/g, "").split("\n")) {
    if (para.trim() === "") { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      let w = word;
      // hard-break a single word longer than the wrap width
      while (w.length > TEXT_WRAP) {
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, TEXT_WRAP));
        w = w.slice(TEXT_WRAP);
      }
      if (!line) line = w;
      else if ((line + " " + w).length <= TEXT_WRAP) line += " " + w;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  textTestLines = out.length ? out : ["(empty)"];
}

export const textTestScreen: Screen = {
  id: "texttest",
  title: "Text test",
  kind: "textscroll",
  scrollLines: () => textTestLines,
};

// ---- Home (the 5 real apps) -----------------------------------------------

export const homeScreen: Screen = list("home", "Home", [
  { label: "Animations", hint: ">", target: animations },
  { label: "Clock", hint: ">", target: clock },
  { label: "Image Test", hint: ">", target: image("imgtest", "Image Test") },
  { label: "Text test", hint: ">", target: textTestScreen },
  { label: "Dashboard", hint: ">", target: nativeDashboard },
  { label: "About", hint: ">", target: about },
  { label: "Bluetooth", hint: ">", target: bluetooth },
  // FUT-170: push custom CONTENT into Even's dashboard (Schedule widget) over BLE — proves
  // we drive the dashboard protocol. The "Even Native Dash" item above surfaces the real UI.
  { label: "Push to stock dash", hint: "BLE", action: () => FfsBle.pushDashboardDemo("Hello from FFS OS") },
]);
