// The data service — the thing that actually RUNS the pump.
//
// `pump.ts` is a pure decision engine with a `tick()`; something has to call it on a timer, notice
// when the BLE link comes back, and let a source say "I have something now, don't wait for the
// interval". That is all this is. It stays pure (no react-native, no native module import) so
// `bun test src/data` still runs it on a PC — the transport is injected.
//
// ── THE TWO DECISIONS THAT ARE NOT OBVIOUS ────────────────────────────────────────────────────
//
// 1. ON RECONNECT, FORGET WHAT WE THINK THE GLASSES HOLD. `DataPump` suppresses a push whose blob
//    matches the last one it sent (`unchanged`), which is right for a quiet radio and wrong after
//    the glasses reboot: their mailbox is empty, ours says "already sent", and the app renders its
//    fixture forever while the phone politely says nothing. So every down→up transition calls
//    `forgetLanded()`. The cost is one redundant push per reconnect; the bug it prevents is
//    invisible and permanent.
//
// 2. A NUDGE IS NOT A TICK. `nudge(sourceId)` clears one source's poll timestamp and runs a tick
//    NOW, so a message that arrives at 12:00:03 does not wait until 12:01:00. It is coalesced —
//    twenty arrivals inside the debounce window produce one tick, and the outbox's latest-wins
//    rule means one push regardless.

import type { DataLogger, DataSource } from "./types";
import { DataPump } from "./pump";

export interface DataServiceDeps {
  sources: DataSource[];
  /** Hand the finished FXP1 frame to the transport. Throw to report a failed send. */
  send(frame: Uint8Array, meta: { appId: number; seq: number; sourceId: string }): Promise<void>;
  linkUp(): boolean;
  now?(): number;
  log?: DataLogger;
  /** Regular cadence. 30 s is a compromise: sources declare their own `everyMs` anyway. */
  tickMs?: number;
  /** Coalescing window for `nudge`. */
  nudgeMs?: number;
  /** Injected so tests do not need real timers. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export class DataService {
  readonly pump: DataPump;
  private timer: unknown = null;
  private nudgeTimer: unknown = null;
  private lastLinkUp = false;
  private running = false;
  private inflight: Promise<void> | null = null;

  private readonly si: (fn: () => void, ms: number) => unknown;
  private readonly ci: (h: unknown) => void;
  private readonly st: (fn: () => void, ms: number) => unknown;
  private readonly ct: (h: unknown) => void;

  constructor(private readonly deps: DataServiceDeps) {
    this.pump = new DataPump({
      sources: deps.sources,
      send: deps.send,
      linkUp: deps.linkUp,
      now: deps.now ?? Date.now,
      log: deps.log,
    });
    this.si = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.ci = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.st = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.ct = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastLinkUp = this.deps.linkUp();
    this.timer = this.si(() => void this.tick(), this.deps.tickMs ?? 30_000);
    void this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) this.ci(this.timer);
    if (this.nudgeTimer !== null) this.ct(this.nudgeTimer);
    this.timer = null;
    this.nudgeTimer = null;
  }

  /**
   * A lens dropped off the link. Report it PROMPTLY (from a BLE disconnect event, not the tick):
   * if it follows a recent push, the pump trips that app's breaker so the reconnect path cannot
   * re-send the value that just crashed the lens. Safe to call when nothing is wrong — the pump
   * only trips if a send is inside the crash window. See DataPump.noteLinkDown / CRASH_WINDOW_MS.
   */
  noteLinkDown(): void {
    this.pump.noteLinkDown((this.deps.now ?? Date.now)());
  }

  /** Something arrived. Re-poll that source at the next coalescing boundary. */
  nudge(sourceId?: string): void {
    if (!this.running) return;
    this.pump.refresh(sourceId);
    if (this.nudgeTimer !== null) return; // already scheduled — coalesce the burst
    this.nudgeTimer = this.st(() => {
      this.nudgeTimer = null;
      void this.tick();
    }, this.deps.nudgeMs ?? 1200);
  }

  /**
   * One round. Never throws, and never runs twice at once: a BLE write slower than the tick
   * interval must not let two drains work the same outbox. A caller that arrives mid-tick JOINS
   * the one in flight rather than being told "no" — so `await svc.tick()` always means "a tick
   * finished", which is what a caller (and a test) actually wants to know.
   */
  tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(): Promise<void> {
    try {
      const up = this.deps.linkUp();
      if (up && !this.lastLinkUp) {
        // See decision 1 in the header.
        this.pump.forgetLanded();
        this.pump.refresh();
      } else if (!up && this.lastLinkUp) {
        // A down transition seen at tick time — a backup to the prompt noteLinkDown() the panel
        // fires from the BLE disconnect event, for the case where no listener drove it. Same
        // guard: only trips if the drop is inside a recent send's crash window.
        this.pump.noteLinkDown((this.deps.now ?? Date.now)());
      }
      this.lastLinkUp = up;
      await this.pump.tick();
    } catch {
      // `pump.tick()` is documented never to throw; this is the belt on top of the braces,
      // because an unhandled rejection inside a setInterval is a silent dead service.
    }
  }
}
