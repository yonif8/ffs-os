// FFS Glasses OS — phone-side UI primitives (FUT-220).
//
// Extracted so App.tsx stops copy-pasting Pressables. The control surface is a DENSE
// single page by design (Yoni: "keep every probe/debug control visible, optimise for
// speed not safety") — so the job of these primitives is SCANNABILITY, not hiding.
//
// Grounded in real shipped patterns (Mobbin, FUT-220):
//   • Group/Row  — Google TV + Phantom settings: grouped rounded cards, each row a
//                  coloured icon tile + title + dim subtitle + right-aligned status tag.
//                  Colour-per-row is what makes many similar items separable at a glance.
//   • Progress   — Meta AI's "Updating your glasses" + IKEA/Fitbit device-update screens:
//                  a real bar with percent, never a bare line of text.

import { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "./theme";

// ── Section label above a group ──────────────────────────────────────────────
export function SectionLabel({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <View style={s.sectionRow}>
      <Text style={s.section}>{children}</Text>
      {note ? <Text style={s.sectionNote}>{note}</Text> : null}
    </View>
  );
}

// ── Grouped card. Children are Rows; separators are drawn between them. ───────
export function Group({ children }: { children: ReactNode }) {
  return <View style={s.group}>{children}</View>;
}

export type RowProps = {
  /** 1-3 chars shown in the coloured tile — the glanceable identity of the row. */
  badge: string;
  /** Tile colour. Group by family so related images read as a set. */
  tint: string;
  title: string;
  subtitle?: string;
  /** Right-aligned status, e.g. "WRITES" / "no writes". */
  tag?: string;
  /** Tag colour; defaults to dim. */
  tagTint?: string;
  /** Small dim trace tag (e.g. "FUT-216") — useful to Yoni, must not shout. */
  trace?: string;
  disabled?: boolean;
  onPress?: () => void;
  /** Draw a hairline above this row (set on every row but the first in a Group). */
  divider?: boolean;
};

export function Row({
  badge,
  tint,
  title,
  subtitle,
  tag,
  tagTint,
  trace,
  disabled,
  onPress,
  divider,
}: RowProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        s.row,
        divider && s.rowDivider,
        disabled && s.rowDisabled,
        pressed && !disabled && s.rowPressed,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <View style={[s.badge, { backgroundColor: tint }]}>
        <Text style={s.badgeText} numberOfLines={1}>
          {badge}
        </Text>
      </View>
      <View style={s.rowBody}>
        <Text style={s.rowTitle}>{title}</Text>
        {subtitle ? <Text style={s.rowSub}>{subtitle}</Text> : null}
      </View>
      <View style={s.rowRight}>
        {tag ? <Text style={[s.tag, tagTint ? { color: tagTint } : null]}>{tag}</Text> : null}
        {trace ? <Text style={s.trace}>{trace}</Text> : null}
      </View>
    </Pressable>
  );
}

// ── Progress bar (Meta AI / IKEA / Fitbit device-update pattern) ──────────────
export function Progress({ frac, tint = theme.accent }: { frac: number; tint?: string }) {
  const pct = Math.max(0, Math.min(1, frac));
  return (
    <View style={s.track}>
      <View style={[s.fill, { width: `${pct * 100}%`, backgroundColor: tint }]} />
    </View>
  );
}

const s = StyleSheet.create({
  sectionRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  section: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  sectionNote: { color: theme.textDim, fontSize: 11 },

  group: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
    overflow: "hidden",
  },

  row: { flexDirection: "row", alignItems: "center", paddingVertical: 11, paddingHorizontal: 12 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.surfaceAlt },
  rowDisabled: { opacity: 0.38 },
  rowPressed: { backgroundColor: theme.surfaceAlt },

  badge: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 11,
  },
  badgeText: { color: "#06110B", fontSize: 12, fontWeight: "800" },

  rowBody: { flex: 1, paddingRight: 8 },
  rowTitle: { color: theme.text, fontSize: 14.5, fontWeight: "600" },
  rowSub: { color: theme.textDim, fontSize: 11.5, marginTop: 2, lineHeight: 15 },

  rowRight: { alignItems: "flex-end" },
  tag: { color: theme.textDim, fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  trace: { color: theme.textDim, fontSize: 9, opacity: 0.55, marginTop: 3, fontFamily: "Menlo" },

  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.surfaceAlt,
    overflow: "hidden",
    marginTop: 8,
  },
  fill: { height: 6, borderRadius: 3 },
});
