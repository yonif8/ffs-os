// FFS Glasses OS — thin status screen.
//
// The app is now a HEADLESS BLE BRIDGE that Claude drives over adb broadcasts (connect,
// PUSH_PAYLOAD sid 0x90, screenshot sid 0x30, flash) plus THIS thin status screen for the
// wearer. All the phone-OS UI — the on-glass launcher, calibration, dashboards, push
// probes, flash grid — is quarantined under legacy/ (see docs/APK-CLEANUP-PLAN.md). This
// file initiates NO pushes and owns no render path; it observes the kept link hooks and
// renders four status widgets. The screenshot assembler is started headlessly on mount so
// a Claude-driven fb_shot is captured whenever its frames arrive.

import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import { Component, useEffect, useState, type ReactNode } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import FfsBle from "../../modules/ffs-ble";
import { startListening as startFbShot } from "../sdk/fbshot";
import { startFfsEvents } from "./ffsEvents";
import { initLoggerCore, glog } from "./log";
import { theme } from "./theme";
import { useFfsBluetooth } from "./useFfsBluetooth";
import { useConnectionSupervisor, healthLabel, type ConnectionHealth } from "./connection";
import { Link } from "./status/Link";
import { Device, parseCfw } from "./status/Device";
import { ActivityLog } from "./status/ActivityLog";
import { MicLight, type MicAlert } from "./status/MicLight";
import { Flash } from "./status/Flash";

// Read the REAL shipped version rather than a hand-maintained copy (a hardcoded string had
// drifted three releases behind app.json, so telemetry reported the wrong build).
const APP_VERSION = (Constants.expoConfig?.version ?? "unknown") as string;

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

// Catch any render/lifecycle crash in the tree and ship it off-device (an uncaught throw
// used to vanish into a blank screen with no trace). Keeps the app alive with a fallback.
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
          <Text style={styles.crash}>FFS OS hit a render error — it was logged to the collector. Reopen the app.</Text>
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
  const bt = useFfsBluetooth({ autoScan: true });
  // Feed every connection-health transition to the collector (and thus the activity log).
  const sup = useConnectionSupervisor(bt, { onEvent: glog.conn });

  // The CFW blocks ride whichever lens answered last, so latch the last response that
  // actually carried them (dropping the latch when the link drops — a stale "CFW EXEC_OK"
  // surviving a reconnect onto stock firmware would be a false readout).
  const [cfwSeen, setCfwSeen] = useState<ReturnType<typeof parseCfw> | null>(null);
  // Sticky privacy alert: the glasses opened their own mic unprompted.
  const [micAlert, setMicAlert] = useState<MicAlert>(null);

  // Keep the fb_shot assembler armed app-wide so a Claude-driven screenshot push is
  // captured whenever its frames arrive (harmless otherwise — it only reacts to "FBSH").
  useEffect(() => startFbShot(), []);

  // Arm the inbound FFS event bus (sid 0x91) so glasses → phone events (gestures, app
  // selections, …) decode and land in the activity log the moment the CFW emits them.
  useEffect(() => startFfsEvents(), []);

  // Boot the off-device logger (session id + the loopback collector socket).
  useEffect(() => {
    initLoggerCore({ app: "ffs-os-bridge", harness: "App" });
    glog.emit("os", "bridge_start", { session: glog.session(), version: APP_VERSION });
  }, []);

  // Latch the CFW blocks from whichever lens carries them.
  useEffect(() => {
    const carrier = [bt.deviceInfo?.leftVersion, bt.deviceInfo?.rightVersion].find((v) => v?.includes("⟨"));
    if (carrier) setCfwSeen(parseCfw(carrier));
  }, [bt.deviceInfo?.leftVersion, bt.deviceInfo?.rightVersion]);

  // Drop the CFW latch when the link drops.
  useEffect(() => {
    if (!bt.pairReady) setCfwSeen(null);
  }, [bt.pairReady]);

  // Bridge telemetry → the collector (and the on-screen activity log). Telemetry-only:
  // every handler is non-throwing and glog.emit itself never throws into the app. The mic
  // handler additionally raises the sticky privacy light when WE did not open the mic.
  useEffect(() => {
    const subs = [
      FfsBle.addListener("onLog", (e) => glog.emit("drv", "log", { m: e.message })),
      FfsBle.addListener("onConnected", (e) => glog.emit("drv", "connected", { side: e.side })),
      FfsBle.addListener("onPairReady", () => glog.emit("drv", "pair_ready", {})),
      FfsBle.addListener("onStateChange", (p) => glog.emit("drv", "adapter_state", { state: p.state })),
      FfsBle.addListener("onDisconnected", (e) =>
        glog.emit("drv", "disconnected", { side: e.side, reason: e.reason ?? null, code: e.code, domain: e.domain })),
      FfsBle.addListener("onDeviceInfo", (e) =>
        glog.emit("drv", "device_info", { batt: e.battery, chg: e.charging, l: e.leftVersion, r: e.rightVersion })),
      FfsBle.addListener("onRssi", (e) => glog.emit("ble", "rssi", { side: e.side, rssi: e.rssi })),
      FfsBle.addListener("onMtu", (e) => glog.emit("ble", "mtu", { side: e.side, mtu: e.mtu })),
      FfsBle.addListener("onMicUnexpected", (e) => {
        glog.emit("ble", "mic_burst", { side: e.side, gapMs: e.gapMs, requestedByUs: e.requestedByUs });
        if (e.requestedByUs) return; // dictation we asked for never banners
        // eslint-disable-next-line no-console
        console.warn(`MIC-UNEXPECTED side=${e.side} — the glasses opened their own microphone`);
        setMicAlert((prev) => ({ side: e.side, at: Date.now(), n: (prev?.n ?? 0) + 1 }));
      }),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);

  const health = sup.health;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.title}>FFS Glasses OS</Text>
        <Text style={styles.sub}>BLE bridge · v{APP_VERSION}</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Link
          sides={bt.sides}
          pairReady={bt.pairReady}
          healthLabel={healthLabel(health)}
          healthColor={healthColor(health)}
          onConnect={() => sup.reconnect()}
          onDisconnect={() => sup.disconnect()}
        />
        <Flash />
        <Device deviceInfo={bt.deviceInfo} cfwSeen={cfwSeen} />
        <ActivityLog />
        <MicLight alert={micAlert} onDismiss={() => setMicAlert(null)} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 },
  title: { color: theme.text, fontSize: 20, fontWeight: "800", letterSpacing: 0.2 },
  sub: { color: theme.textDim, fontSize: 12, marginTop: 2, fontFamily: "Menlo" },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },
  crash: { color: theme.text, fontSize: 15, textAlign: "center", margin: 24 },
});
