// The brain's vocabulary. Nothing here does I/O; everything below is injected.
//
// GOAL.md §2 says the phone is the brain — data, network, app logic — and the glasses are
// the face. `src/data` is that brain: it fetches from the network, decides what is worth
// sending, and hands bytes to the FFSC channel. It knows nothing about BLE, rendering or
// gestures.

/** A thing that turns the network (or phone state) into bytes one on-glass app understands. */
export interface DataSource {
  /** Stable, short, log-safe. Appears in telemetry; never contains user content. */
  readonly id: string;
  /** Which on-glass app receives this. The same key `ffs_appload.h` slots use. */
  readonly appId: number;
  /** How often to poll, in ms. */
  readonly everyMs: number;
  /**
   * Produce the blob. THROW to report failure — the pump treats a throw as "this poll
   * failed", logs it and keeps whatever the glasses already hold. Returning empty or
   * partial bytes instead would be the silent-failure shape this project keeps paying for.
   *
   * ⛔ An error thrown from here is logged. Do not put user content or a secret in its
   *    message: `ffs_os` is PUBLIC and its telemetry pipe is off-device.
   */
  fetch(now: number): Promise<Uint8Array>;
}

/** What the pump did, in metadata only. Never carries a blob or any of its content. */
export type DataEvent =
  | { kind: "fetched"; source: string; appId: number; bytes: number; ms: number }
  | { kind: "fetch-failed"; source: string; appId: number; error: string }
  | { kind: "too-big"; source: string; appId: number; bytes: number; cap: number }
  | { kind: "unchanged"; source: string; appId: number }
  | { kind: "superseded"; source: string; appId: number; droppedSeq: number }
  | { kind: "holding"; appId: number; pending: number; reason: "link-down" }
  | { kind: "sent"; source: string; appId: number; seq: number; bytes: number; frameBytes: number }
  | { kind: "send-failed"; source: string; appId: number; seq: number; attempts: number; error: string }
  // The link dropped within CRASH_WINDOW_MS of a send: the value we just pushed is the prime
  // suspect for having faulted the lens, so its app's channel is TRIPPED — no automatic resend.
  | { kind: "breaker-tripped"; appId: number; sinceSendMs: number }
  // A value was ready but the app's breaker is open, so it was withheld rather than pushed. Only
  // a manual re-arm (resetBreaker) sends again — a crashing push must never auto-retry.
  | { kind: "breaker-blocked"; source: string; appId: number; seq: number }
  | { kind: "breaker-reset"; appId: number };

export type DataLogger = (ev: DataEvent) => void;

/** One value waiting to go out. At most one exists per appId, by construction. */
export interface Pending {
  appId: number;
  sourceId: string;
  blob: Uint8Array;
  seq: number;
  offeredAt: number;
  attempts: number;
}
