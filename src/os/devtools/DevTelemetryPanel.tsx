// DevTelemetryPanel — live on-glass diagnostics (dev-only). Renders the Carrier-A/B telemetry
// feed: memory / active page / VM error / lens, refreshing on a timer, with a pool_free trend so
// the OOM/fragmentation early-warning is watchable rather than a single snapshot.
//
// Gated behind a dev flag by the caller (App.tsx). Pushes the same guarded diagnostic payload the
// hook owns; no camera, no flash.

import { StyleSheet, Text, View } from "react-native";

import { theme } from "../theme";
import { Group, Row, SectionLabel } from "../ui";
import { useTelemetry, type TelemetryReading } from "./useTelemetry";

export type DevTelemetryPanelProps = {
  /** Both lenses linked. Gates the push/query controls. */
  pairReady: boolean;
  /** How often to poll, ms (default 4000). */
  intervalMs?: number;
};

function poolTrend(history: TelemetryReading[]): { cur: number; min: number; max: number; spark: string } {
  const vals = history.map((r) => r.t.pool_free_kb);
  if (!vals.length) return { cur: 0, min: 0, max: 0, spark: "" };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const bars = "▁▂▃▄▅▆▇█";
  const span = Math.max(1, max - min);
  const spark = vals
    .slice(-32)
    .map((v) => bars[Math.min(bars.length - 1, Math.floor(((v - min) / span) * (bars.length - 1)))])
    .join("");
  return { cur: vals[vals.length - 1], min, max, spark };
}

function fmt(r: TelemetryReading | null): string {
  if (!r) return "—";
  const t = r.t;
  const vm = t.vm_present ? t.labels.vmStatus : "no VM";
  const rej = t.source === "A" && !t.vm_present && t.rej_code === 0 ? "" : ` · rej=${t.labels.rejCode}`;
  return (
    `pool=${t.pool_free_kb}KB · page=${t.labels.active} · vm=${vm}` +
    rej +
    ` · lens=${t.labels.lens} · [${t.source}]`
  );
}

export function DevTelemetryPanel({ pairReady, intervalMs }: DevTelemetryPanelProps) {
  const feed = useTelemetry({ enabled: true, pairReady, intervalMs });
  const trend = poolTrend(feed.history);
  const latest = feed.latest;

  return (
    <>
      <SectionLabel note="dev · no flash · tag 0x7D">On-glass telemetry</SectionLabel>

      <Text style={styles.headline}>{fmt(latest)}</Text>
      {latest?.t.source === "A" ? (
        <Text style={styles.raw}>ret=0x{latest.t.lastRet.toString(16).padStart(8, "0").toUpperCase()}</Text>
      ) : null}

      <View style={styles.trendCard}>
        <Text style={styles.trendLabel}>
          Pool A largest block — cur {trend.cur}KB · min {trend.min} · max {trend.max}
        </Text>
        <Text style={styles.spark}>{trend.spark || "(waiting for first read…)"}</Text>
        <Text style={styles.hint}>
          watch this trend DOWN across pushes — a falling largest-block is the OOM/fragmentation
          early-warning (a KEEP push or an IMAGE slot strands pool). polls: {feed.polls}
        </Text>
      </View>

      {/* Per-lens: readings separate by their OWN lens stamp, not by whichever lens the BLE layer
          let answer. A left-labelled row here IS the on-glass proof the per-lens path works. */}
      <SectionLabel note="self-reported lens stamp">Per lens</SectionLabel>
      <View style={styles.lensRow}>
        <View style={styles.lensCell}>
          <Text style={styles.lensTitle}>RIGHT ({feed.byLens.right.length})</Text>
          <Text style={styles.lensVal}>{fmt(feed.byLens.right[feed.byLens.right.length - 1] ?? null)}</Text>
        </View>
        <View style={styles.lensCell}>
          <Text style={styles.lensTitle}>LEFT ({feed.byLens.left.length})</Text>
          <Text style={styles.lensVal}>
            {feed.byLens.left.length
              ? fmt(feed.byLens.left[feed.byLens.left.length - 1])
              : "no reply — see §6 (left is silent on async; [M])"}
          </Text>
        </View>
      </View>

      <Group>
        <Row
          badge="↻"
          tint={theme.tint.green}
          title="Refresh now"
          subtitle="push the 0x7D probe + request device info"
          tag={pairReady ? "live" : "no link"}
          tagTint={pairReady ? theme.tint.green : theme.danger}
          disabled={!pairReady}
          onPress={feed.refresh}
        />
        <Row
          badge="◑"
          tint={theme.tint.blue}
          title="Probe LEFT lens (experimental)"
          subtitle="per-lens device-info query — tests whether the left lens answers at all"
          divider
          disabled={!pairReady}
          onPress={() => feed.probeLens("L")}
        />
        <Row
          badge="◐"
          tint={theme.tint.blue}
          title="Probe RIGHT lens"
          subtitle="per-lens device-info query"
          divider
          disabled={!pairReady}
          onPress={() => feed.probeLens("R")}
        />
        <Row
          badge="⌫"
          tint={theme.tint.grey}
          title="Clear history"
          subtitle={`${feed.history.length} readings buffered`}
          divider
          onPress={feed.clear}
        />
      </Group>

      {/* Recent tail — newest first, so a change is visible at the top. */}
      <SectionLabel>Recent</SectionLabel>
      {feed.history.length ? (
        feed.history
          .slice(-8)
          .reverse()
          .map((r, i) => (
            <Text key={feed.history.length - i} style={styles.tail}>
              {new Date(r.at).toLocaleTimeString()} · {fmt(r)}
            </Text>
          ))
      ) : (
        <Text style={styles.tail}>no readings yet — connect both lenses and Refresh.</Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headline: { color: theme.text, fontSize: 12.5, lineHeight: 18, marginBottom: 2, fontFamily: "monospace" },
  raw: { color: theme.textDim, fontSize: 11, marginBottom: 8, fontFamily: "monospace" },
  trendCard: { backgroundColor: theme.surface, borderRadius: 8, padding: 10, marginBottom: 8 },
  trendLabel: { color: theme.text, fontSize: 12, marginBottom: 4 },
  spark: { color: theme.tint.green, fontSize: 16, fontFamily: "monospace", letterSpacing: 1 },
  hint: { color: theme.textDim, fontSize: 10.5, lineHeight: 15, marginTop: 6 },
  lensRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  lensCell: { flex: 1, backgroundColor: theme.surface, borderRadius: 8, padding: 8 },
  lensTitle: { color: theme.text, fontSize: 11, fontWeight: "600", marginBottom: 3 },
  lensVal: { color: theme.textDim, fontSize: 10.5, lineHeight: 15, fontFamily: "monospace" },
  tail: { color: theme.textDim, fontSize: 10.5, lineHeight: 16, fontFamily: "monospace" },
});
