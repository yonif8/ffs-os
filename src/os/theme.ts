// FFS Glasses OS — design tokens
// The G2 HUD is a 576x288, 4-bit monochrome-green canvas. Keep the phone-side
// control surface dark to match the "OS" feel; keep HUD text terse + high-contrast.

export const HUD = {
  width: 576,
  height: 288,
  // Rough text metrics for the default G2 font at size ~21. The ffs-ble driver
  // currently owns text layout (showText takes only a string), so these are
  // reference constants for future per-line positioning (driver TODO).
  lineHeight: 40,
  leftPad: 24,
  topPad: 24,
} as const;

export const theme = {
  bg: "#0A0A0B",
  surface: "#141416",
  surfaceAlt: "#1E1E22",
  text: "#F5F5F7",
  textDim: "#9A9AA2",
  // FFS "glasses green" — echoes the HUD, our brand accent.
  accent: "#3CE28B",
  accentDim: "#1F7A4C",
  danger: "#FF5A5A",
  // Amber — link is working but not yet solid (connecting / reconnecting / booting).
  warn: "#F5B23C",
  radius: 16,
  // FUT-220 — per-row badge tints. A dense list of near-identical firmware images is
  // only scannable if each row carries its own colour (Google TV settings pattern);
  // nine identical green buttons are not. Tints group by FAMILY, not by risk:
  // blue = baseline/no-op, amber = Hebrew line, green = FFS OS line, red = full CFW,
  // grey = revert. Risk is carried by the right-hand tag, not the colour.
  tint: {
    blue: "#5AA9FF",
    purple: "#C77DFF",
    amber: "#F5B23C",
    green: "#3CE28B",
    red: "#FF5A5A",
    grey: "#9A9AA2",
  },
} as const;

export type Theme = typeof theme;
