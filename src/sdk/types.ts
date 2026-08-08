// Core SDK types. Deliberately free of I/O so they can be unit-tested with no glasses present.

import type { GlassesEvent } from "./events";

/**
 * How much hardware evidence stands behind a capability.
 *
 *  - "proven"   — observed working on OUR glasses; the evidence is cited.
 *  - "derived"  — composed only from proven primitives; no new hardware assumption.
 *  - "unproven" — mapped, inferred, or claimed by a third party. GATED at runtime.
 *
 * Cardinal rule 1 says an unproven capability does not ship. Encoding that as a type plus a
 * runtime gate makes it the compiler's job rather than a matter of discipline.
 */
export type Provenance = "proven" | "derived" | "unproven";

export interface ProvenanceEntry {
  readonly status: Provenance;
  /** Where to look: a file, a test name, a probe return code, or "[R] <ref doc>". */
  readonly evidence: string;
}

/**
 * The capability ledger. Every entry cites its evidence — an entry without one is a lie
 * waiting to be believed.
 */
export const PROVENANCE: Readonly<Record<string, ProvenanceEntry>> = {
  "list.declare": {
    status: "proven",
    evidence: "G2Central.showListLocked; 4-row list photographed on-glass 2026-08-07",
  },
  "list.nativeScroll": {
    status: "proven",
    evidence: "scroll row0->row1 produced ZERO wire traffic; measured with full inbound dump",
  },
  "list.select": {
    status: "proven",
    evidence: "G2EventDecodeTest.listClick_onRowOne_reportsTheSelectedIndex (captured bytes)",
  },
  "list.selectRowZero": {
    status: "proven",
    evidence: "G2EventDecodeTest row-0 vector: index field ABSENT, decodes as 0",
  },
  "list.rows48": {
    status: "proven",
    evidence: "48 rows declared (318B) and rendered; 7-row viewport photographed 2026-08-08",
  },
  /**
   * The SDK's own encoder driving a real page, end to end: TypeScript encodes, the native
   * transport ships it to the right lens, the firmware renders it.
   */
  "sdk.transport": {
    status: "proven",
    evidence: "FfsOs home menu (82B, SDK-encoded) photographed on-glass 2026-08-08",
  },
  /**
   * Navigating a screen STACK on-glass: a selection pops one page and declares the next as a
   * REBUILD. This is the capability the per-screen page-slot bug would have broken silently.
   *
   * ⚠️ The INPUT was injected (a captured ListEvent replayed through the real dispatch path),
   * because a genuine selection needs a finger on a temple pad. The RENDER is real hardware.
   */
  "sdk.navigation": {
    status: "proven",
    evidence:
      "home -> row1 -> Settings(97B REBUILD) photographed 2026-08-08; input injected, render real",
  },
  /**
   * A FIRMWARE-RENDERED animation: one command from the phone, and the glasses animate on their
   * own with no per-frame data. Captured as a 4-frame burst in which a marker inside a rounded
   * frame visibly moves — a single still could not have told an animation from a static graphic.
   *
   * Runs on the even_ai service, NOT EvenHub, and it OWNS the display while active: it replaces
   * the declared page, and exiting leaves the HUD blank until something re-declares.
   */
  "firmware.animation": {
    status: "proven",
    evidence: "even_ai CTRL ENTER; docs/proof/firmware-animation-filmstrip.png (2026-08-08)",
  },
  /**
   * Even's own head-up dashboard — a live clock plus widgets, rendered entirely by the firmware.
   * Observed when the AI session released our EvenHub page.
   */
  "firmware.dashboard": {
    status: "proven",
    evidence: "native dashboard with live clock '03:08' photographed 2026-08-08",
  },
  "sys.doubleClick": {
    status: "proven",
    evidence: "captured SysEvent{EventType=3 DOUBLE_CLICK, EventSource=1 GLASSES_R}",
  },
  "page.createFull": { status: "proven", evidence: "pageMessage CREATE at 576x288 renders" },
  "page.rebuild": {
    status: "proven",
    evidence: "Cmd 7; a second CREATE is silently ignored by the firmware (FUT-153)",
  },
  "settings.brightness": {
    status: "proven",
    evidence: "set 42 -> snapshot read back 42; visual sweep 100/20/15/10/5 through the rig",
  },
  "settings.readback": {
    status: "proven",
    evidence: "SETTINGS snapshot decodes battery, L/R firmware, brightness, head-up angle",
  },
  "text.page": { status: "proven", evidence: "showText renders; used all session" },
  /**
   * RENDER-proven, not merely transport-proven. The distinction matters: the ACK stream said
   * success=true for a whole session while the rig was mis-focused and showed nothing, so
   * "the fragments were acknowledged" is NOT evidence that pixels reached the lens.
   */
  "image.raw": {
    status: "proven",
    evidence:
      "testImageBmp (lit 200x100 rect, dark border, dark centre circle) photographed on-glass " +
      "2026-08-08 — the dark centre dot is the distinctive feature text cannot fake",
  },
  /**
   * Arbitrary container placement on the 576x288 canvas. Proven by MOVING one: the same string
   * at y=0 and at y=216 landed ~49 screenshot px apart, which is the correct fraction of the
   * ~65 px the full canvas occupies at the rig's zoom. A single placement would not have proven
   * the axis — only the displacement does.
   */
  "container.geometry": {
    status: "proven",
    evidence: "showTextAt (0,0,288,144) vs (0,216,576,72) photographed; y displacement matches",
  },

  // --- not proven; gated ---
  "list.itemName": {
    status: "unproven",
    evidence: "CurrentSelectItemName (field 3) absent in EVERY captured frame",
  },
  "list.edgeEvents": {
    status: "unproven",
    evidence: "SCROLL_TOP/BOTTOM exist in the enum; never observed on the wire",
  },
  "event.sourceOnList": {
    status: "unproven",
    evidence: "no EventSource field on any captured LIST event (only on SysEvent)",
  },
  "source.ring": {
    status: "unproven",
    evidence: "EventSource=2 believed to be the ring; never observed from our hardware",
  },
  /**
   * A page CAN carry a capturing list and a text container at once — so a menu header costs
   * nothing and no row has to spend itself on context. This was the load-bearing unknown in the
   * SDK spec: had it been false, every screen would have needed its title burned into row 0.
   */
  "page.mixedListAndText": {
    status: "proven",
    evidence:
      "showListWithHeader photographed 2026-08-08: 'HEADER' text container above a live " +
      "ONE/TWO/THREE/FOUR list, selected row still drawn as the rounded-rect highlight",
  },
  /**
   * Change a live container's text WITHOUT rebuilding the page.
   *
   * The value is not the saved bytes — it is that a REBUILD resets the list's focus to row 0, so
   * this is the ONLY way to have a ticking value on a screen the user is also navigating.
   *
   * Proven by a change too large to be an artefact: the header went from "HEADER" to twenty W's
   * while the list and its selection stayed put. Ticking a clock's seconds was NOT sufficient
   * evidence — at this glyph size the rig blooms six digits into one smear, and a per-region
   * pixel diff could not separate the change from the camera's own exposure drift.
   */
  "text.updateInPlace": {
    status: "proven",
    evidence:
      "Cmd 5 -> header replaced, list + selection unchanged; " +
      "docs/proof/text-update-in-place.png (2026-08-08)",
  },
  "settings.silent": {
    status: "proven",
    evidence: "set 1 -> BASIC_SETTING snapshot read back silent=1 (2026-08-08)",
  },
  "settings.wearDetect": {
    status: "proven",
    evidence: "set 1 -> snapshot read back wear=1 (2026-08-08)",
  },
  "settings.lensOffset": {
    status: "proven",
    evidence: "set x=7 y=3 -> snapshot read back lensX=7 lensY=3; fields 4/3, NOT 15/16",
  },
  "cfw.injectScroll": {
    status: "proven",
    evidence: "G2FW_LIST_INJECT_EVENT ret=0x68FC10FF twice, focus 0->1, DOWN=0 UP=1",
  },
  "cfw.injectSelect": {
    status: "unproven",
    evidence: "⛔ FAULTS THE LENS. select_inject_probe rebooted a lens; do not call.",
  },
  /**
   * Head-motion stream. The CONTROL command encodes and transmits cleanly and the firmware does
   * not fault — but nothing comes back.
   *
   * What this test DID settle, so nobody re-derives it:
   *  - not a decode failure: raw-frames=0, i.e. the glasses sent no inbound frame at all, not an
   *    unrecognised one;
   *  - not the wrapper field: 22 (generated schema + faceclaw) and 20 (MentraOS) were BOTH tried
   *    in the same run, and both were silent. A wrong field number is invisible, since protobuf
   *    ignores fields it does not know — which is exactly why it had to be tested, not argued.
   *
   * What it did NOT settle: the glasses were STATIONARY on a desk, so "this firmware does not
   * stream IMU" and "IMU reports only on motion" are still indistinguishable. Retest by moving
   * them. Note the reference kit's author also records never once observing IMU data.
   */
  "imu.stream": {
    status: "unproven",
    evidence:
      "control sent on fields 22 AND 20, pace 100, 5s each: raw-frames=0 both times " +
      "(2026-08-08). Glasses stationary — motion-gating not ruled out.",
  },
  "font.hebrewNative": {
    status: "unproven",
    evidence: "FUT-178: stock font has no Hebrew glyphs; lv_bidi/lv_txt_ap absent. Tier 2.",
  },
};

/** Thrown when unproven capability is used without an explicit opt-in. */
export class UnprovenCapabilityError extends Error {
  constructor(readonly capability: string, entry: ProvenanceEntry) {
    super(
      `capability "${capability}" is ${entry.status} and is gated by cardinal rule 1.\n` +
        `  evidence: ${entry.evidence}\n` +
        `  To use it anyway (e.g. to RUN the experiment that proves it), pass ` +
        `{ allowUnproven: true } — and update PROVENANCE the moment it is observed working.`
    );
    this.name = "UnprovenCapabilityError";
  }
}

/**
 * The runtime half of the provenance gate.
 *
 * Deliberately throws rather than warns: a warning in a log nobody reads is how "mapped" quietly
 * becomes "shipped". The escape hatch exists because the experiment that PROVES a capability
 * must necessarily call it while it is still unproven.
 */
export function assertProven(capability: string, allowUnproven = false): void {
  const entry = PROVENANCE[capability];
  if (!entry) throw new Error(`unknown capability "${capability}" — add it to PROVENANCE`);
  if (entry.status === "unproven" && !allowUnproven) {
    throw new UnprovenCapabilityError(capability, entry);
  }
}

/** Hard numbers. Anything not measured carries an UNPROVEN_ prefix so guesses cannot hide. */
export const LIMITS = {
  /** The canvas the firmware composites into. @proven */
  CANVAS_WIDTH: 576,
  CANVAS_HEIGHT: 288,
  /** Rows visible at once in a list viewport. @proven — photographed with 48 declared. */
  LIST_VIEWPORT_ROWS: 7,
  /** Declared rows proven to render. @proven 48; the true ceiling is not yet found. */
  LIST_ROWS_PROVEN: 48,
  /** Container name length the firmware echoes back intact. @derived from "ffs-list". */
  CONTAINER_NAME_MAX: 14,
  /** Brightness scale. NONLINEAR: 15 is a good working value, 100 blows out the camera. */
  BRIGHTNESS_MIN: 0,
  BRIGHTNESS_MAX: 100,
  /** Lens x/y nudge, per arm. @unproven — from the reference kit, never measured. */
  UNPROVEN_LENS_OFFSET_ABS_MAX: 20,
} as const;

export type ScreenState = "live" | "suspended" | "restoring" | "evicted" | "closed";

export interface AwaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type WireOp =
  | { op: "pageCreate"; containers: number }
  | { op: "pageRebuild"; containers: number }
  | { op: "noop"; reason: "identical" | "offline-coalesced" };

/** What a declaration actually did on the wire. Returned by every mutating call. */
export interface DeclareReport {
  readonly generation: number;
  readonly ops: readonly WireOp[];
  readonly bytes: number;
  readonly reason: "declare" | "redeclare" | "identical" | "restore";
  readonly warnings: readonly string[];
}

/** A row in a list screen. `value` is yours; the SDK only round-trips it. */
export interface Row<V = string> {
  readonly label: string;
  readonly value?: V;
  readonly disabled?: boolean;
}

export interface Selection<V = string> {
  readonly kind: "select";
  readonly index: number;
  readonly row: Row<V>;
  readonly value: V | undefined;
  /** The declaration this selection refers to. Compare against Screen.generation. */
  readonly generation: number;
}

export type ScreenEvent<V = string> =
  | Selection<V>
  | { kind: "back" }
  | { kind: "evicted" }
  | { kind: "resumed" }
  | { kind: "raw"; event: GlassesEvent };

/**
 * Counters that make the ARCHITECTURE assertable rather than merely intended.
 *
 * `declareCount` is the important one: the whole point of a declare-once model is that scrolling
 * costs nothing. A test that scrolls 20 rows and asserts declareCount === 1 and bytesOut delta 0
 * is what stops a future refactor quietly reintroducing the ~156ms-per-scroll round trip this
 * SDK exists to eliminate.
 */
export interface SessionStats {
  declareCount: number;
  bytesOut: number;
  eventsIn: number;
  restores: { pop: number; reconnect: number };
  /** Scrolls that cost a round trip. Should stay 0 for native lists. */
  scrollRoundTrips: number;
  /** In-place text updates — live values that cost no page rebuild and no loss of focus. */
  textUpdates: number;
}
