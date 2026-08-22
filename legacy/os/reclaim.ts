// FFS Glasses OS — screen-ownership / reclaim manager (FUT-136, ported FUT-163)
//
// WHY THIS EXISTS
// The G2's idle dashboard + menu are rendered by Even's ON-GLASS FIRMWARE (UI app
// service 0x01), NOT by any phone app. Our content is a separate firmware UI app
// ("EvenHub", 0xE0) that the firmware time-slices against the dashboard. There is
// NO BLE command to disable/hide the firmware dashboard/menu/gesture.
//
// So we cannot make the dashboard "never appear". What we CAN do — and what Yoni
// greenlit (2026-07-11, flicker acceptable) — is make OUR surface the PERSISTENT
// idle default: every time the user's gesture pops the firmware dashboard/menu,
// we re-assert our content a beat later so it always wins the screen back.
// Net: "always win the screen back", not "the dashboard never shows".
//
// DIVISION OF LABOUR
//   • The ffs-ble driver (modules/ffs-ble) owns the BLE transport, the dual-radio
//     plumbing, the EvenHub page heartbeat, and low-level page rebuild. We do NOT
//     re-implement those in JS.
//   • THIS module owns, at the OS layer, WHAT should be on screen and RE-PUSHES it
//     whenever the firmware takes the screen.
//
// FUT-136 diagnostic (2026-07-12, measured on-device): proactive re-assertion is
// net-negative — our re-pushing PROVOKES the firmware to evict our page. So both
// gesture-driven reclaim and the periodic keep-alive are GATED OFF; we rely on the
// driver's own page recovery + our content-change pushes + a foreground reclaimNow.
// Flip the flags below true to revert. (Kept for the on-glass parity record.)

import FfsBle from "../../modules/ffs-ble";

/** A surface = whatever we currently want painted on the HUD. Idempotent + re-runnable. */
export type Surface = () => Promise<void>;

export type ReclaimOptions = {
  /** Delay after a takeover gesture before we re-assert our surface (ms). Tune on hardware. */
  debounceMs?: number;
  /** Slow keep-alive re-assert cadence so our surface stays the idle default (ms). 0 disables. */
  keepAliveMs?: number;
  /** Optional hook for diagnostics (fired on every reclaim, with the trigger). */
  onReclaim?: (trigger: ReclaimTrigger) => void;
};

export type ReclaimTrigger = "gesture" | "keepalive" | "manual";

const DEFAULTS: Required<Omit<ReclaimOptions, "onReclaim">> = {
  debounceMs: 1500,
  keepAliveMs: 30_000,
};

// GATED OFF (FUT-136): reacting to every touch gesture double-paints against the
// driver's own recovery and provokes firmware evictions. See header.
const REACT_TO_TAKEOVER_GESTURES: boolean = false;

// GATED OFF (FUT-136): the periodic keep-alive re-push ALSO provokes evictions.
const ENABLE_KEEPALIVE_REASSERT: boolean = false;

/**
 * Owns the single "current surface" and keeps re-asserting it against the firmware.
 * One instance per app session; `setSurface` swaps what we paint as the OS navigates
 * (home ↔ app ↔ …). Start it once connected; stop on disconnect.
 */
export class ScreenOwner {
  private surface: Surface | null = null;
  private opts: Required<Omit<ReclaimOptions, "onReclaim">> & Pick<ReclaimOptions, "onReclaim">;
  private subs: { remove(): void }[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // Serialize re-pushes so overlapping triggers can't interleave BLE writes.
  private painting: Promise<void> = Promise.resolve();

  constructor(opts: ReclaimOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Register a diagnostics hook fired on every reclaim. */
  setOnReclaim(onReclaim: (trigger: ReclaimTrigger) => void): void {
    this.opts.onReclaim = onReclaim;
  }

  /** Set (and immediately paint) the surface the OS wants on screen right now. */
  async setSurface(surface: Surface): Promise<void> {
    this.surface = surface;
    await this.paint("manual");
  }

  /** Currently registered surface, if any. */
  hasSurface(): boolean {
    return this.surface != null;
  }

  /** Begin reclaiming: subscribe to takeover gestures + start the keep-alive. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Gesture-driven reclaim — GATED (FUT-136). Any touch gesture pops the firmware
    // dashboard/menu; re-assert after it settles. The driver already recovers our page,
    // so reacting here too just double-paints — kept off.
    if (REACT_TO_TAKEOVER_GESTURES) {
      this.subs.push(FfsBle.addListener("onGesture", () => this.scheduleReclaim("gesture")));
    }

    if (ENABLE_KEEPALIVE_REASSERT && this.opts.keepAliveMs > 0) {
      this.keepAliveTimer = setInterval(() => {
        if (!this.debounceTimer) void this.paint("keepalive");
      }, this.opts.keepAliveMs);
    }
  }

  /** Stop reclaiming and release all listeners/timers. Idempotent. */
  stop(): void {
    this.running = false;
    for (const s of this.subs) {
      try {
        s.remove();
      } catch {
        // best-effort teardown
      }
    }
    this.subs = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /** Force an immediate re-assert of the current surface (e.g. after coming to foreground). */
  reclaimNow(): void {
    void this.paint("manual");
  }

  private scheduleReclaim(trigger: ReclaimTrigger): void {
    if (!this.running || !this.surface) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.paint(trigger);
    }, this.opts.debounceMs);
  }

  private paint(trigger: ReclaimTrigger): Promise<void> {
    const surface = this.surface;
    if (!surface) return Promise.resolve();
    // Chain onto the in-flight paint so BLE writes never interleave.
    this.painting = this.painting
      .catch(() => {})
      .then(async () => {
        try {
          await surface();
          this.opts.onReclaim?.(trigger);
        } catch {
          // Painting is best-effort; the transport layer owns hard connection errors.
        }
      });
    return this.painting;
  }
}

/**
 * Session-wide screen owner. The app shell starts/stops it on connect/disconnect and
 * swaps the surface as the OS navigates; apps claim the screen by calling
 * `screenOwner.setSurface(...)` while foregrounded.
 */
export const screenOwner = new ScreenOwner();
