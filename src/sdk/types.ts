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
  "image.raw": { status: "proven", evidence: "4-bit BMP over the image channel, ACK-gated" },

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
  "page.mixedListAndText": {
    status: "unproven",
    evidence: "pageMessage supports it; never sent. Would make menu headers free.",
  },
  "text.updateInPlace": {
    status: "unproven",
    evidence: "Cmd 5 updateText is built but has never been sent",
  },
  "settings.silent": { status: "unproven", evidence: "setter written; not yet read back" },
  "settings.wearDetect": { status: "unproven", evidence: "setter written; not yet read back" },
  "settings.lensOffset": { status: "unproven", evidence: "setter written; not yet read back" },
  "cfw.injectScroll": {
    status: "proven",
    evidence: "G2FW_LIST_INJECT_EVENT ret=0x68FC10FF twice, focus 0->1, DOWN=0 UP=1",
  },
  "cfw.injectSelect": {
    status: "unproven",
    evidence: "⛔ FAULTS THE LENS. select_inject_probe rebooted a lens; do not call.",
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
}
