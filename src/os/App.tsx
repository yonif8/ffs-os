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

const APP_VERSION = "0.10.20";

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
const FFSUI_SHA = "cfff880a93035343ad20002aea0924221c455dff5809c2315075268f8a8613a5";
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

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={true}
      >
      <Text style={styles.title}>FFS Glasses OS</Text>
      <Text style={styles.sub}>phone OS on the HUD · drive it with the touchpad</Text>
      <Text style={styles.sub}>v{APP_VERSION} · log {session || "(starting)"}</Text>

      <View style={styles.card}>
        <View style={styles.pillRow}>
          <View style={[styles.dot, { backgroundColor: healthColor(health) }]} />
          <Text style={[styles.pillText, { color: healthColor(health) }]}>{healthLabel(health)}</Text>
        </View>
        <Text style={styles.meta}>
          L {bt.sides.L ? "●" : "○"}   R {bt.sides.R ? "●" : "○"}   pair {bt.pairReady ? "ready" : "—"}
        </Text>
        {bt.lastGesture && (
          <Text style={styles.meta}>
            last gesture: {bt.lastGesture.gesture} ({bt.lastGesture.side})
          </Text>
        )}
      </View>

      <Text style={styles.section}>Drive on-glass</Text>
      <View style={styles.card}>
        <Text style={styles.help}>swipe up/down — move    tap — open    double-tap — back</Text>
      </View>

      <View style={styles.btnRow}>
        <Pressable style={styles.btn} onPress={() => sup.reconnect()}>
          <Text style={styles.btnText}>Connect</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnAlt]} onPress={() => sup.disconnect()}>
          <Text style={styles.btnText}>Disconnect</Text>
        </Pressable>
      </View>

      <View style={styles.btnRow}>
        <Pressable
          style={[styles.btn, !bt.pairReady && styles.btnDisabled]}
          disabled={!bt.pairReady}
          onPress={() => navRef.current?.goHome()}
        >
          <Text style={styles.btnText}>Home</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt, !bt.pairReady && styles.btnDisabled]}
          disabled={!bt.pairReady}
          onPress={() => {
            const nav = navRef.current;
            if (nav?.back()) screenOwner.reclaimNow();
          }}
        >
          <Text style={styles.btnText}>Back</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt, !bt.pairReady && styles.btnDisabled]}
          disabled={!bt.pairReady}
          onPress={() => {
            const next = !swirlOn;
            setSwirlOn(next);
            glog.emit("os", "ai_swirl", { on: next });
            FfsBle.showAiSwirl(next);
          }}
        >
          <Text style={styles.btnText}>{swirlOn ? "Swirl ■" : "Swirl ▶"}</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Device info — battery + firmware (FUT-169)</Text>
      <View style={styles.card}>
        <Pressable
          style={[styles.btn, (!bt.pairReady || flashBusy) && styles.btnDisabled]}
          disabled={!bt.pairReady || flashBusy}
          onPress={() => bt.requestDeviceInfo()}
        >
          <Text style={styles.btnText}>Read battery + firmware version</Text>
        </Pressable>
        {bt.deviceInfo ? (
          <>
            <Text style={[styles.meta, { marginTop: 8 }]}>
              battery: {bt.deviceInfo.battery == null ? "?" : `${bt.deviceInfo.battery}%`}
              {bt.deviceInfo.charging == null ? "" : bt.deviceInfo.charging ? "  ⚡ charging" : "  (not charging)"}
            </Text>
            <Text style={styles.meta}>firmware L: {bt.deviceInfo.leftVersion ?? "?"}</Text>
            <Text style={styles.meta}>firmware R: {bt.deviceInfo.rightVersion ?? "?"}</Text>
          </>
        ) : (
          <Text style={[styles.meta, { marginTop: 8 }]}>
            {bt.pairReady ? "not read yet — tap above (auto-reads ~2s after connect)" : "connect both lenses first"}
          </Text>
        )}
      </View>

      <Text style={styles.section}>Text test — Hebrew/English scroll (FUT-191)</Text>
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
          style={[styles.btn, { marginTop: 8 }, (!bt.pairReady || flashBusy || !textTest.trim()) && styles.btnDisabled]}
          disabled={!bt.pairReady || flashBusy || !textTest.trim()}
          onPress={() => {
            setTextTestContent(textTest);
            navRef.current?.openScreen(textTestScreen);
            screenOwner.reclaimNow();
          }}
        >
          <Text style={styles.btnText}>Send to glasses → Text test</Text>
        </Pressable>
        <Text style={[styles.meta, { marginTop: 6 }]}>
          On the glasses: swipe up/down to scroll, double-tap to exit. Also reachable from the on-glass menu (Home → Text test).
        </Text>
      </View>

      <Text style={styles.section}>Firmware — CFW flasher (FUT-167)</Text>
      <View style={styles.card}>
        <View style={styles.btnRow}>
          <Pressable
            style={[styles.btn, styles.btnAlt, (!bt.pairReady || flashBusy) && styles.btnDisabled]}
            disabled={!bt.pairReady || flashBusy}
            onPress={() => {
              setFlashProbe("probing… (zero writes)");
              FfsBle.flashDryRun();
            }}
          >
            <Text style={styles.btnText}>Channel probe</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, (!bt.pairReady || flashBusy) && styles.btnDisabled]}
            disabled={!bt.pairReady || flashBusy}
            onPress={() => startFlash(CANARY_URL, CANARY_SHA, true)}
          >
            <Text style={styles.btnText}>Validate CANARY (no writes)</Text>
          </Pressable>
        </View>
        <Pressable
          style={[styles.btn, styles.btnAlt, (!bt.pairReady || flashBusy) && styles.btnDisabled, { marginTop: 2 }]}
          disabled={!bt.pairReady || flashBusy}
          onPress={() => startFlash(CFW_URL, CFW_SHA, true)}
        >
          <Text style={styles.btnText}>Validate CFW (no writes)</Text>
        </Pressable>
        {flashProbe ? <Text style={styles.meta}>{flashProbe}</Text> : null}
        {flashMsg ? (
          <Text style={[styles.meta, { marginTop: 6 }]}>
            {flashBusy ? "⏳ " : ""}
            {Math.round(flashFrac * 100)}% — {flashMsg}
          </Text>
        ) : null}

        <Text style={[styles.meta, { marginTop: 14, color: theme.text }]}>
          Readiness check — confirm each before arming (self-attested; the app does not
          read battery or hold your screen awake — you do):
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
        <Text style={[styles.meta, { marginTop: 8, color: theme.warn }]}>
          Biggest real risk is BLE dropping mid-flash — keep the phone right next to the
          glasses and the app open the whole ~5 min. A clean interrupted write can brick.
        </Text>

        <Text style={[styles.meta, { marginTop: 12, color: theme.danger }]}>
          Real flash voids warranty + can brick. Type "{WARRANTY_PHRASE}" to arm{precheckDone ? "" : " (after the checks above)"}:
        </Text>
        <TextInput
          style={styles.input}
          value={warranty}
          onChangeText={setWarranty}
          placeholder="my warranty is void"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          style={[styles.btn, { backgroundColor: theme.accent, marginBottom: 10 }, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
          disabled={!armed || !bt.pairReady || flashBusy}
          onPress={() => startFlash(CANARY_URL, CANARY_SHA, false)}
        >
          <Text style={styles.btnText}>⚑ Flash CANARY (stock+marker → 2.2.6.77) — do this first</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.accent, marginBottom: 10 }, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
          disabled={!armed || !bt.pairReady || flashBusy}
          onPress={() => startFlash(FONTPEEK_URL, FONTPEEK_SHA, false)}
        >
          <Text style={styles.btnText}>🔤 Flash FONT-PEEK CFW (reads font, then tap “Read … firmware version”)</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.accent, marginBottom: 10 }, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
          disabled={!armed || !bt.pairReady || flashBusy}
          onPress={() => startFlash(HEBREW_BIDI_URL, HEBREW_BIDI_SHA, false)}
        >
          <Text style={styles.btnText}>🇮🇱 Hebrew ① Flash BIDI-ONLY (check English/Chinese still OK)</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.accent, marginBottom: 10 }, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
          disabled={!armed || !bt.pairReady || flashBusy}
          onPress={() => startFlash(HEBREW_FULL_URL, HEBREW_FULL_SHA, false)}
        >
          <Text style={styles.btnText}>🇮🇱 Hebrew ② Flash FULL (bidi + glyphs → Hebrew renders)</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.accent, marginBottom: 10 }, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
          disabled={!armed || !bt.pairReady || flashBusy}
          onPress={() => startFlash(HEBREW_PROBE_URL, HEBREW_PROBE_SHA, false)}
        >
          <Text style={styles.btnText}>🇮🇱 Hebrew v2 + PROBE (full glyphs; browse UI → tap “Read … firmware version”)</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.accent, marginBottom: 10 }, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
          disabled={!armed || !bt.pairReady || flashBusy}
          onPress={() => startFlash(FFSUI_URL, FFSUI_SHA, false)}
        >
          <Text style={styles.btnText}>🟢 FFS UI probe (always-on: our box auto-shows on the HUD with a live MM:SS ticker)</Text>
        </Pressable>
        <View style={styles.btnRow}>
          <Pressable
            style={[styles.btn, { backgroundColor: theme.danger }, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
            disabled={!armed || !bt.pairReady || flashBusy}
            onPress={() => startFlash(CFW_URL, CFW_SHA, false)}
          >
            <Text style={styles.btnText}>⚠️ FLASH CFW</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnAlt, (!armed || !bt.pairReady || flashBusy) && styles.btnDisabled]}
            disabled={!armed || !bt.pairReady || flashBusy}
            onPress={() => startFlash(STOCK_URL, STOCK_SHA, false)}
          >
            <Text style={styles.btnText}>Restore Stock</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.section}>Connection log</Text>
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
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 48 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700", marginTop: 10 },
  sub: { color: theme.textDim, fontSize: 12, marginBottom: 4 },
  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 14,
    marginTop: 6,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  pillRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  pillText: { fontSize: 16, fontWeight: "700" },
  meta: { color: theme.textDim, fontSize: 13, fontFamily: "Menlo", marginTop: 2 },
  help: { color: theme.text, fontSize: 12, fontFamily: "Menlo" },
  btnRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  btn: {
    flex: 1,
    backgroundColor: theme.accentDim,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  btnAlt: { backgroundColor: theme.surfaceAlt },
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
    marginBottom: 8,
    fontFamily: "Menlo",
    fontSize: 13,
  },
  checkRow: { flexDirection: "row", alignItems: "flex-start", marginTop: 8 },
  checkBox: { color: theme.textDim, fontSize: 18, marginRight: 8, lineHeight: 20 },
  checkBoxOn: { color: theme.accent },
  checkLabel: { color: theme.text, fontSize: 13, flex: 1, lineHeight: 18 },
  section: { color: theme.textDim, fontSize: 12, marginBottom: 6, marginTop: 4 },
  dim: { color: theme.textDim, fontSize: 12 },
  logBox: {
    backgroundColor: "#010409",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  logLine: { color: theme.accent, fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
});
