// FFS Glasses OS — HUD compositor (thin layer over OUR ffs-ble driver).
// This is OUR OS surface: what we choose to render on the G2's 576x288 HUD.
// The BLE transport / dual-radio / framebuffer plumbing is the ffs-ble driver's
// job (modules/ffs-ble); composition is ours. Ported off @mentra/bluetooth-sdk
// onto FfsBle.showText — no third-party pipes (FUT-163, Phase 1).

import FfsBle from "../../modules/ffs-ble";

/**
 * Clear the glasses display. The ffs-ble driver has no dedicated clear command
 * yet, so we blank the HUD by rendering a single space (a real clear primitive
 * is a driver follow-up). Best-effort — connection layer owns hard errors.
 */
export async function hudClear(): Promise<void> {
  try {
    FfsBle.showText(" ");
  } catch {
    // swallow — display is best-effort.
  }
}

/**
 * Render up to a few lines of text on the HUD. The driver owns text layout
 * (top-left anchored, default font); it takes a single string, so lines are
 * newline-joined. (Per-line size/position is a driver TODO — see theme.HUD.)
 */
export async function hudLines(lines: string[]): Promise<void> {
  try {
    FfsBle.showText(lines.join("\n"));
  } catch {
    // swallow — best-effort; connection layer owns hard errors.
  }
}

/** The FFS Glasses OS home screen on the HUD — the "spine lit up" moment. */
export async function hudHome(opts?: { battery?: number | null; time?: string }): Promise<void> {
  const time = opts?.time ?? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const batt = opts?.battery == null ? "" : `  ${opts.battery}%`;
  await hudLines([
    `FFS Glasses OS      ${time}${batt}`,
    "",
    "Ready.",
    "(our own OS · no mentra)",
  ]);
}

/** A single transient status line (connecting, errors, etc.). */
export async function hudStatus(message: string): Promise<void> {
  await hudLines(["FFS Glasses OS", "", message]);
}
