// Status widget — Link.
//
// Per-lens connected dots (L ● / R ●) with live RSSI, and one Connect / Disconnect
// button. RSSI is read straight off the driver's `onRssi` heartbeat (not surfaced by the
// session hook), so this widget subscribes to it directly. Everything else comes in as
// props from the kept useFfsBluetooth / useConnectionSupervisor state.

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import FfsBle from "../../../modules/ffs-ble";
import { theme } from "../theme";
import { SectionLabel } from "../ui";

export type LinkProps = {
  sides: { L: boolean; R: boolean };
  pairReady: boolean;
  /** Health label + colour for the pill (from the supervisor). */
  healthLabel: string;
  healthColor: string;
  onConnect: () => void;
  onDisconnect: () => void;
};

export function Link({ sides, pairReady, healthLabel, healthColor, onConnect, onDisconnect }: LinkProps) {
  const [rssi, setRssi] = useState<{ L: number | null; R: number | null }>({ L: null, R: null });

  useEffect(() => {
    const sub = FfsBle.addListener("onRssi", (e) => {
      if (e.side === "L" || e.side === "R") {
        setRssi((prev) => ({ ...prev, [e.side]: e.rssi }));
      }
    });
    return () => sub.remove();
  }, []);

  // A lens that is not connected has no meaningful RSSI — clear it so a stale reading
  // can't imply a live link.
  useEffect(() => {
    setRssi((prev) => ({ L: sides.L ? prev.L : null, R: sides.R ? prev.R : null }));
  }, [sides.L, sides.R]);

  const anyUp = sides.L || sides.R;

  const Lens = ({ side, up, dbm }: { side: string; up: boolean; dbm: number | null }) => (
    <View style={s.lens}>
      <View style={[s.dot, { backgroundColor: up ? theme.accent : theme.surfaceAlt }]} />
      <Text style={s.lensLabel}>{side}</Text>
      <Text style={s.lensRssi}>{up ? (dbm == null ? "…" : `${dbm} dBm`) : "—"}</Text>
    </View>
  );

  return (
    <>
      <SectionLabel note={pairReady ? "pair ready" : anyUp ? "one lens" : "down"}>Link</SectionLabel>
      <View style={s.card}>
        <View style={s.lensRow}>
          <Lens side="L" up={sides.L} dbm={rssi.L} />
          <Lens side="R" up={sides.R} dbm={rssi.R} />
          <View style={s.pill}>
            <View style={[s.pillDot, { backgroundColor: healthColor }]} />
            <Text style={[s.pillText, { color: healthColor }]}>{healthLabel}</Text>
          </View>
        </View>
        <Pressable
          style={({ pressed }) => [s.btn, anyUp ? s.btnDrop : s.btnGo, pressed && s.btnPressed]}
          onPress={anyUp ? onDisconnect : onConnect}
        >
          <Text style={[s.btnText, { color: anyUp ? theme.text : "#06110B" }]}>
            {anyUp ? "Disconnect" : "Connect"}
          </Text>
        </Pressable>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
    padding: 12,
  },
  lensRow: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  lens: { flexDirection: "row", alignItems: "center", marginRight: 18 },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 6 },
  lensLabel: { color: theme.text, fontSize: 15, fontWeight: "800", marginRight: 6 },
  lensRssi: { color: theme.textDim, fontSize: 12, fontFamily: "Menlo" },
  pill: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
  },
  pillDot: { width: 8, height: 8, borderRadius: 4, marginRight: 5 },
  pillText: { fontSize: 11, fontWeight: "700" },
  btn: { borderRadius: 10, paddingVertical: 11, alignItems: "center" },
  btnGo: { backgroundColor: theme.accent },
  btnDrop: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.danger },
  btnPressed: { opacity: 0.7 },
  btnText: { fontSize: 14.5, fontWeight: "800" },
});
