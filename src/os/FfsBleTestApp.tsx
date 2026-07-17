// FFS Glasses OS — ffs-ble P2 on-glass TEST harness (FUT-150).
//
// A self-contained screen that exercises OUR OWN from-scratch CoreBluetooth
// driver (modules/ffs-ble) directly — NO @mentra/bluetooth-sdk anywhere, so
// there's no contention over the G2 peripherals. Install this build, put the
// glasses on, and watch our own code find + connect BOTH lenses, reach
// pairReady, and stream their notifications (tagged L/R), live, on the phone.
//
// This is a TEST entry (index.ts points here on the fut-150 branch). It is not
// the real app shell — P2 validation only.

import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import FfsBle, {
  type G2Side,
  type OnDeviceFoundEvent,
} from "../../modules/ffs-ble";
import { initLoggerCore, glog } from "./log";

type LensRow = OnDeviceFoundEvent;

/** Per-side connection view state, mirrored from native events. */
interface SideState {
  name: string | null;
  connected: boolean;
  chars: string[];
  notifies: number;
  lastNotify: string;
}

const emptySide = (): SideState => ({
  name: null,
  connected: false,
  chars: [],
  notifies: 0,
  lastNotify: "",
});

export default function FfsBleTestApp() {
  const [btState, setBtState] = useState<string>("(waiting)");
  const [devices, setDevices] = useState<Record<string, LensRow>>({});
  const [left, setLeft] = useState<SideState>(emptySide);
  const [right, setRight] = useState<SideState>(emptySide);
  const [pairReady, setPairReady] = useState(false);
  const [lastGesture, setLastGesture] = useState<string>("—");
  const [gestureCount, setGestureCount] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [session, setSession] = useState<string>("");
  const scrollRef = useRef<ScrollView>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => {
      const next = [...prev, line];
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }, []);

  // Route a per-side state mutation to the correct setter.
  const mutateSide = useCallback(
    (side: G2Side, fn: (s: SideState) => SideState) => {
      if (side === "L") setLeft(fn);
      else if (side === "R") setRight(fn);
    },
    []
  );

  useEffect(() => {
    // Ship EVERYTHING off-device to the FUT-144 collector (Rico tails it via the
    // `glasses-logs` CLI). Core init only — no mentra SDK in this test build.
    initLoggerCore({ app: "ffs-ble-p2-test", harness: "FfsBleTestApp" });
    setSession(glog.session());
    glog.emit("ffsble", "harness_start", { session: glog.session() });

    const subs = [
      FfsBle.addListener("onLog", (p) => {
        append(p.message);
        glog.emit("ffsble", "native_log", { message: p.message });
      }),
      FfsBle.addListener("onStateChange", (p) => {
        setBtState(p.state);
        append(`state → ${p.state}`);
        glog.emit("ffsble", "state", { state: p.state });
      }),
      FfsBle.addListener("onDeviceFound", (p) => {
        setDevices((prev) => ({ ...prev, [`${p.side}:${p.name}`]: p }));
        glog.emit("ffsble", "device_found", {
          name: p.name, side: p.side, rssi: p.rssi, sn: p.sn, mac: p.mac,
        });
      }),
      FfsBle.addListener("onConnected", (p) => {
        mutateSide(p.side, (s) => ({ ...s, name: p.name, connected: true }));
        append(`CONNECTED ${p.name} side=${p.side}`);
        glog.emit("ffsble", "connected", { name: p.name, side: p.side });
      }),
      FfsBle.addListener("onServicesDiscovered", (p) => {
        mutateSide(p.side, (s) => ({ ...s, chars: p.characteristics }));
        append(`[${p.side}] chars: ${p.characteristics.join(", ")}`);
        glog.emit("ffsble", "services", {
          side: p.side, characteristics: p.characteristics,
        });
      }),
      FfsBle.addListener("onPairReady", () => {
        setPairReady(true);
        append("PAIR READY — both lenses up");
        glog.emit("ffsble", "pair_ready", {});
      }),
      FfsBle.addListener("onNotify", (p) => {
        mutateSide(p.side, (s) => ({
          ...s,
          notifies: s.notifies + 1,
          lastNotify: `${p.characteristic.slice(-4)} (${p.base64.length} b64)`,
        }));
        glog.emit("ffsble", "notify", {
          characteristic: p.characteristic, side: p.side,
          bytesB64: p.base64.length, base64: p.base64,
        });
      }),
      FfsBle.addListener("onGesture", (p) => {
        setLastGesture(`${p.gesture} (${p.side})`);
        setGestureCount((n) => n + 1);
        append(`👆 GESTURE: ${p.gesture} [${p.side}]`);
        glog.emit("ffsble", "gesture", { gesture: p.gesture, side: p.side });
      }),
      FfsBle.addListener("onDisconnected", (p) => {
        // Only THIS side tears down; the other lens is untouched.
        mutateSide(p.side, () => emptySide());
        setPairReady(false);
        append(`DISCONNECTED ${p.name} side=${p.side}${p.reason ? ` (${p.reason})` : ""}`);
        glog.emit("ffsble", "disconnected", {
          name: p.name, side: p.side, reason: p.reason,
        });
      }),
    ];
    // Kick off a scan immediately.
    append("=== ffs-ble P2 dual-radio test harness ===");
    FfsBle.startScan();
    return () => {
      subs.forEach((s) => s.remove());
      FfsBle.stopScan();
    };
  }, [append, mutateSide]);

  const deviceList = Object.values(devices);

  const renderSide = (label: string, s: SideState) => (
    <View style={styles.sideCol}>
      <Text style={styles.sideLabel}>{label}</Text>
      <Text style={[styles.sideState, s.connected ? styles.ok : styles.dim]}>
        {s.connected ? "connected" : "—"}
      </Text>
      <Text style={styles.dim} numberOfLines={1}>
        {s.name ?? "no lens"}
      </Text>
      <Text style={styles.dim}>
        chars {s.chars.length ? s.chars.map((c) => c.slice(-4)).join("·") : "—"}
      </Text>
      <Text style={styles.dim}>
        notif {s.notifies}
        {s.lastNotify ? ` (${s.lastNotify})` : ""}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <Text style={styles.title}>ffs-ble — P2 dual-radio test</Text>
      <Text style={styles.sub}>our own CoreBluetooth stack · no mentra</Text>
      <Text style={styles.sub}>log session: {session || "(starting)"}</Text>

      <View style={styles.card}>
        <Text style={styles.row}>
          <Text style={styles.k}>Bluetooth: </Text>
          <Text style={styles.v}>{btState}</Text>
        </Text>
        <Text style={styles.row}>
          <Text style={styles.k}>Pair ready: </Text>
          <Text style={[styles.v, pairReady ? styles.ok : styles.dim]}>
            {pairReady ? "YES — both lenses up" : "no"}
          </Text>
        </Text>
        <Text style={styles.row}>
          <Text style={styles.k}>Last gesture: </Text>
          <Text style={[styles.v, gestureCount > 0 ? styles.ok : styles.dim]}>
            {lastGesture} {gestureCount > 0 ? `(#${gestureCount})` : ""}
          </Text>
        </Text>
        <View style={styles.sideRow}>
          {renderSide("LEFT", left)}
          {renderSide("RIGHT", right)}
        </View>
      </View>

      <Text style={styles.section}>Discovered lenses ({deviceList.length})</Text>
      <View style={styles.card}>
        {deviceList.length === 0 ? (
          <Text style={styles.dim}>scanning…</Text>
        ) : (
          deviceList.map((d) => (
            <Pressable
              key={`${d.side}:${d.name}`}
              style={styles.lens}
              onPress={() => {
                if (d.side === "L" || d.side === "R") {
                  append(`connectSide → ${d.side} (${d.name})`);
                  FfsBle.connectSide(d.side);
                }
              }}
            >
              <Text style={styles.v}>
                {d.side} · {d.name}  rssi {d.rssi}
              </Text>
              <Text style={styles.dim}>
                sn {d.sn ?? "?"}   mac {d.mac ?? "?"}
              </Text>
            </Pressable>
          ))
        )}
      </View>

      <View style={styles.btnRow}>
        <Pressable style={styles.btn} onPress={() => FfsBle.connect()}>
          <Text style={styles.btnText}>Connect pair</Text>
        </Pressable>
        <Pressable
          style={styles.btn}
          onPress={() => {
            FfsBle.disconnect();
          }}
        >
          <Text style={styles.btnText}>Disconnect</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => FfsBle.startScan()}>
          <Text style={styles.btnText}>Rescan</Text>
        </Pressable>
      </View>

      <View style={styles.btnRow}>
        <Pressable
          style={[styles.btn, !pairReady && styles.btnDisabled]}
          disabled={!pairReady}
          onPress={() => {
            append("showText → auth + first pixel");
            FfsBle.showText("Hello from\nFFS Glasses OS");
          }}
        >
          <Text style={styles.btnText}>
            {pairReady ? "Show text on HUD (P3)" : "Show text — pair not ready"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.btnRow}>
        <Pressable
          style={[styles.btn, !pairReady && styles.btnDisabled]}
          disabled={!pairReady}
          onPress={() => {
            append("showImage → image container + fragments");
            FfsBle.showImage();
          }}
        >
          <Text style={styles.btnText}>
            {pairReady ? "Show image on HUD (P4)" : "Show image — pair not ready"}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Live log</Text>
      <ScrollView
        ref={scrollRef}
        style={styles.logBox}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {log.map((l, i) => (
          <Text key={i} style={styles.logLine}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0f14", paddingHorizontal: 14 },
  title: { color: "#e6edf3", fontSize: 20, fontWeight: "700", marginTop: 8 },
  sub: { color: "#7d8590", fontSize: 12, marginBottom: 10 },
  card: {
    backgroundColor: "#11161c",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1f2630",
  },
  row: { marginBottom: 4, fontSize: 14 },
  k: { color: "#7d8590" },
  v: { color: "#e6edf3", fontFamily: "Menlo" },
  ok: { color: "#3fb950" },
  dim: { color: "#7d8590", fontSize: 12 },
  section: { color: "#7d8590", fontSize: 12, marginBottom: 6, marginTop: 2 },
  sideRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  sideCol: {
    flex: 1,
    backgroundColor: "#0b1017",
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: "#1f2630",
  },
  sideLabel: { color: "#e6edf3", fontWeight: "700", fontSize: 12, marginBottom: 2 },
  sideState: { fontFamily: "Menlo", fontSize: 13, marginBottom: 2 },
  lens: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#1f2630",
  },
  btnRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  btn: {
    flex: 1,
    backgroundColor: "#1f6feb",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  btnDisabled: { backgroundColor: "#1f2630" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  logBox: {
    flex: 1,
    backgroundColor: "#010409",
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1f2630",
  },
  logLine: { color: "#7ee787", fontFamily: "Menlo", fontSize: 10, lineHeight: 14 },
});
