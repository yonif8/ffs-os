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

// ---- Dashboard (Even's REAL native dashboard, brought in — FUT-170) --------
// Yoni's actual ask: bring EVEN'S gorgeous firmware-rendered dashboard INTO our OS — not a
// text clone. Opening this releases our EvenHub page (kind "stockdash" → showStockDashboard)
// so the firmware's native LVGL dashboard surfaces on look-up (re-enables head-up + applies
// our widget layout over BLE, no firmware patch). Any gesture repaints our OS (the way back).

const dashboard: Screen = { id: "dashboard", title: "Dashboard", kind: "stockdash" };

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

// ---- Home (the 5 real apps) -----------------------------------------------

export const homeScreen: Screen = list("home", "Home", [
  { label: "Animations", hint: ">", target: animations },
  { label: "Clock", hint: ">", target: clock },
  { label: "Image Test", hint: ">", target: image("imgtest", "Image Test") },
  { label: "Dashboard", hint: ">", target: dashboard },
  { label: "About", hint: ">", target: about },
  { label: "Bluetooth", hint: ">", target: bluetooth },
  // FUT-170: push custom CONTENT into Even's dashboard (Schedule widget) over BLE — proves
  // we drive the dashboard protocol. The "Dashboard" item above surfaces the real UI itself.
  { label: "Push to stock dash", hint: "BLE", action: () => FfsBle.pushDashboardDemo("Hello from FFS OS") },
]);
