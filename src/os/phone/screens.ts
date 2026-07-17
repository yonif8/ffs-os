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

// ---- Animations (NATIVE firmware animation via the even_ai session) --------

const animations = list("animations", "Animations", [
  { label: "Even-AI swirl: START", hint: "native", action: () => FfsBle.showAiSwirl(true) },
  { label: "Even-AI swirl: STOP", hint: "", action: () => FfsBle.showAiSwirl(false) },
]);

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
  { label: "About", hint: ">", target: about },
  { label: "Bluetooth", hint: ">", target: bluetooth },
]);
