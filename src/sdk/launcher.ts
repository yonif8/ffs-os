// THE LAUNCHER — a rail of app tiles and a dashboard panel, drawn entirely by the firmware.
//
// ── WHY IT IS SHAPED LIKE THIS, WHICH IS ALMOST ENTIRELY FORCED BY THE HARDWARE ────────────
//
// 1. THE TILE IS THE LIST'S OWN SELECTION HIGHLIGHT. The firmware draws a rounded rect around a
//    list's focused row. Make the list 64px wide and that rect becomes a 64x41 rounded TILE
//    around a 3-letter mark — an iPhone-style app icon drawn BY THE GLASSES, no bitmap involved.
//    Photographed 2026-08-08 at w=56, producing a ~60x41 tile with radius ~13.
//
// 2. IT HAS TO BE THE HIGHLIGHT, not phone-drawn styling. Scrolling is native and the glasses
//    report NOTHING until a tap, so the phone cannot know which row is under the user's finger.
//    Anything the PHONE draws to indicate selection would be permanently out of sync. The
//    firmware's own highlight is the only thing that can track a scroll — so it is not merely
//    convenient that the tile is the highlight, it is the only workable design.
//
// 3. THE PANEL IS ABOUT THE WORLD, NOT THE CURSOR — same reason. A "details of the focused app"
//    pane is impossible without scroll telemetry, so the panel shows global state (time,
//    battery, next event, steps, last message) which is true regardless of which row is lit.
//    A dashboard is the one panel type natively immune to that constraint, which is very likely
//    why Even's own head-up display is also a dashboard.
//
// 4. NO BOXES ANYWHERE. TEXT containers ignore borderWidth/borderColor/borderRadius/padding — a
//    sweep of bw{1,2,3} x r{0,6,14,28} rendered as bare text with no stroke at any setting.
//    Structure therefore comes from type, position and whitespace, and the hairlines are literal
//    underscore characters.
//
// 5. NO SLIDE-IN ANIMATION, deliberately. Animating would require per-frame REBUILDs, and a
//    rebuild resets list focus to row 0 — it would fight the user on every frame. The rail is
//    always present instead. That is the honest reading of "a popup menu from the left" here.
//
// ⚠️ ONE tile exists at a time, and that is a hardware limit rather than a shortcut: text
// borders are inert, a 5-list page is fatal (it blanks the HUD *and* kills the page slot), and a
// bitmap icon would paint OVER the very highlight that surrounds it. Every app gets its tile
// when focused, and the tile slides between them.

import {
  Cmd,
  encodeEnvelope,
  encodeListContainer,
  encodePageContainer,
  encodeTextContainer,
} from "./wire";

/** Measured on-glass 2026-08-08: list row pitch ~41 canvas px. */
export const ROW_PITCH = 41;

/**
 * The launcher's fixed geometry.
 *
 * Height 252 shows all 6 rows for any pitch in 36..42, so the rail never scrolls and no row can
 * fall off the bottom — the measurement has slack built in rather than depending on being exact.
 */
export const RAIL = { x: 8, y: 8, w: 64, h: 252, rows: 6 } as const;
export const PANEL = { x: 88, w: 480 } as const;

/**
 * Launcher container ids, by ROLE.
 *
 * The clock is id 1 deliberately: update-in-place (Cmd 5) is proven on container id 1 and ONLY
 * on id 1. Spending the one id we know works on the most important live value means the worst
 * case — ids 4..9 turning out to be no-ops — still leaves a ticking clock.
 */
export const LAUNCHER_IDS = {
  rail: 3,
  clock: 1,
  status: 4,
  rule1: 5,
  w1: 6,
  w2: 7,
  w3: 8,
  rule2: 9,
} as const;

/** Slot names for ListScreen.setSlotText, mapped to the ids above. */
export const LAUNCHER_SLOTS: Readonly<Record<string, number>> = {
  clock: LAUNCHER_IDS.clock,
  status: LAUNCHER_IDS.status,
  w1: LAUNCHER_IDS.w1,
  w2: LAUNCHER_IDS.w2,
  w3: LAUNCHER_IDS.w3,
};

/**
 * A hairline drawn from characters, because TEXT borders are inert.
 * 36 chars x ~12px advance = ~432px inside a 460px box, so it never clips.
 */
export const RULE = "_".repeat(36);

/**
 * Letterspacing — the ONLY typographic hierarchy lever on this device.
 *
 * The text container schema carries no font, size, weight, leading or alignment field. Spacing a
 * string out is the one way to make the clock read as a heading rather than as body text.
 */
export function spaceOut(s: string): string {
  return s.split("").join(" ");
}

/** Widget lines are single-line and hard-capped: there is no wrap, and newline is unproven. */
export const WIDGET_MAX_CHARS = 34;
export function clampLine(s: string, max = WIDGET_MAX_CHARS): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "-";
}

/**
 * Any page, from parts.
 *
 * ⛔ HARD CAP, AND IT THROWS RATHER THAN GAMBLES. 1 LIST + 7 TEXT is the maximum PROVEN to
 * render. A 5-LIST page was REJECTED OUTRIGHT: nothing drew AND the page slot was left dead, so
 * every later REBUILD also drew nothing and the HUD only came back after a fresh link + CREATE.
 * An over-ambitious page does not degrade gracefully — it takes the display with it, which is a
 * far worse outcome than an exception at the call site. Pass allowUnproven to run the experiment
 * that widens the cap, and run it on a throwaway link.
 */
export function encodeCompositePage(o: {
  lists?: readonly Uint8Array[];
  texts?: readonly Uint8Array[];
  images?: readonly Uint8Array[];
  rebuild: boolean;
  magic: number;
  allowUnproven?: boolean;
}): Uint8Array {
  const nl = o.lists?.length ?? 0;
  const nt = o.texts?.length ?? 0;
  const ni = o.images?.length ?? 0;
  if (!o.allowUnproven && (nl > 1 || nt > 7 || ni > 0)) {
    throw new Error(
      `page of ${nl} list / ${nt} text / ${ni} image exceeds the proven 1/7/0. ` +
        `A rejected page blanks the HUD and kills the page slot — probe on a throwaway link.`
    );
  }
  const page = encodePageContainer({ lists: o.lists, texts: o.texts, images: o.images });
  return o.rebuild
    ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, o.magic)
    : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, o.magic);
}

export interface LauncherPageSpec {
  /** Exactly RAIL.rows marks, <= 3 uppercase-ASCII chars each. */
  readonly marks: readonly string[];
  /** Already letterspaced by the caller via spaceOut(). */
  readonly clock: string;
  readonly status: string;
  readonly widgets: readonly [string, string, string];
  readonly rebuild: boolean;
  readonly magic: number;
  /** Drop both hairlines if the underscore does not join into a continuous line on-glass. */
  readonly rules?: boolean;
  readonly allowUnproven?: boolean;
}

/**
 * Encode the launcher page: one capturing narrow LIST (the rail) plus six non-capturing
 * single-line TEXT containers (the panel). Eight containers, exactly the count proven to render.
 *
 * Declaration order IS a degradation ladder: if the firmware ever truncates a page, it costs the
 * bottom rule first and the rail last.
 */
export function encodeLauncherPage(s: LauncherPageSpec): Uint8Array {
  if (s.marks.length !== RAIL.rows) {
    throw new Error(`rail needs exactly ${RAIL.rows} marks, got ${s.marks.length}`);
  }
  for (const m of s.marks) {
    if (m.length > 3) throw new Error(`rail mark "${m}" is > 3 chars and will not fit a 64px tile`);
  }

  const rail = encodeListContainer({
    x: RAIL.x, y: RAIL.y, width: RAIL.w, height: RAIL.h,
    containerId: LAUNCHER_IDS.rail,
    containerName: "ffs-rail",
    items: s.marks,
    itemWidth: RAIL.w,
    selectBorder: true,
    isEventCapture: true, // the ONLY capturing container on this page
  });

  const T = (id: number, name: string, x: number, y: number, w: number, h: number, c: string) =>
    encodeTextContainer({
      x, y, width: w, height: h,
      containerId: id, containerName: name, content: c,
      isEventCapture: false, // the rail keeps every gesture — see the evt-0 trap
    });

  const showRules = s.rules ?? true;
  const texts: Uint8Array[] = [
    T(LAUNCHER_IDS.clock, "ffs-clock", PANEL.x, 6, 290, 44, s.clock),
    T(LAUNCHER_IDS.status, "ffs-stat", 392, 10, 176, 40, s.status),
    ...(showRules ? [T(LAUNCHER_IDS.rule1, "ffs-rule1", PANEL.x, 54, 460, 28, RULE)] : []),
    T(LAUNCHER_IDS.w1, "ffs-w1", PANEL.x, 86, PANEL.w, 44, clampLine(s.widgets[0])),
    T(LAUNCHER_IDS.w2, "ffs-w2", PANEL.x, 134, PANEL.w, 44, clampLine(s.widgets[1])),
    T(LAUNCHER_IDS.w3, "ffs-w3", PANEL.x, 182, PANEL.w, 44, clampLine(s.widgets[2])),
    ...(showRules ? [T(LAUNCHER_IDS.rule2, "ffs-rule2", PANEL.x, 232, 460, 28, RULE)] : []),
  ];

  return encodeCompositePage({
    lists: [rail],
    texts,
    rebuild: s.rebuild,
    magic: s.magic,
    allowUnproven: s.allowUnproven,
  });
}
