// FFS Glasses OS — the on-glass phone-OS screen tree (FUT-163).
//
// A deliberately stock-phone-shaped hierarchy of screens rendered on the HUD and driven by
// touchpad gestures (see nav.ts). Lots of little "apps" so the whole thing feels like a real
// phone AND exercises the driver end-to-end: every screen is a showText render, the Camera
// screen fires the P4 raw-image path, and navigating them all is the gesture test.
//
// Kept ASCII-safe on purpose — the G2 LVGL font's unicode/emoji coverage is partial, so we
// stick to plain characters (a couple of guillemets/carets that render fine) rather than
// risk blank glyphs on hardware.

import FfsBle from "../../../modules/ffs-ble";
import type { Screen, MenuItem, PhoneCtx } from "./nav";

// ---- tiny builders --------------------------------------------------------

const text = (id: string, title: string, body: (ctx: PhoneCtx) => string[]): Screen => ({
  id,
  title,
  kind: "text",
  body,
});

const staticText = (id: string, title: string, lines: string[]): Screen =>
  text(id, title, () => lines);

const list = (id: string, title: string, items: MenuItem[]): Screen => ({
  id,
  title,
  kind: "list",
  items,
});

const image = (id: string, title: string): Screen => ({ id, title, kind: "image" });

// ---- Phone ----------------------------------------------------------------

const contactCard = (name: string, number: string, note: string): Screen =>
  staticText(`contact-${name}`, name, [name, number, "", note]);

const contacts = list("contacts", "Contacts", [
  { label: "Yoni", hint: ">", target: contactCard("Yoni", "+972 50-000-0001", "Founder") },
  { label: "Tal", hint: ">", target: contactCard("Tal", "+972 50-000-0002", "Founder") },
  { label: "Mom", hint: ">", target: contactCard("Mom", "+1 555-0100", "Favourite") },
  { label: "KJ (bot)", hint: ">", target: contactCard("KJ", "—", "Fleet manager") },
  { label: "Bank", hint: ">", target: contactCard("Bank", "+1 800-555-0199", "Do not answer") },
]);

const phone = list("phone", "Phone", [
  {
    label: "Recents",
    hint: ">",
    target: staticText("recents", "Recents", [
      "Yoni        9:41  in",
      "Tal         9:12  out",
      "Mom         8:03  miss",
      "Bank        7:55  miss",
    ]),
  },
  { label: "Contacts", hint: ">", target: contacts },
  { label: "Keypad", hint: ">", target: staticText("keypad", "Keypad", ["1 2 3", "4 5 6", "7 8 9", "* 0 #"]) },
  { label: "Voicemail", hint: "2", target: staticText("vmail", "Voicemail", ["Mom  0:14", "Bank 0:32"]) },
]);

// ---- Messages -------------------------------------------------------------

const thread = (who: string, msgs: string[]): Screen => staticText(`msg-${who}`, who, msgs);

const messages = list("messages", "Messages", [
  {
    label: "Yoni",
    hint: ">",
    target: thread("Yoni", ["Yoni: ship it", "You: on it", "Yoni: nice", "You: green + deployed"]),
  },
  { label: "Tal", hint: ">", target: thread("Tal", ["Tal: how's the OS", "You: gestures work", "Tal: lets gooo"]) },
  { label: "Mom", hint: ">", target: thread("Mom", ["Mom: call me", "You: soon!"]) },
  { label: "Bank", hint: ">", target: thread("Bank", ["Bank: your code is 000000", "(do not share)"]) },
  { label: "KJ", hint: ">", target: thread("KJ", ["KJ: task FUT-163", "You: phase 1 done"]) },
]);

// ---- Clock ----------------------------------------------------------------

const clockNow = text("clock-now", "Clock", (_ctx) => {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return ["", `     ${time}`, `     ${date}`];
});

const clock = list("clock", "Clock", [
  { label: "Now", hint: ">", target: clockNow },
  { label: "Alarms", hint: "2", target: staticText("alarms", "Alarms", ["07:00  weekdays  On", "09:30  weekend  Off"]) },
  { label: "Stopwatch", hint: ">", target: staticText("stopwatch", "Stopwatch", ["  00:00.00", "", "tap start (mock)"]) },
  { label: "Timer", hint: ">", target: staticText("timer", "Timer", ["  05:00", "", "tap start (mock)"]) },
  { label: "World Clock", hint: ">", target: staticText("world", "World Clock", ["Helsinki  now", "Tel Aviv  +1h", "New York  -7h"]) },
]);

// ---- Settings -------------------------------------------------------------

const display = list("display", "Display", [
  { label: "Brightness", hint: "70%", target: staticText("brightness", "Brightness", ["  [#######---]  70%"]) },
  { label: "Text Size", hint: "M", target: staticText("textsize", "Text Size", ["S   M   L", "    ^"]) },
  { label: "Wallpaper", hint: ">", target: staticText("wallpaper", "Wallpaper", ["Dark", "Green (default)", "Mono"]) },
  { label: "Auto-Lock", hint: "30s", target: staticText("autolock", "Auto-Lock", ["15s", "30s (on)", "60s", "Never"]) },
]);

const aboutScreen = (): Screen =>
  text("about", "About", (ctx) => {
    const s = ctx.sides();
    return [
      `FFS Glasses OS ${ctx.version()}`,
      `Link: L ${s.L ? "ok" : "--"}  R ${s.R ? "ok" : "--"}  pair ${ctx.pairReady() ? "ready" : "--"}`,
      `Gestures: ${ctx.gestures()}`,
      "Driver: ffs-ble (our own)",
      "Mentra: gone",
    ];
  });

const settings = list("settings", "Settings", [
  { label: "Bluetooth", hint: "On", target: text("bt", "Bluetooth", (ctx) => ["Even G2", ctx.pairReady() ? "Connected" : "Not connected", "", "L + R lenses"]) },
  { label: "Wi-Fi", hint: "Off", target: staticText("wifi", "Wi-Fi", ["Off", "", "(no radio on glasses)"]) },
  { label: "Display", hint: ">", target: display },
  { label: "Sounds", hint: ">", target: staticText("sounds", "Sounds", ["Ringtone  Radar", "Volume    ####------", "Haptics   On"]) },
  { label: "Battery", hint: "82%", target: text("battery", "Battery", (ctx) => [`  ${ctx.battery()}%`, "  [########--]", "Low Power Mode  Off"]) },
  { label: "General", hint: ">", target: staticText("general", "General", ["Software Update", "Date & Time", "Language", "Reset"]) },
  { label: "About", hint: ">", target: aboutScreen() },
]);

// ---- Misc apps ------------------------------------------------------------

const music = list("music", "Music", [
  {
    label: "Now Playing",
    hint: ">",
    target: staticText("nowplaying", "Now Playing", ["Get Lucky", "Daft Punk", "1:23 / 4:08", "[#####-----]"]),
  },
  { label: "Library", hint: ">", target: staticText("library", "Library", ["Songs   1,204", "Albums    138", "Artists    92"]) },
  { label: "Playlists", hint: ">", target: staticText("playlists", "Playlists", ["Focus", "Gym", "Late night", "Liked Songs"]) },
]);

const notes = list("notes", "Notes", [
  { label: "FUT-163 plan", hint: ">", target: staticText("note1", "FUT-163 plan", ["Port shell off mentra", "Build launcher", "Ship phone OS"]) },
  { label: "Groceries", hint: ">", target: staticText("note2", "Groceries", ["Coffee", "Oat milk", "Eggs"]) },
  { label: "Ideas", hint: ">", target: staticText("note3", "Ideas", ["G2 nav OS", "voice input", "notifications"]) },
]);

const files = list("files", "Files", [
  { label: "Documents", hint: "12", target: staticText("docs", "Documents", ["spec.md", "notes.txt", "budget.xlsx"]) },
  { label: "Downloads", hint: "4", target: staticText("dl", "Downloads", ["FFSGlassesOS.ipa", "g2_firmware.bin"]) },
  { label: "Photos", hint: ">", target: image("files-photo", "Photo") },
]);

// ---- Home -----------------------------------------------------------------

export const homeScreen: Screen = list("home", "Home", [
  { label: "Phone", hint: ">", target: phone },
  { label: "Messages", hint: "5", target: messages },
  { label: "Camera", hint: ">", target: image("camera", "Camera") },
  { label: "Photos", hint: ">", target: image("photos", "Photos") },
  { label: "Clock", hint: ">", target: clock },
  {
    label: "Weather",
    hint: ">",
    target: staticText("weather", "Weather", ["Helsinki", "  -3 C  Cloudy", "H: -1   L: -7", "Wind 12 km/h"]),
  },
  {
    label: "Calculator",
    hint: ">",
    target: staticText("calc", "Calculator", ["  123 x 456", "  = 56,088", "", "(display mock)"]),
  },
  { label: "Music", hint: ">", target: music },
  { label: "Notes", hint: "3", target: notes },
  {
    label: "Calendar",
    hint: ">",
    target: staticText("calendar", "Calendar", ["Today", "09:00 Standup", "14:00 G2 demo", "18:00 Gym"]),
  },
  { label: "Files", hint: ">", target: files },
  { label: "Settings", hint: ">", target: settings },
  {
    label: "About",
    hint: ">",
    target: aboutScreen(),
  },
]);

/** Handy for a phone-side "snap a photo" debug button. */
export function shutter(): void {
  FfsBle.showImage();
}
