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

// ── Tab bar ───────────────────────────────────────────────────────────────────
//
// The control surface used to be ONE ~7,400 px scroll: every probe of every category,
// each a 74 px two-line row. That layout had two costs that only show up in use --
// the thing you read most (the device-info readout carrying CAPS/RAMEXEC/LOADER) sat
// buried in a row subtitle halfway down, and running an experiment meant scrolling
// past forty unrelated rows between the push and the log. Tabs put each phase of the
// work on its own screen and let the status + log stay pinned.
export type Tab = { key: string; label: string; badge?: number };

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <View style={s.tabBar}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            style={[s.tab, on && s.tabOn]}
            onPress={() => onChange(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
          >
            <Text style={[s.tabText, on && s.tabTextOn]} numberOfLines={1}>
              {t.label}
            </Text>
            {t.badge ? <Text style={s.tabBadge}>{t.badge}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Compact tile + grid (the probe surface) ───────────────────────────────────
//
// ~50 payload probes as full-width Rows is ~3,700 px of scroll. As tiles they fit a
// screen, because the badge codes (LN0, W22, Ds3, ★IM) were ALREADY the thing being
// scanned for -- the two-line subtitle underneath was reference text, not something
// read on the way to a tap. It moves to long-press, which is where reference belongs.
export function Tile({
  badge,
  tint,
  label,
  tag,
  disabled,
  onPress,
  onLongPress,
}: {
  badge: string;
  tint: string;
  label: string;
  /** Short risk/kind marker, e.g. "render" / "WRITES". Dimmed; colour carries family. */
  tag?: string;
  disabled?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        s.tile,
        disabled && s.rowDisabled,
        pressed && !disabled && s.tilePressed,
      ]}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={280}
    >
      <View style={[s.tileBadge, { backgroundColor: tint }]}>
        <Text style={s.tileBadgeText} numberOfLines={1} adjustsFontSizeToFit>
          {badge}
        </Text>
      </View>
      <Text style={s.tileLabel} numberOfLines={2}>
        {label}
      </Text>
      {tag ? (
        <Text style={s.tileTag} numberOfLines={1}>
          {tag}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function TileGrid({ children }: { children: ReactNode }) {
  return <View style={s.tileGrid}>{children}</View>;
}

// ── Filter chips ──────────────────────────────────────────────────────────────
//
// 63 probes is four screens even as a grid. They already carry a kind tag (render /
// bisect / select / app / probe / safe), so filtering by it turns "scroll and hope you
// recognise the badge" into a one-screen list of the family you are actually working in.
export function Chips({
  options,
  active,
  onChange,
}: {
  options: { key: string; label: string; count?: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <View style={s.chipRow}>
      {options.map((o) => {
        const on = o.key === active;
        return (
          <Pressable key={o.key} style={[s.chip, on && s.chipOn]} onPress={() => onChange(o.key)}>
            <Text style={[s.chipText, on && s.chipTextOn]}>
              {o.label}
              {o.count == null ? "" : ` ${o.count}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
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

  tabBar: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: 10,
    padding: 3,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    borderRadius: 8,
  },
  tabOn: { backgroundColor: theme.surfaceAlt },
  tabText: { color: theme.textDim, fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },
  tabTextOn: { color: theme.text },
  tabBadge: {
    color: theme.accent,
    fontSize: 9,
    fontWeight: "800",
    marginLeft: 4,
    fontFamily: "Menlo",
  },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  chipOn: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipText: { color: theme.textDim, fontSize: 11, fontWeight: "700" },
  chipTextOn: { color: theme.text },

  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    // 4 per row: 4 × 22.8% + 3 × 8 dp gap = 323 dp inside a 328 dp content width.
    // 23.5% overflowed it by 4 dp and silently wrapped to THREE columns with a
    // tile's worth of dead space on the right — the kind of miss that only shows
    // up on the device, since the arithmetic looks fine either way.
    width: "22.8%",
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
    paddingVertical: 8,
    paddingHorizontal: 5,
    alignItems: "center",
  },
  tilePressed: { backgroundColor: theme.surfaceAlt },
  tileBadge: {
    width: 34,
    height: 26,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  tileBadgeText: { color: "#06110B", fontSize: 11, fontWeight: "800" },
  tileLabel: {
    color: theme.text,
    fontSize: 10,
    lineHeight: 12.5,
    textAlign: "center",
    marginTop: 5,
  },
  tileTag: { color: theme.textDim, fontSize: 8.5, marginTop: 3, opacity: 0.8 },

  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.surfaceAlt,
    overflow: "hidden",
    marginTop: 8,
  },
  fill: { height: 6, borderRadius: 3 },
});
