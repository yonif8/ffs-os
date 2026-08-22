// Status widget — Device.
//
// Battery %, per-lens firmware version, and a CFW/loader badge. The CFW diagnostic blocks
// ride the device-info firmware-version string; `parseCfw` pulls them apart. Copied here
// verbatim from the old App.tsx (the plan says copy, not import from legacy) so this
// widget stands alone.

import { StyleSheet, Text, View } from "react-native";

import { theme } from "../theme";
import { SectionLabel } from "../ui";

/** Real device info read back from the glasses (mirrors useFfsBluetooth's FfsDeviceInfo). */
export type DeviceInfo = {
  leftVersion: string | null;
  rightVersion: string | null;
  battery: number | null;
  charging: boolean | null;
} | null;

/**
 * Pull the CFW diagnostic blocks out of the firmware version string. The CFW appends them
 * to the sid-0x09 device-info response as `⟨NAME=…⟩` extension blocks. Every field is
 * optional on purpose — stock firmware sends none, so absent must read as "not advertised",
 * never as a measured default.
 */
export function parseCfw(version: string | null | undefined): {
  fw: string;
  caps: string[];
  ramexec: string | null;
  loader: { gen: number; ran: number } | null;
} {
  const v = version ?? "";
  const block = (name: string) => {
    const m = v.match(new RegExp(`⟨${name}=?([^⟩]*)⟩`));
    return m ? m[1].trim() : null;
  };
  const capsRaw = block("CAPS");
  const caps = capsRaw ? capsRaw.split(/\s+/).filter((t) => t && !t.startsWith("EVENCFW/")) : [];

  const rx = v.match(/⟨RAMEXEC \w+ (\w+)/);
  const ld = v.match(/⟨LOADER gen=(\d+) ran=(\d+)/);

  return {
    fw: v.split("⟨")[0].trim(),
    caps,
    ramexec: rx ? rx[1] : null,
    loader: ld ? { gen: Number(ld[1]), ran: Number(ld[2]) } : null,
  };
}

export type DeviceProps = {
  deviceInfo: DeviceInfo;
  /**
   * Latched CFW read (the blocks ride whichever lens answered last, so App holds the last
   * one that actually carried them). Null until a carrier response has been seen.
   */
  cfwSeen: ReturnType<typeof parseCfw> | null;
};

export function Device({ deviceInfo, cfwSeen }: DeviceProps) {
  const left = parseCfw(deviceInfo?.leftVersion).fw || "?";
  const right = parseCfw(deviceInfo?.rightVersion).fw || "?";
  const batt = deviceInfo?.battery;

  const cfwLive = !!cfwSeen && (cfwSeen.caps.length > 0 || !!cfwSeen.ramexec || !!cfwSeen.loader);
  const cfwBad = !!cfwSeen?.ramexec && cfwSeen.ramexec !== "EXEC_OK";

  return (
    <>
      <SectionLabel>Device</SectionLabel>
      <View style={s.card}>
        {deviceInfo ? (
          <>
            <View style={s.row}>
              <Text style={s.k}>Battery</Text>
              <Text style={s.v}>
                {batt == null ? "—" : `${batt}%`}
                {deviceInfo.charging ? "  ⚡" : ""}
              </Text>
            </View>
            <View style={[s.row, s.divider]}>
              <Text style={s.k}>Firmware</Text>
              <Text style={s.v}>
                L {left} · R {right}
              </Text>
            </View>
            <View style={[s.row, s.divider]}>
              <Text style={s.k}>CFW / loader</Text>
              <View style={s.badges}>
                {cfwLive ? (
                  <Text style={[s.badge, { color: cfwBad ? theme.danger : theme.accent, borderColor: cfwBad ? theme.danger : theme.accent }]}>
                    CFW{cfwSeen?.ramexec ? ` ${cfwSeen.ramexec}` : ""}
                  </Text>
                ) : (
                  <Text style={[s.badge, { color: theme.warn, borderColor: theme.warn }]}>not advertised</Text>
                )}
                {cfwSeen?.loader ? (
                  <Text style={[s.badge, { color: theme.tint.blue, borderColor: theme.tint.blue }]}>
                    LD {cfwSeen.loader.ran}/{cfwSeen.loader.gen}
                  </Text>
                ) : null}
              </View>
            </View>
            {cfwSeen?.caps.length ? <Text style={s.caps}>{cfwSeen.caps.join("  ")}</Text> : null}
          </>
        ) : (
          <Text style={s.empty}>No device info yet — connect, and it auto-reads ~2 s after the pair is ready.</Text>
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
    paddingHorizontal: 12,
  },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 11 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.surfaceAlt },
  k: { color: theme.textDim, fontSize: 12.5, fontWeight: "600" },
  v: { color: theme.text, fontSize: 13.5, fontWeight: "700", fontFamily: "Menlo" },
  badges: { flexDirection: "row", gap: 6 },
  badge: {
    fontSize: 10.5,
    fontWeight: "800",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
  },
  caps: { color: theme.textDim, fontSize: 11, fontFamily: "Menlo", paddingBottom: 11 },
  empty: { color: theme.textDim, fontSize: 12.5, lineHeight: 17, paddingVertical: 13 },
});
