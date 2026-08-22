// Status widget — ActivityLog.
//
// A live tail of bridge events. Reads the SAME glog stream that ships to the loopback
// collector (ws://127.0.0.1:8795), via the in-memory tap in log.ts — no second pipe, and
// the collector transport is untouched. Newest last, capped for a phone screen.

import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { subscribeLogTail, type LogTailRecord } from "../log";
import { theme } from "../theme";
import { SectionLabel } from "../ui";

const SHOWN = 40;

function clock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Category → colour, so a link drop reads differently from a routine push at a glance.
function catColor(cat: string): string {
  switch (cat) {
    case "conn":
    case "lifecycle":
      return theme.tint.blue;
    case "ble":
      return theme.tint.purple;
    case "error":
    case "glog":
      return theme.danger;
    case "os":
    case "drv":
      return theme.accent;
    default:
      return theme.textDim;
  }
}

export function ActivityLog() {
  const [recs, setRecs] = useState<LogTailRecord[]>([]);

  useEffect(() => subscribeLogTail((all) => setRecs(all.slice(-SHOWN))), []);

  return (
    <>
      <SectionLabel note="live · glog">Activity log</SectionLabel>
      <View style={s.card}>
        {recs.length === 0 ? (
          <Text style={s.empty}>No events yet.</Text>
        ) : (
          <ScrollView style={s.scroll} nestedScrollEnabled>
            {recs.map((r, i) => (
              <View key={i} style={s.line}>
                <Text style={s.time}>{clock(r.t)}</Text>
                <Text style={[s.cat, { color: catColor(r.cat) }]} numberOfLines={1}>
                  {r.cat}
                </Text>
                <Text style={s.event} numberOfLines={1}>
                  {r.event}
                </Text>
              </View>
            ))}
          </ScrollView>
        )}
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
    padding: 10,
  },
  scroll: { maxHeight: 220 },
  line: { flexDirection: "row", alignItems: "baseline", paddingVertical: 2 },
  time: { color: theme.textDim, fontSize: 10, fontFamily: "Menlo", width: 62 },
  cat: { fontSize: 10, fontWeight: "800", fontFamily: "Menlo", width: 62 },
  event: { color: theme.text, fontSize: 11, fontFamily: "Menlo", flex: 1 },
  empty: { color: theme.textDim, fontSize: 12.5, paddingVertical: 8 },
});
