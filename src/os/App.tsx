// FFS Glasses OS — launcher / home shell (FUT-163, Phase 1).
//
// The real app entry (index.ts points here), replacing the raw ffs-ble test harness.
// It wires our OWN stack end-to-end with NO @mentra anywhere:
//   useFfsBluetooth (driver session) → useConnectionSupervisor (health + reclaim-on-ready)
//   → screenOwner (paints the home surface on the HUD via hud.ts → FfsBle.showText).
//
// Minimal by design (parity, not a redesign — council, FUT-163): connect the pair,
// show a live health readout, push the OS home screen to the HUD when ready, and offer
// the P4 image demo. No Rico app here — that stays in the legacy repo.

import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import FfsBle from "../../modules/ffs-ble";
import { theme } from "./theme";
import { initLoggerCore, glog } from "./log";
import { useFfsBluetooth } from "./useFfsBluetooth";
import { useConnectionSupervisor, healthLabel, type ConnectionHealth } from "./connection";
import { screenOwner } from "./reclaim";
import { hudHome } from "./hud";

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

  // Off-device telemetry (FUT-144 collector).
  useEffect(() => {
    initLoggerCore({ app: "ffs-os-launcher", harness: "App" });
    setSession(glog.session());
    glog.emit("os", "launcher_start", { session: glog.session() });
  }, []);

  // Own the screen while the pair is ready: start the reclaim manager and paint the
  // OS home surface. Tear down when the link drops so we don't paint into a dead link.
  useEffect(() => {
    if (bt.pairReady) {
      screenOwner.start();
      void screenOwner.setSurface(() => hudHome());
      glog.emit("os", "home_surface_set", {});
      return () => screenOwner.stop();
    }
    return;
  }, [bt.pairReady]);

  const health = sup.health;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <Text style={styles.title}>FFS Glasses OS</Text>
      <Text style={styles.sub}>our own OS · our own driver · no mentra</Text>
      <Text style={styles.sub}>log session: {session || "(starting)"}</Text>

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
          onPress={() => {
            glog.emit("os", "home_repaint", {});
            void screenOwner.setSurface(() => hudHome());
          }}
        >
          <Text style={styles.btnText}>{bt.pairReady ? "Push home to HUD" : "HUD — pair not ready"}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt, !bt.pairReady && styles.btnDisabled]}
          disabled={!bt.pairReady}
          onPress={() => {
            glog.emit("os", "show_image", {});
            FfsBle.showImage();
          }}
        >
          <Text style={styles.btnText}>Show image (P4)</Text>
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
  sub: { color: theme.textDim, fontSize: 12, marginBottom: 8 },
  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 14,
    marginTop: 6,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  pillRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  pillText: { fontSize: 16, fontWeight: "700" },
  meta: { color: theme.textDim, fontSize: 13, fontFamily: "Menlo", marginTop: 2 },
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
