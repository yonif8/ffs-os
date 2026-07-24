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
import { useEffect, useRef, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import FfsBle from "../../modules/ffs-ble";
import { theme } from "./theme";
import { initLoggerCore, glog } from "./log";
import { useFfsBluetooth } from "./useFfsBluetooth";
import { useConnectionSupervisor, healthLabel, type ConnectionHealth } from "./connection";
import { screenOwner } from "./reclaim";
import { PhoneNav, type PhoneCtx } from "./phone/nav";
import { homeScreen, textTestScreen, setTextTestContent } from "./phone/screens";
import { Group, Progress, Row, SectionLabel } from "./ui";

const APP_VERSION = "0.11.1";

// FUT-167 Stage 2 — CFW + stock-restore images (hosted on the private slsrc server, NOT
// bundled: this repo is public and the firmware is Even's copyrighted image). Downloaded
// + SHA-verified natively before any write.
const CFW_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_cfw.bin";
const CFW_SHA = "5c1539fd39c599e6035f6a8ec0779ba687c250d342a24c21a39952fed6c56aa0";
const STOCK_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_stock.bin";
const STOCK_SHA = "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa";
// FUT-167 canary — Even's EXACT stock 2.2.6.10 with ONLY the reported firmware-version
// string changed 2.2.6.10 → 2.2.6.77 (10 rodata literals, length-preserving, checksums
// recomputed; bootloader byte-identical, validate PASS). The safe FIRST real flash: if it
// boots, "Read battery + firmware version" shows 2.2.6.77 → the write→commit→reboot→readback
// loop is proven on-hardware, with a payload that is behaviorally stock. Restore Stock reverts.
const CANARY_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_canary.bin";
const CANARY_SHA = "67759cd67ed7031d7b4c8a613b8b0fe9dc9bd51c11e82260c35f5bc807159b5e";
// FUT-188 "fontpeek" — the shipped CFW + one injected READ that appends the XIP font-slot-0
// header (127 B from 0x80100000) to the sid=0x09 device-info response. After flashing, tap
// "Read battery + firmware version" and the font header shows on the firmware-L version line
// as ⟨FONT0=…hex…⟩ → gives us the s200_font.bin format ground-truth for native Hebrew. Pure
// read, no new flash-write behavior; Restore Stock reverts. Same golden-vector safety gate.
const FONTPEEK_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_fontpeek.bin";
const FONTPEEK_SHA = "70332b9822806a546e028ffb1b88b49a44593fe88236a3daa70866185acbb4f0";
// FUT-179 NATIVE HEBREW — staged flash (do these IN ORDER).
// Stage 1 (BIDI-ONLY, FUT-190): RTL reorder only, NO glyph changes. Flash this first and
// check normal English/Chinese text still renders correctly — it isolates the shared
// label-draw hook's blast radius before Hebrew is added. Hebrew won't appear yet.
const HEBREW_BIDI_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_bidi_only.bin";
const HEBREW_BIDI_SHA = "33404e1977aa7d1abaeedfb34a64f1b81e470b6ea818a1d21f61a0187ca5be1c";
// Stage 2 (FULL, FUT-189+190): bidi + Hebrew glyphs (embedded TTF via the FreeType-cache
// requester hook). This is the one that renders Hebrew, correctly ordered, system-wide.
const HEBREW_FULL_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_hebrew_full.bin";
const HEBREW_FULL_SHA = "45a481fc13b3cb864a9c6b63a4c428c248ab1f3a8ab770715b71965bad09ed5f";
// FUT-191 — Hebrew v2 + font probe: full-coverage Hebrew (gershayim/geresh/shekel/
// presentation forms; no niqqud) + a diagnostic that logs the scalable font names the
// firmware opens (read back via "Read battery + firmware version"). Supersedes the FULL
// build above. Flash this, browse the UI, then do the firmware-version read.
const HEBREW_PROBE_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_hebrew_probe.bin";
const HEBREW_PROBE_SHA = "39ea04a2964c443a1434310d929d64cf22c24ef908255f0f8d07a4b01e72cbfd";
// FUT-197 — FFS UI probe (ALWAYS-ON): Hebrew-full CFW + our OWN native-LVGL element via CFW.
// A styled rounded box AUTO-SHOWS on the home HUD (no gesture) whose child label LIVE-TICKS
// an MM:SS counter (1 Hz, driven by a firmware lv_timer armed at boot). First on-glass proof
// that our own native UI renders + live-updates firmware-side with zero phone — the de-risk
// step before owning the idle screen (FUT-195 Phase B).
const FFSUI_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_ffsui.bin";
const FFSUI_SHA = "3a673c966658216ecbb9397d65682e8131ea4465f8915c941250985f8368d8ce";
// FUT-214 — RAM-exec probe: the "flash-once, push-forever" de-risk build. After flashing,
// tap "Read battery + firmware version": the CFW runs a RAM-exec test and returns the result
// on the firmware-L line as ⟨RAMEXEC RX01 EXEC_OK ret=0x2A …⟩ (ret==0x2A => pushing native
// code into RAM and running it WORKS — green light for the resident OTA loader).
const RAMEXEC_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_ramexec.bin";
const RAMEXEC_SHA = "913a7f28cc79957ed8a5991c7434d993583070fc3d369b6c6a9e1683fd6f3f86";
// FUT-216 — resident OTA loader ("flash-once, push-forever"). Flash ONCE (inert, no seize —
// glasses behave normally) then tap Push Payload A / B to change on-glass UI OVER THE AIR with
// NO reflash. Loader status shows on the device-info read as ⟨LOADER LD01 gen=… ret=0x…⟩.
const LOADER_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_loader.bin";
// FUT-217: no gesture hooks (left touchpad); FUT-216: dispatch probe (logs service keys → svc[]).
const LOADER_SHA = "373bfe9aa3645f1cda5b0204df1db3516e16347f31dcc9a39846442022c43103";
const CFW_SERVICE = 0x90; // custom CFW loader BLE service id
// Demo payloads = "FXP1" magic + a compiled PIC blob (payload_main draws a bordered box +
// label on lv_layer_top). Pushing B after A visibly replaces A. (patches/payloads/payload_*.c)
const PAYLOAD_A_B64 =
  "RlhQMS3p8E+DsE/2v0EERsDyRAEAIIhHACgA8MqATfaDYcDyQwGIRwAoAPDGgE/ywUNC9mkKRPbTR0v2GxlP8psIwPJDA0/0lnFYIgVGwPJICsDyRwfA8kQJwPJDCJhHKEaKIWQiwEcgILhHyLMAIQFwQXCBcMFwAXFBcYFxwXEBckFygXLBcgFzQXOBc8FzAXRBdIF0wXQBdUF1gXXBdQF2QXaBdsF2AXdBd4F3wXcdIQAiBkbQRzBGKCEDItBHMEYkIf8i0EcwRiMhb/B/QtBHMEYMIQoi0EcoRjFGACLIR0nyF0vA8kkLKEbYRwAoWtAGRiAgT/AgCbhH2LMHRgAgOHB4cLhw+HA4cXhxuHH4cThyeHK4cvhyOHN4c7hz+HM4dHh0uHT4dDh1eHW4dfh1OHZ4drh2+HY4d3h3uHf4d0Ty3GDC8gcAAmgSsThGMiHQRzhGMCFv8H9C0Ec4RjEh/yLQR0v2GxMwRjlGACLA8kQDmEdPII34BABUII34BQBBII34BgCN+AeQjfgIAAAgjfgJAAvxGAIBqTBGkEcwRnYhHiLARyVgCiADsL3o8I8BIAOwvejwjwIgA7C96PCP";
const PAYLOAD_B_B64 =
  "RlhQMS3p8E+DsE/2v0EERsDyRAEAIIhHACgA8MuATfaDYcDyQwGIRwAoAPDHgE/ywUNC9mkKRPbTR0v2GxlP8psIwPJDA0/0yHGCIgVGwPJICsDyRwfA8kQJwPJDCJhHKEZYIU8iwEcgILhHyLMAIQFwQXCBcMFwAXFBcYFxwXEBckFygXLBcgFzQXOBc8FzAXRBdIF0wXQBdUF1gXXBdQF2QXaBdsF2AXdBd4F3wXcdIQAiBkbQRzBGKCEGItBHMEYkIf8i0EcwRiMhb/B/QtBHMEYMIRoi0EcoRjFGACLIR0nyF0vA8kkLKEbYRwAoW9AGRiAgT/AgCbhH2LMHRgAgOHB4cLhw+HA4cXhxuHH4cThyeHK4cvhyOHN4c7hz+HM4dHh0uHT4dDh1eHW4dfh1OHZ4drh2+HY4d3h3uHf4d0Ty3GDC8gcAAmgSsThGMiHQRzhGMCFv8H9C0Ec4RjEh/yLQR0v2GxMwRjlGACLA8kQDmEdPII34BABUII34BQBBII34BgBCII34B5CN+AgAACCN+AkAC/EYAgGpMEaQRzBGniEyIsBHJWALIAOwvejwjwEgA7C96PCPAiADsL3o8I8=";
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
    name: "OTA loader — flash once",
    desc: "Inert until used. Then push payloads over the air with no reflash.",
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

export default function App() {
  const bt = useFfsBluetooth({ autoScan: true });
  const sup = useConnectionSupervisor(bt);
  const [session, setSession] = useState<string>("");
  const [swirlOn, setSwirlOn] = useState(false);
  const [flashProbe, setFlashProbe] = useState<string>("");
  const [flashMsg, setFlashMsg] = useState<string>("");
  const [flashFrac, setFlashFrac] = useState<number>(0);
  const [flashBusy, setFlashBusy] = useState<boolean>(false);
  const [warranty, setWarranty] = useState<string>("");
  const [textTest, setTextTest] = useState<string>("");
  const [precheck, setPrecheck] = useState<boolean[]>(() => PRECHECK_ITEMS.map(() => false));

  // Live refs so the nav's context getters always read current session state.
  const btRef = useRef(bt);
  btRef.current = bt;

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
    navRef.current = new PhoneNav(homeScreen, ctx, () => screenOwner.reclaimNow());
  }

  // Off-device telemetry (FUT-144 collector).
  useEffect(() => {
    initLoggerCore({ app: "ffs-os-phone", harness: "App" });
    setSession(glog.session());
    glog.emit("os", "launcher_start", { session: glog.session(), version: APP_VERSION });
  }, []);

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
      FfsBle.addListener("onDisconnected", (e) =>
        glog.emit("drv", "disconnected", { side: e.side, reason: e.reason ?? null })),
      FfsBle.addListener("onDeviceInfo", (e) =>
        glog.emit("drv", "device_info", { batt: e.battery, chg: e.charging, l: e.leftVersion, r: e.rightVersion })),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // FUT-167 soft precheck: a real flash arms ONLY when the warranty phrase is typed
  // AND every readiness item is acknowledged. Single source of truth — both the FLASH
  // CFW and Restore Stock buttons gate on `armed`; there is no other arming path.
  const precheckDone = precheck.every(Boolean);
  const armed = warranty.trim() === WARRANTY_PHRASE && precheckDone;
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

  // Own the screen while the pair is ready: start the reclaim manager, paint the current
  // phone-OS screen, and route touchpad gestures into navigation. Tear down on disconnect.
  useEffect(() => {
    if (!bt.pairReady) return;
    const nav = navRef.current!;
    screenOwner.start();
    void screenOwner.setSurface(() => nav.paint());
    glog.emit("os", "phone_os_up", {});
    const sub = FfsBle.addListener("onGesture", (g) => {
      glog.emit("os", "nav_gesture", { gesture: g.gesture, side: g.side });
      nav.handleGesture(g.gesture);
    });
    return () => {
      sub.remove();
      screenOwner.stop();
    };
  }, [bt.pairReady]);

  // Keep the HUD status-bar clock live: re-paint the current screen at each minute
  // boundary while the pair is ready — but skip while the image screen is up (a re-paint
  // there would needlessly re-stream the bitmap). Minute-ALIGNED, 1/min (well under the
  // FUT-136 keep-alive cadence that provoked firmware evictions).
  useEffect(() => {
    if (!bt.pairReady) return;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNextMinute = () => {
      const msToNextMinute = 60_000 - (Date.now() % 60_000);
      timer = setTimeout(() => {
        const nav = navRef.current!;
        if (!nav.ownsHudSurface()) screenOwner.reclaimNow();
        scheduleNextMinute();
      }, msToNextMinute + 50);
    };
    scheduleNextMinute();
    return () => clearTimeout(timer);
  }, [bt.pairReady]);

  const health = sup.health;
  const hc = healthColor(health);
  const canAct = bt.pairReady && !flashBusy;
  const batt = bt.deviceInfo?.battery;

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
          {bt.deviceInfo?.charging ? " ⚡" : ""}  ·  v{APP_VERSION}
        </Text>
      </View>

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

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={true}
      >
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
                ? `L ${bt.deviceInfo.leftVersion ?? "?"} · R ${bt.deviceInfo.rightVersion ?? "?"}`
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

        <SectionLabel note="FUT-216 · needs the OTA loader flashed">Push over the air</SectionLabel>
        <Group>
          <Row
            badge="A"
            tint={theme.tint.amber}
            title="Push payload A"
            subtitle="Draws a bordered box + label on the HUD. No reflash."
            tag="no flash"
            disabled={!bt.pairReady}
            onPress={() => {
              glog.emit("os", "push_a", {});
              FfsBle.pushPayloadViaImage(PAYLOAD_A_B64);
            }}
          />
          <Row
            badge="B"
            tint={theme.tint.green}
            title="Push payload B"
            subtitle="Same, different content — pushing B after A visibly replaces it."
            tag="no flash"
            divider
            disabled={!bt.pairReady}
            onPress={() => {
              glog.emit("os", "push_b", {});
              FfsBle.pushPayloadViaImage(PAYLOAD_B_B64);
            }}
          />
        </Group>

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
