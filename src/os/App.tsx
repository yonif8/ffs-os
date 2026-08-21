// FFS Glasses OS — launcher / home shell (FUT-163).
//
// The real app entry (index.ts points here). Our OWN stack end-to-end, NO @mentra:
//   useFfsBluetooth (driver session) → useConnectionSupervisor (health + reclaim-on-ready)
//   → PhoneNav (on-glass phone-OS navigation) → screenOwner (paints via FfsBle.showText/Image).
//
// The star is ON THE GLASSES: a stock-phone-style OS (status bar + app menu + nested
// screens) you drive entirely by touchpad — swipe up/down to move, tap to open, double-tap
// to go back. The phone screen here is just a connection dashboard + a couple of debug
// controls (Home / Back / snap a photo) — everything real happens on the HUD.
//
// FUT-220 UX pass — this is a DENSE single-page control surface ON PURPOSE (Yoni: "keep
// every probe/debug control visible, optimise for speed not safety"). Nothing is hidden
// behind a Developer section and no confirm ceremony was added. What changed is
// SCANNABILITY, so the right control is found and fired fast:
//   • status pinned outside the scroll — link state never scrolls away
//   • flash progress pinned + a real bar (was a 13px Menlo line during a ~5-min brick window)
//   • the nine near-identical green flash buttons became a data-driven row list with a
//     coloured badge per image, a plain-language name, and a WRITES / no-writes tag
// Patterns lifted from real shipped apps via the Mobbin MCP — see FUT-220 for the refs.

import { StatusBar } from "expo-status-bar";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import FfsBle, { toNavGesture } from "../../modules/ffs-ble";
import { theme } from "./theme";
import Constants from "expo-constants";
import CalibrationScreen from "./calibration/CalibrationScreen";
import { initLoggerCore, glog } from "./log";
import { useFfsBluetooth } from "./useFfsBluetooth";
import { useConnectionSupervisor, healthLabel, type ConnectionHealth } from "./connection";
import { screenOwner } from "./reclaim";
import { PhoneNav, type PhoneCtx } from "./phone/nav";
import { homeScreen, textTestScreen, setTextTestContent } from "./phone/screens";
import { Group, Progress, Row, SectionLabel, Tabs } from "./ui";
import { DashboardPanel } from "./dashboard";
import { DevTelemetryPanel } from "./devtools/DevTelemetryPanel";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { useNotificationBridge } from "../notifications/useNotificationBridge";
import { startListening as startFbShot } from "../sdk/fbshot";
import { attachOsCommandListener } from "./runtime";
import { usePushAck } from "./usePushAck";

// Read the REAL shipped version rather than a hand-maintained copy. A hardcoded
// "0.11.1" had drifted three releases behind app.json, so telemetry reported the
// wrong build — which is actively dangerous: reading a log and believing it came
// from a build it didn't come from sends every diagnosis in the wrong direction.
// (FUT-233, 2026-07-28: a log said 0.11.1 while 0.11.4 was installed.)
const APP_VERSION = (Constants.expoConfig?.version ?? "unknown") as string;

type TabKey = "link" | "drive" | "flash" | "log";

/**
 * Pull the CFW diagnostic blocks out of the firmware version string.
 *
 * The CFW appends them to the sid-0x09 device-info response as extension fields, and
 * `G2Protocol.parseDeviceInfo` folds them into `leftVersion` as `⟨NAME=…⟩` blocks so
 * they ride a string the UI already displayed. That was fine when it was one probe; it
 * is now four, and the composite is ~300 characters of hex in a row subtitle. Parsed
 * here so the HEADER can carry the three facts that decide whether an experiment is
 * even meaningful: is this CFW, which image extensions are live, and has the loader run.
 *
 * Every field is optional on purpose — stock firmware sends none of them, and a CFW
 * image built without one probe sends the rest. Absent must read as "not advertised",
 * never as a default that looks like a measurement.
 */
export function parseCfw(version: string | null | undefined): {
  fw: string;
  caps: string[];
  ramexec: string | null;
  loader: { gen: number; ran: number } | null;
} {
  const v = version ?? "";
  const block = (name: string) => {
    const m = v.match(new RegExp(`⟨${name}=?([^⟩]*)⟩`));
    return m ? m[1].trim() : null;
  };
  const capsRaw = block("CAPS");
  // "EVENCFW/1 img576 imgz …" — drop the magic+version, keep the feature tokens.
  const caps = capsRaw ? capsRaw.split(/\s+/).filter((t) => t && !t.startsWith("EVENCFW/")) : [];

  const rx = v.match(/⟨RAMEXEC \w+ (\w+)/);
  const ld = v.match(/⟨LOADER gen=(\d+) ran=(\d+)/);

  return {
    // The bare version is whatever precedes the first extension block.
    fw: v.split("⟨")[0].trim(),
    caps,
    ramexec: rx ? rx[1] : null,
    loader: ld ? { gen: Number(ld[1]), ran: Number(ld[2]) } : null,
  };
}

// FUT-167 Stage 2 — CFW + stock-restore images. NEVER bundled and NEVER public: these are
// Even's copyrighted image plus our patch, and this repo is public.
//
// ⛔ They used to be fetched from a public bucket, whose URLs this file then published in
// full. That bucket was open — a 4.4 MB firmware image answered HTTP 200 to anyone — so it
// was taken down on 2026-08-09 and the R2 objects made private. Do not reintroduce a public
// host here.
//
// The image is served from the DEV MACHINE at flash time instead, reached over the USB
// tunnel (`scripts/fw-serve.ps1` starts the server and the `adb reverse`). That is not a
// downgrade in safety: the URL was never trusted to begin with. Every flash runs the same
// gate chain — SHA match, EVENOTA parse, MRAM brick-guard, known-golden lookup — so a wrong
// or hostile file is refused whatever the URL. The SHA pins below are the real control.
//
// Point somewhere else by setting EXPO_PUBLIC_FW_BASE at build time.
const FW_BASE = process.env.EXPO_PUBLIC_FW_BASE ?? "http://127.0.0.1:8799/fw";
const CFW_URL = `${FW_BASE}/g2_2.2.6.10_cfw.bin`;

// FUT-269 on-glass telemetry: dev-only diagnostic panel (Carrier A/B, tag 0x7D). On in dev
// builds; force it in a release build with EXPO_PUBLIC_DEV_TELEMETRY=1.
const DEV_TELEMETRY = __DEV__ || process.env.EXPO_PUBLIC_DEV_TELEMETRY === "1";
const CFW_SHA = "5c1539fd39c599e6035f6a8ec0779ba687c250d342a24c21a39952fed6c56aa0";
const STOCK_URL = `${FW_BASE}/g2_2.2.6.10_stock.bin`;
const STOCK_SHA = "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa";
// FUT-167 canary — Even's EXACT stock 2.2.6.10 with ONLY the reported firmware-version
// string changed 2.2.6.10 → 2.2.6.77 (10 rodata literals, length-preserving, checksums
// recomputed; bootloader byte-identical, validate PASS). The safe FIRST real flash: if it
// boots, "Read battery + firmware version" shows 2.2.6.77 → the write→commit→reboot→readback
// loop is proven on-hardware, with a payload that is behaviorally stock. Restore Stock reverts.
const CANARY_URL = `${FW_BASE}/g2_2.2.6.10_canary.bin`;
const CANARY_SHA = "67759cd67ed7031d7b4c8a613b8b0fe9dc9bd51c11e82260c35f5bc807159b5e";
// FUT-188 "fontpeek" — the shipped CFW + one injected READ that appends the XIP font-slot-0
// header (127 B from 0x80100000) to the sid=0x09 device-info response. After flashing, tap
// "Read battery + firmware version" and the font header shows on the firmware-L version line
// as ⟨FONT0=…hex…⟩ → gives us the s200_font.bin format ground-truth for native Hebrew. Pure
// read, no new flash-write behavior; Restore Stock reverts. Same golden-vector safety gate.
const FONTPEEK_URL = `${FW_BASE}/g2_2.2.6.10_fontpeek.bin`;
const FONTPEEK_SHA = "70332b9822806a546e028ffb1b88b49a44593fe88236a3daa70866185acbb4f0";
// FUT-179 NATIVE HEBREW — staged flash (do these IN ORDER).
// Stage 1 (BIDI-ONLY, FUT-190): RTL reorder only, NO glyph changes. Flash this first and
// check normal English/Chinese text still renders correctly — it isolates the shared
// label-draw hook's blast radius before Hebrew is added. Hebrew won't appear yet.
const HEBREW_BIDI_URL = `${FW_BASE}/g2_2.2.6.10_bidi_only.bin`;
const HEBREW_BIDI_SHA = "33404e1977aa7d1abaeedfb34a64f1b81e470b6ea818a1d21f61a0187ca5be1c";
// Stage 2 (FULL, FUT-189+190): bidi + Hebrew glyphs (embedded TTF via the FreeType-cache
// requester hook). This is the one that renders Hebrew, correctly ordered, system-wide.
const HEBREW_FULL_URL = `${FW_BASE}/g2_2.2.6.10_hebrew_full.bin`;
const HEBREW_FULL_SHA = "45a481fc13b3cb864a9c6b63a4c428c248ab1f3a8ab770715b71965bad09ed5f";
// FUT-191 — Hebrew v2 + font probe: full-coverage Hebrew (gershayim/geresh/shekel/
// presentation forms; no niqqud) + a diagnostic that logs the scalable font names the
// firmware opens (read back via "Read battery + firmware version"). Supersedes the FULL
// build above. Flash this, browse the UI, then do the firmware-version read.
const HEBREW_PROBE_URL = `${FW_BASE}/g2_2.2.6.10_hebrew_probe.bin`;
const HEBREW_PROBE_SHA = "39ea04a2964c443a1434310d929d64cf22c24ef908255f0f8d07a4b01e72cbfd";
// FUT-197 — FFS UI probe (ALWAYS-ON): Hebrew-full CFW + our OWN native-LVGL element via CFW.
// A styled rounded box AUTO-SHOWS on the home HUD (no gesture) whose child label LIVE-TICKS
// an MM:SS counter (1 Hz, driven by a firmware lv_timer armed at boot). First on-glass proof
// that our own native UI renders + live-updates firmware-side with zero phone — the de-risk
// step before owning the idle screen (FUT-195 Phase B).
const FFSUI_URL = `${FW_BASE}/g2_2.2.6.10_ffsui.bin`;
const FFSUI_SHA = "3a673c966658216ecbb9397d65682e8131ea4465f8915c941250985f8368d8ce";
// FUT-214 — RAM-exec probe: the "flash-once, push-forever" de-risk build. After flashing,
// tap "Read battery + firmware version": the CFW runs a RAM-exec test and returns the result
// on the firmware-L line as ⟨RAMEXEC RX01 EXEC_OK ret=0x2A …⟩ (ret==0x2A => pushing native
// code into RAM and running it WORKS — green light for the resident OTA loader).
const RAMEXEC_URL = `${FW_BASE}/g2_2.2.6.10_ramexec.bin`;
const RAMEXEC_SHA = "913a7f28cc79957ed8a5991c7434d993583070fc3d369b6c6a9e1683fd6f3f86";
// FUT-216 — resident OTA loader ("flash-once, push-forever"). Flash ONCE (inert, no seize —
// glasses behave normally) then tap Push Payload A / B to change on-glass UI OVER THE AIR with
// NO reflash. Loader status shows on the device-info read as ⟨LOADER LD01 gen=… ret=0x…⟩.
const LOADER_URL = `${FW_BASE}/g2_2.2.6.10_loader.bin`;
// FUT-217: no gesture hooks (left touchpad); FUT-216: dispatch probe (logs service keys → svc[]).
const LOADER_SHA = "373bfe9aa3645f1cda5b0204df1db3516e16347f31dcc9a39846442022c43103";
// FUT-246 — the SAME loader rebased onto stock 2.2.7.14, which is what Yoni's glasses now run.
// Every pushed payload is built against THIS base; pushing at the
// 2.2.6.10 loader above would branch into unrelated code. Also carries the FUT-244 pair:
// loader body-CRC (a corrupt frame is refused as LD04 instead of being executed) and the
// ffs_ui_patch prop-id migration. ⚠️ The payload frame gained an 8-byte CRC header, so app
// and firmware MUST ship together — an old app against this loader is refused rej_code=4.
const LOADER_2_2_7_14_URL = `${FW_BASE}/g2_2.2.7.14_loader.bin`;
// ⚠️ BUMPED 2026-08-14 for the GIF + LD05-TELEMETRY loader (CI run 31837608620, clang-18).
// Same 16384 arena as the big-arena image below; the ONLY loader.c change over 47a337ef is
// the LD05 always-on telemetry block (Carrier B — Pool-A headroom + ffsp_vm_t state on every
// frame), which is additive: LD04's 68 bytes stay byte-identical at the same offsets. The GIF
// opcode (0x28) itself is NOT in the flashed image — it lives in the PUSHED ffs_prog.c
// interpreter (13136 B, fits the 16384 arena) and is exercised by the dev-box testkit.
// Prior big-arena image was 47a337ef (LDR_MAX_PAYLOAD 9216 -> 16384, for INK's rasteriser).
// ⛔ THIS CONSTANT IS NOT THE GATE. G2Flash.kt's allGoldens is what actually refuses an
// unknown image; bumping only this one silently changes nothing (learned the hard way).
// ⚠️ BUMPED 2026-08-20 for the S2 APP RUNTIME (CI run 32317924211, clang-18). Adds the
// resident app loader behind the takeover dashboard: an FXP1 body beginning "FFSA" is an app
// IMAGE, copied into its own buffer and launched/killed by the shell, so a new mini app costs
// a BLE push instead of a ~13 min reflash. Also: the loader's permanent arena now degrades in
// halves to a 2 KB floor instead of giving up, and reports the size it actually got.
// The frozen FFSP wire contract (patches/ffs_prog.h) is untouched.
// ⚠️ BUMPED 2026-08-20 (S-INT) for the SAFETY GATE + LAYER-TOP SHELL (CI run 32397128110).
// Merges three streams: R1's arena-independent panic reset (a 12-byte marker on service 0x09
// reboots the lenses from Even's own inbound handler, before any allocation -- the escape
// hatch for the `calls=0 rxlen=0` deafness that cost two reflashes, which ffs_reset.c cannot
// fix because a reset is itself a push) plus a ballast on Even's two silent inbound mallocs;
// S2-top's shell on lv_layer_top with its surface in P_FT instead of P_GLOBAL (~20.5 KB
// returned) and a constructor that only cleans Even's widgets once ours exists; and
// G2A_MAX_CODE 2048 -> 6144 with a 16 KB cap on the running total.
// Prior image was 7e8422fa (goldenBig27, full-HUD 576x288 shell on P_FT).
// 2026-08-21 (S-SHIP): + the phone->app data channel (FFSC / G2_ABI 2), S-FIX tier 3
// (FXP1 consumed at the transport gate), and S-EYES's left-lens peer readback.
// 2026-08-21 (Toolkit R1 — S2 input): + long-press delivered to the running app, double-tap
// system-back with a "Close app?" modal (real 5x7 text). Not the gate — G2Flash.kt allGoldens is.
const LOADER_2_2_7_14_SHA = "6288cd10a004f386cdbd1ed8f4a92c567acd6025ab47381c5bf0558d9f30a0e7";
// Stock 2.2.7.14, kept as the restore-to-stock escape hatch for the current base.
const STOCK_2_2_7_14_URL = `${FW_BASE}/g2_2.2.7.14_stock.bin`;
const STOCK_2_2_7_14_SHA = "0fced0aebcc6c88db6f76dba34f91b805d842a5fc297bfd7fa6d6a34ec83cecb";
const CFW_SERVICE = 0x90; // custom CFW loader BLE service id
const WARRANTY_PHRASE = "my warranty is void";

// FUT-167 soft precheck — a self-attested readiness checklist that must be
// acknowledged (AND the warranty phrase) before a real flash arms. Right-sized to
// the ACTUAL risk: Yoni's clean on-face official flash proved the battery-brick
// vector is minor (near-zero power), so the battery floor is a SOFT self-confirm,
// not a device read. The real risk is BLE dropping across the ~5-min window, so the
// high-value items are stay-close / stay-foregrounded / screen-on. Items are user
// attestations (the app does not read battery or hold a wake-lock — those are
// offered later follow-ups), so the wording claims nothing the app doesn't enforce.
const PRECHECK_ITEMS: string[] = [
  "Glasses are charged (≥25% — soft floor; near-zero power flash, so just insurance)",
  "Phone stays within ~1 m of the glasses the whole time — I won't walk away (~5 min)",
  "I'll keep this app open + foregrounded and my screen ON so it won't lock mid-flash",
  "Glasses are stable/worn and won't be handled or moved during the flash",
];

// FUT-220 — the flashable images as DATA, not nine copy-pasted Pressables. Order is the
// order you'd actually run them. `badge`/`tint` group by family (baseline / Hebrew / FFS OS
// / full CFW / revert) so a row is identifiable at a glance; risk lives in the tag, not the
// colour. Every image that was reachable before is still reachable here — nothing removed.
type FwImage = {
  key: string;
  badge: string;
  tint: string;
  name: string;
  desc: string;
  trace: string;
  url: string;
  sha: string;
};

const FW_IMAGES: FwImage[] = [
  {
    key: "loader27",
    badge: "LD7",
    tint: theme.tint.green,
    name: "OTA loader 2.2.7.14 — FLASH THIS ONE",
    desc: "Rebased onto the stock firmware you're actually running. Flash once, then push payloads forever. After it reboots, read device info — an ⟨LD04⟩ record means the rebase is correct.",
    trace: "FUT-246",
    url: LOADER_2_2_7_14_URL,
    sha: LOADER_2_2_7_14_SHA,
  },
  {
    key: "stock27",
    badge: "S7",
    tint: theme.tint.blue,
    name: "Restore stock 2.2.7.14",
    desc: "Unmodified Even firmware for the current base — the escape hatch. Verified md5 against Even's own CDN.",
    trace: "FUT-246",
    url: STOCK_2_2_7_14_URL,
    sha: STOCK_2_2_7_14_SHA,
  },
  {
    key: "canary",
    badge: "CN",
    tint: theme.tint.blue,
    name: "Canary — do this first",
    desc: "Stock + version marker → 2.2.6.77. Proves write→commit→reboot→readback on hardware.",
    trace: "FUT-167",
    url: CANARY_URL,
    sha: CANARY_SHA,
  },
  {
    key: "fontpeek",
    badge: "FP",
    tint: theme.tint.purple,
    name: "Font-peek",
    desc: "Adds a font-header read. Flash, then tap Read device info → ⟨FONT0=…⟩.",
    trace: "FUT-188",
    url: FONTPEEK_URL,
    sha: FONTPEEK_SHA,
  },
  {
    key: "bidi",
    badge: "he1",
    tint: theme.tint.amber,
    name: "Hebrew ① — BIDI only",
    desc: "RTL reorder, no glyph changes. Check English/Chinese still render.",
    trace: "FUT-190",
    url: HEBREW_BIDI_URL,
    sha: HEBREW_BIDI_SHA,
  },
  {
    key: "hebfull",
    badge: "he2",
    tint: theme.tint.amber,
    name: "Hebrew ② — full",
    desc: "bidi + glyphs. This is the one that actually renders Hebrew, system-wide.",
    trace: "FUT-189",
    url: HEBREW_FULL_URL,
    sha: HEBREW_FULL_SHA,
  },
  {
    key: "hebprobe",
    badge: "heV",
    tint: theme.tint.amber,
    name: "Hebrew v2 + probe",
    desc: "Full glyph coverage + font-name diagnostic. Browse the UI, then read device info.",
    trace: "FUT-191",
    url: HEBREW_PROBE_URL,
    sha: HEBREW_PROBE_SHA,
  },
  {
    key: "ffsui",
    badge: "OS",
    tint: theme.tint.green,
    name: "FFS OS seize",
    desc: "Our own screen replaces Even's — “FFS OS” + a live MM:SS ticker, phone-independent.",
    trace: "FUT-197",
    url: FFSUI_URL,
    sha: FFSUI_SHA,
  },
  {
    key: "ramexec",
    badge: "RX",
    tint: theme.tint.green,
    name: "RAM-exec probe",
    desc: "Proves pushing code into RAM runs. Read device info → ret=0x2A means go.",
    trace: "FUT-214",
    url: RAMEXEC_URL,
    sha: RAMEXEC_SHA,
  },
  {
    key: "loader",
    badge: "LD",
    tint: theme.tint.green,
    name: "OTA loader — 2.2.6.10 base (LEGACY)",
    desc: "⚠️ WRONG BASE for your glasses — this targets stock 2.2.6.10 and you are on 2.2.7.14. Use the LD7 image above. Kept only for a deliberate downgrade.",
    trace: "FUT-216",
    url: LOADER_URL,
    sha: LOADER_SHA,
  },
  {
    key: "cfw",
    badge: "FW",
    tint: theme.tint.red,
    name: "Full CFW",
    desc: "The complete custom firmware image.",
    trace: "FUT-167",
    url: CFW_URL,
    sha: CFW_SHA,
  },
  {
    key: "stock",
    badge: "↩",
    tint: theme.tint.grey,
    name: "Restore stock",
    desc: "Back to Even 2.2.6.10. The way out of anything above.",
    trace: "FUT-173",
    url: STOCK_URL,
    sha: STOCK_SHA,
  },
];

function healthColor(h: ConnectionHealth): string {
  switch (h) {
    case "healthy":
      return theme.accent;
    case "degraded":
    case "connecting":
    case "reconnecting":
      return theme.warn;
    case "disconnected":
      return theme.textDim;
  }
}

// FUT-253: catch any render/lifecycle crash in the OS tree and ship it off-device
// (glog.error was defined but never wired — an uncaught throw used to vanish into a
// blank screen with no trace). Keeps the app alive with a minimal fallback.
class GlogErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  componentDidCatch(err: unknown, info: { componentStack?: string }): void {
    try {
      glog.error("react_boundary", err);
      glog.emit("error", "boundary", { stack: String(info?.componentStack ?? "").slice(0, 800) });
    } catch {
      /* logging must never re-throw out of the boundary */
    }
  }
  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <Text style={styles.help}>FFS OS hit a render error — it was logged to the collector. Reopen the app.</Text>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <GlogErrorBoundary>
      <AppInner />
    </GlogErrorBoundary>
  );
}

function AppInner() {
  // FUT-236 — the calibration run owns the whole screen when active, and on a fresh
  // install it comes up FIRST, before the OS shell. Yoni asked for it to start "when I
  // open the app for the first time with both glasses and ring unpaired". Resolved
  // synchronously from a persisted flag so there is no flash of the normal UI first.
  const [calibrating, setCalibrating] = useState<boolean>(() => {
    try {
      return FfsBle.getPref("calib.v1.completed") === null;
    } catch {
      return false; // never block the app on the harness
    }
  });

  const [tab, setTab] = useState<TabKey>("link");
  /**
   * Last device-info response that actually CARRIED the CFW blocks, latched for the life
   * of the link.
   *
   * Both lenses answer a device-info read and only one response carries the extension
   * fields, so `deviceInfo` — which holds whichever arrived last — flips between "has
   * blocks" and "has none" on every read. Rendering the newest response directly made
   * the header announce "STOCK" at a pair whose CFW had just been read back as
   * `RAMEXEC EXEC_OK`. A wrong negative here is worse than no readout: it invites
   * exactly the "why is the firmware ignoring us" hunt that the line exists to prevent.
   */
  const [cfwSeen, setCfwSeen] = useState<ReturnType<typeof parseCfw> | null>(null);

  const bt = useFfsBluetooth({ autoScan: true });
  // FUT-253: feed every connection-health transition to the collector (the FUT-136
  // "drop → reconnect → home" sequence — the single highest-value miss). glog.conn was
  // defined but never wired; the supervisor already calls onEvent on each transition.
  const sup = useConnectionSupervisor(bt, { onEvent: glog.conn });
  const [session, setSession] = useState<string>("");
  const [swirlOn, setSwirlOn] = useState(false);
  const [flashProbe, setFlashProbe] = useState<string>("");
  // FUT-233 — R1 ring. Independent of the glasses link by design.
  const [ringState, setRingState] = useState<string>("—");
  const [ringFrames, setRingFrames] = useState(0);
  const [ringLog, setRingLog] = useState<string[]>([]);
  /** advStart needs the glasses' MAC, which only a lens scan reveals. */
  const glassesMac = bt.devices.find((d) => d.side !== "ring" && d.mac)?.mac ?? null;

  // Ring events. Mounted unconditionally — NOT gated on the glasses link, because the
  // test that matters is performed with the glasses off (FUT-233).
  // Developer screenshot: keep the fb_shot assembler armed app-wide so a pushed fb_shot
  // payload's frames are captured whenever they arrive (harmless otherwise — it only reacts
  // to "FBSH" frames, which the firmware sends only on an explicit screenshot push).
  useEffect(() => startFbShot(), []);

  useEffect(() => {
    const subs = [
      // Bluetooth being off is the single most likely reason a scan finds nothing, and
      // the panel used to just say "scanning…" forever while the driver logged the real
      // reason where only Rico could see it. Say it on screen. (FUT-233, 2026-07-28.)
      FfsBle.addListener("onStateChange", (p) => {
        if (p.state !== "poweredOn") {
          setRingState(`Bluetooth is ${p.state} — turn Bluetooth on`);
          setRingLog((l) => [`bluetooth ${p.state}`, ...l].slice(0, 12));
        }
      }),
      FfsBle.addListener("onRingConnected", (p) => {
        setRingState(`connected — ${p.name}`);
        setRingLog((l) => [`READY: ${p.name}`, ...l].slice(0, 12));
        glog.emit("ring", "connected", { name: p.name }); // FUT-253: ring normal-path telemetry
      }),
      FfsBle.addListener("onRingDisconnected", (p) => {
        setRingState("—");
        setRingLog((l) => [`disconnected${p.reason ? ` (${p.reason})` : ""}`, ...l].slice(0, 12));
        glog.emit("ring", "disconnected", { reason: p.reason ?? null });
      }),
      // Every frame, decoded or not — an unmapped code is a finding, not noise.
      FfsBle.addListener("onRingRaw", (p) => {
        setRingFrames((n) => n + 1);
        setRingLog((l) => [`rx ${p.hex}`, ...l].slice(0, 12));
        glog.emit("ring", "raw", { hex: p.hex }); // sampled 1-in-N at the source (HOT_KEYS "ring:raw")
      }),
      FfsBle.addListener("onRingBattery", (p) => {
        setRingLog((l) => [`battery ${p.battery}%`, ...l].slice(0, 12));
        glog.emit("ring", "battery", { battery: p.battery });
      }),
      FfsBle.addListener("onGesture", (g) => {
        if (g.device !== "ring") return;
        setRingLog((l) => [`👆 ${g.gesture}`, ...l].slice(0, 12));
        glog.emit("ring", "gesture", { gesture: g.gesture });
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  const [flashMsg, setFlashMsg] = useState<string>("");
  const [flashFrac, setFlashFrac] = useState<number>(0);
  const [flashBusy, setFlashBusy] = useState<boolean>(false);
  const [warranty, setWarranty] = useState<string>("");
  const [textTest, setTextTest] = useState<string>("");
  const [precheck, setPrecheck] = useState<boolean[]>(() => PRECHECK_ITEMS.map(() => false));
  // ⚠️ THE GLASSES CAN OPEN THEIR OWN MICROPHONE. Three of the eighteen audio bursts in the
  // 08-18/08-20 archive had no CTRL ENTER from this phone before them — the GX8002 wake word, or
  // a temple long-press into Even's stock voice flow. This banner is the only place that fact is
  // ever visible to the wearer, so it is pinned above the tabs' content rather than filed in a
  // panel, and it does not auto-dismiss. Metadata only: a side and a clock reading, never audio.
  const [micAlert, setMicAlert] = useState<{ side: string; at: number; n: number } | null>(null);

  // Live refs so the nav's context getters always read current session state.
  const btRef = useRef(bt);
  btRef.current = bt;

  // FUT-237 — the native-push acknowledgement loop (guard on the OTA loader, park/send,
  // poll device-info to attribution). Extracted from ~90 inline lines + five refs into a
  // tested, dependency-injected controller — see usePushAck.ts. `getContext` reads live
  // session state so a push fired from a debug button sees the current deviceInfo/pairReady.
  const pushAck = usePushAck(() => ({
    deviceInfo: btRef.current.deviceInfo,
    pairReady: btRef.current.pairReady,
  }));

  // One PhoneNav for the whole session. Its onChange re-asserts the current surface
  // through screenOwner (which serializes BLE writes so repaints never interleave).
  const navRef = useRef<PhoneNav | null>(null);
  if (!navRef.current) {
    const ctx: PhoneCtx = {
      pairReady: () => btRef.current.pairReady,
      sides: () => btRef.current.sides,
      // Real battery read back from the glasses (FUT-169); -1 = not read yet → HUD shows "?".
      battery: () => btRef.current.deviceInfo?.battery ?? -1,
      version: () => APP_VERSION,
      gestures: () => navRef.current?.gestureCount ?? 0,
    };
    navRef.current = new PhoneNav(homeScreen, ctx, () => {
      screenOwner.reclaimNow();
      // FUT-253: on-glass screen transitions (nav.ts had no telemetry hook).
      try { glog.emit("os", "nav", navRef.current?.describe() ?? {}); } catch { /* never break nav */ }
    });
  }

  // Off-device telemetry (FUT-144 collector).
  useEffect(() => {
    initLoggerCore({ app: "ffs-os-phone", harness: "App" });
    setSession(glog.session());
    // FUT-253: log every HUD surface repaint (glog.reclaim was a dead sink).
    screenOwner.setOnReclaim(glog.reclaim);
    glog.emit("os", "launcher_start", { session: glog.session(), version: APP_VERSION });
  }, []);

  // FUT-253: raw connection snapshot — emit whenever any observable link field changes
  // (glog.connState was defined but never called). Cheap: fires only on state transitions.
  useEffect(() => {
    glog.connState({
      connected: bt.sides.L || bt.sides.R,
      ready: bt.pairReady,
      rawState: bt.state,
      battery: bt.deviceInfo?.battery ?? null,
    });
  }, [bt.sides.L, bt.sides.R, bt.pairReady, bt.state, bt.deviceInfo?.battery]);

  // Latch the CFW blocks from whichever lens carries them (see `cfwSeen`), and drop the
  // latch when the link does — a stale "CFW EXEC_OK" surviving a reconnect onto stock
  // firmware would be the same false readout in the opposite direction.
  useEffect(() => {
    const carrier = [bt.deviceInfo?.leftVersion, bt.deviceInfo?.rightVersion].find((v) =>
      v?.includes("⟨"),
    );
    if (carrier) setCfwSeen(parseCfw(carrier));
  }, [bt.deviceInfo?.leftVersion, bt.deviceInfo?.rightVersion]);

  useEffect(() => {
    if (!bt.pairReady) {
      setCfwSeen(null);
      pushAck.onLinkDropped();
    }
    // pushAck delegates to a stable controller; keeping it out of deps preserves the
    // original "fire once per pairReady transition" behaviour (adding it would re-run on
    // every status change while disconnected).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bt.pairReady]);

  // FUT-167 Stage 1: receive the zero-write flash-channel probe result.
  useEffect(() => {
    const sub = FfsBle.addListener("onFlashProbe", (e) => {
      const ready = e.leftReady && e.rightReady;
      setFlashProbe(`${e.detail}\n→ ${ready ? "READY — flasher can reach both lenses ✓" : "NOT ready"}`);
      glog.emit("os", "flash_probe", { leftReady: e.leftReady, rightReady: e.rightReady });
    });
    return () => sub.remove();
  }, []);

  // FUT-167 Stage 2: CFW flash / validate progress.
  useEffect(() => {
    const sub = FfsBle.addListener("onFlashProgress", (e) => {
      setFlashMsg(e.message);
      setFlashFrac(e.progress);
      if (e.done) setFlashBusy(false);
      glog.emit("os", "flash_progress", { message: e.message, progress: e.progress, done: e.done, ok: e.ok });
    });
    return () => sub.remove();
  }, []);

  // FUT-165 diagnostics (Yoni ask): stream EVERY native driver log line + disconnects +
  // device-info to the off-device collector, so a full trace of what the driver actually
  // did (anim frame sizes, gen time, queue depth, disconnect reasons) is visible remotely.
  useEffect(() => {
    const subs = [
      FfsBle.addListener("onLog", (e) => glog.emit("drv", "log", { m: e.message })),
      // FUT-253: the connect lifecycle — previously only the hook consumed these, so the
      // collector never saw a link come up. Handlers here are telemetry-only (no behaviour).
      FfsBle.addListener("onDeviceFound", (d) =>
        glog.emit("drv", "device_found", { side: d.side, name: d.name ?? null, mac: d.mac ?? null, rssi: d.rssi ?? null })),
      FfsBle.addListener("onConnected", (e) => glog.emit("drv", "connected", { side: e.side })),
      FfsBle.addListener("onPairReady", () => glog.emit("drv", "pair_ready", {})),
      FfsBle.addListener("onStateChange", (p) => glog.emit("drv", "adapter_state", { state: p.state })),
      FfsBle.addListener("onDisconnected", (e) =>
        glog.emit("drv", "disconnected", { side: e.side, reason: e.reason ?? null, code: e.code, domain: e.domain })),
      FfsBle.addListener("onDeviceInfo", (e) => {
        glog.emit("drv", "device_info", { batt: e.battery, chg: e.charging, l: e.leftVersion, r: e.rightVersion });
        // The whole loader-attribution state machine lives in usePushAck — feed it the
        // readback and it advances any in-flight ack and fires any parked push.
        pushAck.onDeviceInfo(e.leftVersion, e.rightVersion);
      }),
      // FUT-253 Step 3: native BLE link-level observability. cat:"ble" for link signals
      // (rssi/mtu/throughput/backpressure), cat:"drv" for the render-pipeline ack. All are
      // telemetry-only — non-throwing, and glog.emit itself never throws into the app.
      FfsBle.addListener("onRssi", (e) => glog.emit("ble", "rssi", { side: e.side, rssi: e.rssi })),
      FfsBle.addListener("onMtu", (e) => glog.emit("ble", "mtu", { side: e.side, mtu: e.mtu })),
      FfsBle.addListener("onConnectFailed", (e) =>
        glog.emit("ble", "connect_failed", { side: e.side, code: e.code, domain: e.domain, desc: e.desc })),
      FfsBle.addListener("onTxMeter", (e) =>
        glog.emit("ble", "tx_meter", { side: e.side, bytes: e.bytes, pkts: e.pkts, depth: e.queueDepth })),
      FfsBle.addListener("onTxStall", (e) => glog.emit("ble", "tx_stall", { side: e.side, depth: e.queueDepth })),
      FfsBle.addListener("onTxResume", (e) => glog.emit("ble", "tx_resume", { side: e.side, depth: e.queueDepth })),
      FfsBle.addListener("onSubscribe", (e) =>
        glog.emit("ble", "subscribe", { side: e.side, characteristic: e.characteristic, on: e.on })),
      // Mic burst edges. `requestedByUs` false = WE DID NOT ASK — raise it to the wearer. The
      // requested case is counted and logged but never banners, or every dictation nags.
      FfsBle.addListener("onMicUnexpected", (e) => {
        glog.emit("ble", "mic_burst", { side: e.side, gapMs: e.gapMs, requestedByUs: e.requestedByUs });
        if (e.requestedByUs) return;
        console.warn(`MIC-UNEXPECTED side=${e.side} — the glasses opened their own microphone`);
        setMicAlert((prev) => ({ side: e.side, at: Date.now(), n: (prev?.n ?? 0) + 1 }));
      }),
      FfsBle.addListener("onImgAck", (e) =>
        glog.emit("drv", "img_ack", { session: e.session, fragment: e.fragment, ok: e.ok, timedOut: e.timedOut })),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // The mini-OS. Listens for the debug `OS` broadcast (`--es cmd boot|stop`) and runs FfsOs
  // against the SDK. Nothing here drives the glasses directly — the OS owns the HUD once booted.
  // console.log as well as glog: the collector is remote, and an unattended on-glass run needs
  // these visible in logcat right next to the driver's own lines.
  useEffect(
    () => attachOsCommandListener((m) => { console.log(m); glog.emit("os", "log", { m }); }),
    []
  );

  // FUT-167 soft precheck: a real flash arms ONLY when the warranty phrase is typed
  // AND every readiness item is acknowledged. Single source of truth — both the FLASH
  // CFW and Restore Stock buttons gate on `armed`; there is no other arming path.
  const precheckDone = precheck.every(Boolean);
  const armed = warranty.trim() === WARRANTY_PHRASE && precheckDone;
  // The notification → glasses bridge, at APP SCOPE so it forwards, auto-rebinds and runs its crash
  // breaker regardless of which tab is showing (it used to live inside NotificationsPanel and thus
  // only ran on the Drive tab — see useNotificationBridge). The panel is just its view.
  // FUT-237 — the loader guard that gates it lives in usePushAck (never push with no resident
  // OTA loader — the stock decoder parses our Thumb-2 as a bitmap → blank lens → watchdog reboot).
  const notifBridge = useNotificationBridge(bt.pairReady, pushAck.loaderPresent());

  const startFlash = (url: string, sha: string, dryRun: boolean) => {
    if (!bt.pairReady || flashBusy) return;
    setFlashBusy(true);
    setFlashMsg("starting…");
    setFlashFrac(0);
    glog.emit("os", "flash_start", { dryRun, url, precheckAcked: dryRun ? null : precheckDone });
    FfsBle.startCfwFlash(url, sha, dryRun);
    // Real-flash safety: disarm immediately so the button can't be re-fired by accident.
    // A second real flash must re-type the warranty phrase AND re-confirm the checklist.
    if (!dryRun) {
      setWarranty("");
      setPrecheck(PRECHECK_ITEMS.map(() => false));
    }
  };

  // ⛔ THE LEGACY JS PHONE-OS NO LONGER OWNS THE HUD (2026-08-07, Yoni's call: "get rid of it").
  //
  // This effect used to start screenOwner, paint the JS home menu, and route gestures into
  // PhoneNav the moment the pair went ready. That model is obsolete and actively harmful now
  // that the glasses render and drive their own native containers:
  //   * Every re-render repainted the HUD via showText, DESTROYING any natively-declared page.
  //     This is what made the FUT-249 gesture-injection probe read "no list found" — the JS home
  //     page had replaced the list before the payload ran.
  //   * It re-rendered the whole page on the phone for every scroll (~156 ms round trip), which
  //     is exactly the phone-in-the-loop design the native list container replaces.
  //   * Gestures were routed into PhoneNav, competing with the firmware's own event binding.
  //
  // The phone-side UI is untouched: explicit buttons still call navRef/screenOwner on demand.
  // What is gone is the AUTOMATIC ownership. Do not restore this without a deliberate decision —
  // if it comes back, every native on-glass screen starts getting clobbered again.
  //
  // (Kept for reference: FUT-236 required suppressing gesture routing during a calibration run,
  // because routing taps into navigation activated a menu item mid-measurement and dropped both
  // lenses. With routing gone entirely, that hazard goes with it.)
  useEffect(() => {
    if (!bt.pairReady || calibrating) return;
    glog.emit("os", "phone_os_up", { hudOwned: false });
  }, [bt.pairReady, calibrating]);

  // ⛔ REMOVED with the HUD-ownership effect above: a once-a-minute repaint to keep the JS
  // status-bar clock ticking. Harmless when JS owned the screen; fatal now — it silently wiped
  // whatever native page was on the glasses, on a 60-second timer, with no log line to explain
  // it. That is why a declared list would survive a push and then vanish "on its own" a minute
  // later. If a live clock is wanted again, it must be drawn by the glasses, not repainted by
  // the phone.

  const health = sup.health;
  const hc = healthColor(health);
  const canAct = bt.pairReady && !flashBusy;
  const batt = bt.deviceInfo?.battery;
  const fwVersion = parseCfw(bt.deviceInfo?.leftVersion ?? bt.deviceInfo?.rightVersion).fw;

  // Placed AFTER every hook above, so hook order stays identical whether or not the
  // harness is showing — an early return above any hook would break the rules of hooks.
  if (calibrating) {
    return (
      <CalibrationScreen
        appVersion={APP_VERSION}
        onExit={(completed) => {
          // Record completion either way: an abandoned run should not re-ambush Yoni
          // on every launch. It stays re-runnable from the Developer section.
          try {
            FfsBle.setPref("calib.v1.completed", completed ? "done" : "skipped");
          } catch {
            /* non-fatal — worst case it offers again next launch */
          }
          setCalibrating(false);
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      {/* Pinned status — the link state is the one thing that must never scroll away. */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>FFS Glasses OS</Text>
          <View style={styles.pill}>
            <View style={[styles.dot, { backgroundColor: hc }]} />
            <Text style={[styles.pillText, { color: hc }]}>{healthLabel(health)}</Text>
          </View>
        </View>
        <Text style={styles.headerMeta}>
          L {bt.sides.L ? "●" : "○"}  R {bt.sides.R ? "●" : "○"}  ·  pair {bt.pairReady ? "ready" : "—"}
          {batt == null ? "" : `  ·  ${batt}%`}
          {bt.deviceInfo?.charging ? " ⚡" : ""}
          {fwVersion ? `  ·  ${fwVersion}` : ""}  ·  v{APP_VERSION}
        </Text>

        {/* The CFW line. Promoted out of a row subtitle because it decides whether an
            experiment means anything: a raster push on stock firmware and the same push
            on CFW fail in ways that look identical from here. `imgz` absent + a black
            HUD is a firmware answer, not an encoder bug. */}
        {bt.deviceInfo ? (
          <Text style={styles.headerCfw} numberOfLines={1}>
            {cfwSeen && (cfwSeen.caps.length || cfwSeen.ramexec || cfwSeen.loader) ? (
              // CFW is PRESENT the moment any of its firmware-authored blocks appear — the
              // ⟨CAPS⟩ advertisement (emitted on every read), a ⟨LOADER⟩ receipt, or the
              // RAMEXEC probe. Keying only on RAMEXEC was wrong: the shipped image dropped that
              // probe (its bytes paid for the peer= field), so a fully-advertised CFW read as
              // "not advertised yet" while listing its own caps right beside the words.
              <Text
                style={{ color: cfwSeen.ramexec && cfwSeen.ramexec !== "EXEC_OK" ? theme.danger : theme.accent }}
              >
                CFW{cfwSeen.ramexec ? ` ${cfwSeen.ramexec}` : ""}
              </Text>
            ) : (
              // NOT "stock" — absence of blocks so far only means the lens that carries
              // them has not answered yet. Claiming stock on this evidence would be a
              // measurement we did not make.
              <Text style={{ color: theme.warn }}>CFW not advertised yet</Text>
            )}
            {cfwSeen?.caps.length ? `  ·  ${cfwSeen.caps.join(" ")}` : ""}
            {cfwSeen?.loader ? `  ·  LD ${cfwSeen.loader.ran}/${cfwSeen.loader.gen}` : ""}
          </Text>
        ) : null}
      </View>

      <Tabs
        tabs={[
          { key: "link", label: "Link" },
          { key: "drive", label: "Drive" },
          { key: "flash", label: "Flash" },
          { key: "log", label: "Log" },
        ]}
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
      />

      {/* Pinned flash progress. A ~5-min brick-risk window deserves better than a text
          line buried in a scroll — bar + percent + the "don't walk away" reminder, held
          on screen the whole time (Meta AI / IKEA / Fitbit device-update pattern). */}
      {flashMsg ? (
        <View style={[styles.flashBar, flashBusy && styles.flashBarActive]}>
          <View style={styles.flashRow}>
            <Text style={styles.flashPct}>{Math.round(flashFrac * 100)}%</Text>
            <Text style={styles.flashMsg} numberOfLines={1}>
              {flashBusy ? "⏳ " : ""}
              {flashMsg}
            </Text>
          </View>
          <Progress frac={flashFrac} tint={flashBusy ? theme.warn : theme.accent} />
          {flashBusy ? (
            <Text style={styles.flashWarn}>
              Keep the app open and stay within ~1 m of the glasses until this finishes.
            </Text>
          ) : null}
        </View>
      ) : null}

      {micAlert ? (
        <View style={styles.micBar}>
          <Text style={styles.micTitle}>🎤 The glasses opened their own microphone</Text>
          <Text style={styles.micBody}>
            Audio started streaming from the {micAlert.side === "L" ? "left" : "right"} lens at{" "}
            {new Date(micAlert.at).toLocaleTimeString()} and this phone never asked for it — a wake
            word or a temple long-press into Even's own voice flow.
            {micAlert.n > 1 ? `  (${micAlert.n}× this session)` : ""}
          </Text>
          <Text style={styles.micBody}>
            Nothing was recorded, logged or sent: the audio characteristic is dropped in the driver
            before it can reach a log, JavaScript or the network.
          </Text>
          <Pressable onPress={() => setMicAlert(null)}>
            <Text style={styles.micDismiss}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={true}
      >
        {/* FUT-233 — the R1 ring is the SDK's input device. Deliberately FIRST and
            deliberately NOT gated on `pairReady`: the discriminating test is run with
            the glasses POWERED OFF, so anything requiring a lens link would make the
            test impossible to perform. */}
        {/* FUT-236 — re-runnable on demand, not just on a fresh install. Every run is
            a fresh labelled dataset, so re-running after a firmware or app change is
            the cheapest way to re-establish ground truth. */}
        {tab === "link" && (
          <>
        {/* Link first: connecting is the most-used control on this tab, and it used to
            sit third, below two sections that only matter once you already have a link. */}
        <SectionLabel>Link</SectionLabel>
        <Group>
          <Row
            badge="↯"
            tint={theme.tint.green}
            title="Connect"
            subtitle="Scan + reclaim both lenses"
            onPress={() => sup.reconnect()}
          />
          <Row
            badge="✕"
            tint={theme.tint.grey}
            title="Disconnect"
            subtitle="Drop the session"
            divider
            onPress={() => sup.disconnect()}
          />
          <Row
            badge="i"
            tint={theme.tint.blue}
            title="Read battery + firmware version"
            subtitle={
              bt.deviceInfo
                ? // The ⟨…⟩ diagnostic blocks are in the header now; repeating ~300 chars
                  // of hex here made the row four lines tall and told you nothing extra.
                  `L ${parseCfw(bt.deviceInfo.leftVersion).fw || "?"} · R ${
                    parseCfw(bt.deviceInfo.rightVersion).fw || "?"
                  }`
                : bt.pairReady
                  ? "not read yet — auto-reads ~2 s after connect"
                  : "connect both lenses first"
            }
            trace="FUT-169"
            divider
            disabled={!canAct}
            onPress={() => bt.requestDeviceInfo()}
          />
        </Group>

        <SectionLabel note="FUT-236 · ~5 min, guided">Calibration run</SectionLabel>
        <Group>
          <Row
            badge="◎"
            tint={theme.tint.amber}
            title="Run SDK calibration"
            subtitle="Guided capture of everything the ring and glasses expose"
            trace="FUT-236"
            onPress={() => setCalibrating(true)}
          />
        </Group>

        <SectionLabel note="FUT-233 · works with the glasses OFF">R1 ring — input test</SectionLabel>
        <Group>
          <Row
            badge="💍"
            tint={theme.tint.purple}
            title={ringState === "—" ? "Scan for ring" : "Rescan ring"}
            subtitle={
              ringState === "—"
                ? "Wear the ring, then tap — glasses can stay off"
                : ringState
            }
            tag={ringFrames > 0 ? `${ringFrames} frames` : undefined}
            tagTint={theme.accent}
            trace="FUT-233"
            onPress={() => {
              setRingLog((l) => ["scanning for ring…", ...l].slice(0, 12));
              FfsBle.ringScan();
            }}
          />
          <Row
            badge="⛓"
            tint={theme.tint.blue}
            title="Ring → also connect to glasses"
            subtitle={
              glassesMac
                ? `advStart → ${glassesMac} (does both links coexist?)`
                : "Scan for the glasses first — needs their MAC"
            }
            divider
            disabled={!glassesMac}
            onPress={() => {
              const ok = FfsBle.ringConnectToGlasses(glassesMac!);
              setRingLog((l) =>
                [`advStart ${ok ? "sent" : "REJECTED — ring not connected?"}`, ...l].slice(0, 12)
              );
            }}
          />
          <Row
            badge="✕"
            tint={theme.tint.blue}
            title="Forget ring"
            subtitle="Unpair, so the next scan starts fresh"
            divider
            onPress={() => {
              FfsBle.ringForget();
              setRingState("—");
              setRingFrames(0);
              setRingLog([]);
            }}
          />
        </Group>
        <Text style={styles.help}>
          Glasses OFF → Scan → do all five: single tap · double tap · swipe up · swipe down ·
          hold. Every frame below is also sent to telemetry, so Rico reads the result.
        </Text>
        {ringLog.length > 0 ? (
          <Text style={styles.mono}>{ringLog.join("\n")}</Text>
        ) : null}
          </>
        )}

        {tab === "drive" && (
          <>
        <SectionLabel note="swipe up/down · tap · double-tap">Drive on-glass</SectionLabel>
        <Group>
          <Row
            badge="⌂"
            tint={theme.tint.green}
            title="Home"
            subtitle="Jump the HUD back to the launcher"
            disabled={!bt.pairReady}
            onPress={() => navRef.current?.goHome()}
          />
          <Row
            badge="‹"
            tint={theme.tint.blue}
            title="Back"
            subtitle="Pop one screen on the HUD"
            divider
            disabled={!bt.pairReady}
            onPress={() => {
              const nav = navRef.current;
              if (nav?.back()) screenOwner.reclaimNow();
            }}
          />
          <Row
            badge={swirlOn ? "■" : "▶"}
            tint={theme.tint.purple}
            title={swirlOn ? "Stop AI swirl" : "Start AI swirl"}
            subtitle="Even's swirl animation on the HUD"
            tag={swirlOn ? "ON" : undefined}
            tagTint={theme.accent}
            divider
            disabled={!bt.pairReady}
            onPress={() => {
              const next = !swirlOn;
              setSwirlOn(next);
              glog.emit("os", "ai_swirl", { on: next });
              FfsBle.showAiSwirl(next);
            }}
          />
        </Group>
        {/* Gesture readout — kept visible: it's how you tell the touchpad is actually
            reaching the phone when the HUD looks stuck. */}
        {bt.lastGesture ? (
          <Text style={styles.mono}>
            last gesture: {bt.lastGesture.gesture} ({bt.lastGesture.side})
          </Text>
        ) : null}

        <SectionLabel note="FUT-191">Text test — Hebrew / English scroll</SectionLabel>
        <View style={styles.card}>
          <TextInput
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            multiline
            value={textTest}
            onChangeText={setTextTest}
            placeholder="Paste a long story (English + Hebrew) to display on the glasses…"
            placeholderTextColor={theme.textDim}
          />
          <Pressable
            style={[styles.btn, (!canAct || !textTest.trim()) && styles.btnDisabled]}
            disabled={!canAct || !textTest.trim()}
            onPress={() => {
              setTextTestContent(textTest);
              navRef.current?.openScreen(textTestScreen);
              screenOwner.reclaimNow();
            }}
          >
            <Text style={styles.btnText}>Send to glasses → Text test</Text>
          </Pressable>
          <Text style={styles.help}>
            On the glasses: swipe up/down to scroll, double-tap to exit. Also on the on-glass
            menu (Home → Text test).
          </Text>
        </View>

        {/* Build a native dashboard/screen descriptor on the phone and push it. Lives on
            Drive, not Probes: the Probes grid is fifty FIXED blobs you tap to fire, this is
            a configuration you compose. It shares guardedPush, so the OTA-loader gate and
            the push status line are exactly the same ones the Probes tab shows. */}
        <DashboardPanel disabled={!canAct} status={pushAck.status} onPush={pushAck.guardedPush} />

        {/* The notification bridge: an allowlist-only Android listener feeding REAL messages to
            the on-glass `messages` app over the FFSC data channel. The allowlist lives on screen
            rather than in a constant, because it is the whole privacy design — see
            src/notifications/allowlist.ts. Not gated on `pairReady`: the grant, the allowlist and
            the counters all matter with the glasses off, and the pump holds its value until the
            link returns. */}
        <NotificationsPanel bridge={notifBridge} />

        {/* Dev-only: live on-glass telemetry (memory / active page / VM error / lens), no camera.
            Gated by DEV_TELEMETRY so it never ships in a normal release build. */}
        {DEV_TELEMETRY ? <DevTelemetryPanel pairReady={bt.pairReady} /> : null}
          </>
        )}

        {tab === "flash" && (
          <>
        <SectionLabel note="no writes — safe to spam">Firmware checks</SectionLabel>
        <Group>
          <Row
            badge="~"
            tint={theme.tint.blue}
            title="Channel probe"
            subtitle="Can the flasher reach both lenses?"
            tag="no writes"
            trace="FUT-167"
            disabled={!canAct}
            onPress={() => {
              setFlashProbe("probing… (zero writes)");
              FfsBle.flashDryRun();
            }}
          />
          <Row
            badge="✓"
            tint={theme.tint.blue}
            title="Validate canary"
            subtitle="Download + verify the canary image, write nothing"
            tag="no writes"
            divider
            disabled={!canAct}
            onPress={() => startFlash(CANARY_URL, CANARY_SHA, true)}
          />
          <Row
            badge="✓"
            tint={theme.tint.blue}
            title="Validate CFW"
            subtitle="Download + verify the full CFW image, write nothing"
            tag="no writes"
            divider
            disabled={!canAct}
            onPress={() => startFlash(CFW_URL, CFW_SHA, true)}
          />
        </Group>
        {flashProbe ? <Text style={styles.mono}>{flashProbe}</Text> : null}

        <SectionLabel note={armed ? "ARMED" : "not armed"}>Arm a real flash</SectionLabel>
        <View style={[styles.card, armed && styles.cardArmed]}>
          <Text style={styles.help}>
            Self-attested — the app does not read your battery or hold your screen awake, you do.
          </Text>
          {PRECHECK_ITEMS.map((item, i) => (
            <Pressable
              key={i}
              style={styles.checkRow}
              disabled={flashBusy}
              onPress={() =>
                setPrecheck((prev) => {
                  const next = prev.slice();
                  next[i] = !next[i];
                  return next;
                })
              }
            >
              <Text style={[styles.checkBox, precheck[i] && styles.checkBoxOn]}>
                {precheck[i] ? "☑" : "☐"}
              </Text>
              <Text style={styles.checkLabel}>{item}</Text>
            </Pressable>
          ))}
          <Text style={styles.warnText}>
            Biggest real risk is BLE dropping mid-flash — phone right next to the glasses, app
            open, the whole ~5 min. A cleanly interrupted write can brick.
          </Text>
          <Text style={styles.dangerText}>
            Type “{WARRANTY_PHRASE}” to arm{precheckDone ? "" : " (after the checks above)"}:
          </Text>
          <TextInput
            style={styles.input}
            value={warranty}
            onChangeText={setWarranty}
            placeholder={WARRANTY_PHRASE}
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <SectionLabel note={armed ? "tap to flash" : "arm above first"}>Flash images</SectionLabel>
        <Group>
          {FW_IMAGES.map((img, i) => (
            <Row
              key={img.key}
              badge={img.badge}
              tint={img.tint}
              title={img.name}
              subtitle={img.desc}
              tag="WRITES"
              tagTint={theme.danger}
              trace={img.trace}
              divider={i > 0}
              disabled={!armed || !canAct}
              onPress={() => startFlash(img.url, img.sha, false)}
            />
          ))}
        </Group>

          </>
        )}


        {tab === "log" && (
          <>
        <SectionLabel note={session || "starting…"}>Connection log</SectionLabel>
        <View style={styles.logBox}>
          {sup.log.length === 0 ? (
            <Text style={styles.dim}>no transitions yet…</Text>
          ) : (
            sup.log
              .slice()
              .reverse()
              .slice(0, 30)
              .map((e, i) => (
                <Text key={i} style={styles.logLine}>
                  {new Date(e.at).toLocaleTimeString()}  {e.health}
                  {e.note ? ` — ${e.note}` : ""}
                </Text>
              ))
          )}
        </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },

  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.surfaceAlt,
  },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: theme.text, fontSize: 20, fontWeight: "700" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.surface,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  pillText: { fontSize: 12, fontWeight: "700" },
  headerMeta: { color: theme.textDim, fontSize: 11.5, fontFamily: "Menlo", marginTop: 6 },
  headerCfw: { fontSize: 10.5, fontFamily: "Menlo", marginTop: 3, color: theme.textDim },

  tileHint: {
    color: theme.textDim,
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 10,
    minHeight: 30,
  },

  flashBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.surfaceAlt,
  },
  flashBarActive: { backgroundColor: "#1A1508" },
  flashRow: { flexDirection: "row", alignItems: "baseline" },
  flashPct: { color: theme.text, fontSize: 15, fontWeight: "800", width: 52 },
  flashMsg: { color: theme.textDim, fontSize: 12, fontFamily: "Menlo", flex: 1 },
  flashWarn: { color: theme.warn, fontSize: 11.5, marginTop: 7, lineHeight: 15 },

  micBar: {
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: "#2A1208",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.surfaceAlt,
  },
  micTitle: { color: theme.warn, fontSize: 13.5, fontWeight: "800" },
  micBody: { color: theme.textDim, fontSize: 11.5, lineHeight: 16, marginTop: 5 },
  micDismiss: { color: theme.accent, fontSize: 12, fontWeight: "700", marginTop: 8 },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 56 },

  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  cardArmed: { borderColor: theme.danger },

  btn: {
    backgroundColor: theme.accentDim,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  btnDisabled: { backgroundColor: theme.surfaceAlt, opacity: 0.5 },
  btnText: { color: theme.text, fontWeight: "600", fontSize: 14 },

  input: {
    backgroundColor: "#010409",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
    color: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 6,
    fontFamily: "Menlo",
    fontSize: 13,
  },

  checkRow: { flexDirection: "row", alignItems: "flex-start", marginTop: 10 },
  checkBox: { color: theme.textDim, fontSize: 18, marginRight: 8, lineHeight: 20 },
  checkBoxOn: { color: theme.accent },
  checkLabel: { color: theme.text, fontSize: 13, flex: 1, lineHeight: 18 },

  help: { color: theme.textDim, fontSize: 12, lineHeight: 16, marginTop: 8 },
  mono: { color: theme.textDim, fontSize: 12, fontFamily: "Menlo", marginTop: 8, lineHeight: 16 },
  warnText: { color: theme.warn, fontSize: 12, marginTop: 12, lineHeight: 16 },
  dangerText: { color: theme.danger, fontSize: 12, marginTop: 12, lineHeight: 16 },
  dim: { color: theme.textDim, fontSize: 12 },

  logBox: {
    backgroundColor: "#010409",
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  logLine: { color: theme.accent, fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
});
