// dashboard.tsx — build a native dashboard (or screen) descriptor ON THE PHONE and push it.
//
// WHAT CHANGED, AND WHY IT MATTERS
// --------------------------------
// The payload interpreters (`ffs_dashboard`, `ffs_screen`) have always taken their whole
// configuration from a descriptor in .rodata, but the only thing that could WRITE that
// descriptor was a Python tool on a dev machine, injected with
//     adb shell am broadcast -a com.futurefounders.ffs.PUSH_PAYLOAD --es b64 <base64>
// So the app could push fifty prebuilt payloads and could not change a single field of any
// of them. The blobs are bundled now (src/sdk/templates.generated.ts) and the patcher is
// TypeScript (src/sdk/templates.ts), so this panel builds 32 bytes at runtime and pushes it
// down the same guarded path as every other payload. No dev machine in the loop.
//
// The rendering is 100% Even's: their clock font, their date, their icons, their bordered
// widgets. We choose the design and the geometry; their code draws every pixel.
//
// ⛔ EVERY CONTROL HERE IS GATED BY validateDashConfig BEFORE IT CAN BE PUSHED. That is not
// politeness — a descriptor their layout validator rejects falls back to the STOCK dashboard,
// which on the HUD is indistinguishable from "the push did nothing". Refusing client-side
// with a reason is the difference between a failed experiment and a confusing one.

import { useState } from "react";
import { StyleSheet, Text } from "react-native";

import {
  BASE_POS_LABELS,
  DASH_PRESETS,
  DASH_STOCK,
  SCREEN_PRESETS,
  WATCHFACE_KINDS,
  buildDashboardPush,
  buildScreenPush,
  dashGeometry,
  validateDashConfig,
  type DashConfig,
} from "../sdk/templates";
import { theme } from "./theme";
import { corruptFxp1CrcBase64 } from "./pushAck";
import { Chips, Group, Row, SectionLabel, Tile, TileGrid } from "./ui";

export type DashboardPanelProps = {
  /**
   * No link (or a flash in progress). Gates the two controls that PUSH; composing a config
   * stays live, because the chips cannot be disabled and a half-dead panel reads as broken.
   */
  disabled?: boolean;
  /** App.tsx's shared push status (the OTA-loader verdict). Shown here so a push made from
   *  this panel reports in the same place it was fired, not on another tab. */
  status?: string;
  /** Hand the framed base64 to App.tsx's guardedPush, which owns the OTA-loader gate. */
  onPush: (label: string, event: string, b64: string) => void;
};

/** Widget slot colours, so a five-slot column is scannable rather than five identical tiles. */
const WIDGET_TINTS = [theme.tint.green, theme.tint.blue, theme.tint.purple, theme.tint.amber, theme.tint.grey];

export function DashboardPanel({ disabled, status, onPush }: DashboardPanelProps) {
  const [cfg, setCfg] = useState<DashConfig>(() => ({ ...DASH_STOCK, basePos: 2 }));
  const [err, setErr] = useState<string>("");

  const patch = (over: Partial<DashConfig>) => setCfg((c) => ({ ...c, ...over }));
  const invalid = validateDashConfig(cfg);
  const geo = dashGeometry(cfg);

  const push = (label: string, event: string, build: () => string) => {
    try {
      const b64 = build();
      setErr("");
      onPush(label, event, b64);
    } catch (e) {
      // A throw here is a REFUSAL, not a crash: the descriptor was rejected before any
      // bytes reached the glasses. Say why, in the same place the verdict line lives.
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <>
      <SectionLabel note="CFW · their dashboard, our layout">Native dashboard</SectionLabel>
      {status ? <Text style={styles.status}>{status}</Text> : null}

      <Chips
        options={BASE_POS_LABELS.map((label, i) => ({ key: String(i), label }))}
        active={String(cfg.basePos)}
        onChange={(k) => {
          const basePos = Number(k);
          // CENTER cannot coexist with a widget column, so choosing it clears the widgets
          // rather than parking the user on a config that can only be refused.
          patch(basePos === 1 ? { basePos, widgetCount: 0 } : { basePos });
        }}
      />
      <Chips
        options={[0, 1, 2, 3, 4, 5].map((n) => ({ key: String(n), label: n === 0 ? "no widgets" : `${n}` }))}
        active={String(cfg.widgetCount)}
        onChange={(k) => {
          const widgetCount = Number(k);
          patch(widgetCount > 0 && cfg.basePos === 1 ? { widgetCount, basePos: 0 } : { widgetCount });
        }}
      />
      <Chips
        options={WATCHFACE_KINDS.map((w) => ({ key: String(w.kind), label: w.label }))}
        active={String(cfg.kind)}
        onChange={(k) => patch({ kind: Number(k) })}
      />

      {/* Widget order. Tap a slot to cycle its type 0..4 — the firmware reads only the first
          `widgetCount` entries, so the greyed tail is kept rather than zeroed (patch_dash.py
          does the same, and the bytes have to agree with it). */}
      {cfg.widgetCount > 0 ? (
        <TileGrid>
          {cfg.widgetOrder.slice(0, cfg.widgetCount).map((t, i) => (
            <Tile
              key={i}
              badge={`W${i + 1}`}
              tint={WIDGET_TINTS[t] ?? theme.tint.grey}
              label={`type ${t}`}
              tag="tap to cycle"
              onPress={() =>
                setCfg((c) => {
                  const widgetOrder = c.widgetOrder.slice();
                  widgetOrder[i] = ((widgetOrder[i] ?? 0) + 1) % 5;
                  return { ...c, widgetOrder };
                })
              }
            />
          ))}
        </TileGrid>
      ) : null}

      {/* The verdict line. `expect …` is apply_geo restated on the phone, so the number is
          decided BEFORE the push — the payload reports watchface_x>>3 back in ret= bits
          16..22 and the two either agree or they don't. */}
      <Text style={[styles.verdict, (invalid || err) && styles.verdictBad]}>
        {invalid ||
          err ||
          `${BASE_POS_LABELS[cfg.basePos]} · ${cfg.widgetCount} widget${cfg.widgetCount === 1 ? "" : "s"} · ` +
            `${WATCHFACE_KINDS.find((w) => w.kind === cfg.kind)?.label ?? `kind ${cfg.kind}`} — ` +
            `expect watchface_x=${geo.watchfaceX} widget_col_x=${geo.widgetColX} ` +
            `(ret bits 16..22 = ${geo.watchfaceX >> 3})`}
      </Text>

      <Group>
        <Row
          badge="▦"
          tint={theme.tint.green}
          title="Render this dashboard"
          subtitle="32 bytes patched into the bundled interpreter, re-framed and pushed"
          tag={invalid ? "invalid" : "no flash"}
          tagTint={invalid ? theme.danger : theme.tint.green}
          disabled={disabled || !!invalid}
          onPress={() => push("DASHBOARD", "push_dashboard", () => buildDashboardPush(cfg))}
        />
        {__DEV__ ? (
          <Row
            badge="CRC"
            tint={theme.danger}
            title="Prove rejected-push detection"
            subtitle="Corrupts only the FXP1 CRC; loader must refuse before executing"
            tag="safe reject"
            tagTint={theme.danger}
            divider
            disabled={disabled || !!invalid}
            onPress={() =>
              push("CRC REJECTION PROBE", "push_crc_rejection_probe", () =>
                corruptFxp1CrcBase64(buildDashboardPush(cfg)),
              )
            }
          />
        ) : null}
        <Row
          badge="↺"
          tint={theme.tint.grey}
          title="Reset to Even's stock configuration"
          subtitle="base_pos LEFT · 5 widgets · big clock — the A/B reference"
          divider
          onPress={() => {
            setCfg({ ...DASH_STOCK });
            setErr("");
          }}
        />
      </Group>

      {/* Presets, ported 1:1 from patch_dash.py's DEMOS so a phone push and an adb push are
          the same bytes. Tapping one LOADS it — pushing stays the deliberate second tap. */}
      <SectionLabel note="tap to load, then Render">Presets</SectionLabel>
      <TileGrid>
        {DASH_PRESETS.map((p) => (
          <Tile
            key={p.id}
            badge={p.label.slice(0, 3).toUpperCase()}
            tint={theme.tint.blue}
            label={p.label}
            onPress={() => {
              setCfg({ ...p.cfg, widgetOrder: p.cfg.widgetOrder.slice() });
              setErr("");
            }}
          />
        ))}
      </TileGrid>

      {/* The other interpreter, same mechanism: OUR containers instead of Even's dashboard.
          Pushing `home` then `settings` from the SAME bundled blob is the proof that a
          screen is data — nothing is rebuilt between the two taps. */}
      <SectionLabel note="CFW · our own containers">Native screen</SectionLabel>
      <Group>
        {SCREEN_PRESETS.map((p, i) => (
          <Row
            key={p.id}
            badge={p.label.slice(0, 3).toUpperCase()}
            tint={theme.tint.purple}
            title={p.label}
            subtitle={p.note}
            tag="no flash"
            divider={i > 0}
            disabled={disabled}
            onPress={() => push(`SCREEN ${p.label}`, `push_screen_${p.id}`, () => buildScreenPush(p.slots))}
          />
        ))}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  status: { color: theme.textDim, fontSize: 12, marginBottom: 8 },
  verdict: { color: theme.textDim, fontSize: 11.5, lineHeight: 16, marginTop: 10, marginBottom: 2 },
  verdictBad: { color: theme.danger },
});
