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
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import FfsBle from "../../modules/ffs-ble";
import { theme } from "./theme";
import { initLoggerCore, glog } from "./log";
import { useFfsBluetooth } from "./useFfsBluetooth";
import { useConnectionSupervisor, healthLabel, type ConnectionHealth } from "./connection";
import { screenOwner } from "./reclaim";
import { PhoneNav, type PhoneCtx } from "./phone/nav";
import { homeScreen } from "./phone/screens";

const APP_VERSION = "0.10.6";

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
      battery: () => 82,
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
        if (!nav.onImageScreen()) screenOwner.reclaimNow();
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

      <Text style={styles.section}>Connection log</Text>
      <ScrollView style={styles.logBox}>
        {sup.log.length === 0 ? (
          <Text style={styles.dim}>no transitions yet…</Text>
        ) : (
          sup.log
            .slice()
            .reverse()
            .map((e, i) => (
              <Text key={i} style={styles.logLine}>
                {new Date(e.at).toLocaleTimeString()}  {e.health}
                {e.note ? ` — ${e.note}` : ""}
              </Text>
            ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 16 },
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
  section: { color: theme.textDim, fontSize: 12, marginBottom: 6, marginTop: 4 },
  dim: { color: theme.textDim, fontSize: 12 },
  logBox: {
    flex: 1,
    backgroundColor: "#010409",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  logLine: { color: theme.accent, fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
});
