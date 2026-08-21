// The service's three jobs, with fake timers so none of this waits on a clock.
//
// Everything here is a behaviour that only shows up in the field: a reconnect after the glasses
// rebooted, twenty notifications inside one second, and a BLE write slower than the tick interval.

import { describe, expect, it } from "bun:test";

import { DataService } from "../service";
import type { DataEvent, DataSource } from "../types";
import { encodeFfsm } from "../../sdk/ffsm";

/** A fake scheduler: nothing runs until the test says so. */
class Clock {
  t = 1_000_000;
  private intervals: Array<{ fn: () => void; ms: number; next: number }> = [];
  private timeouts: Array<{ fn: () => void; at: number } | null> = [];

  setInterval = (fn: () => void, ms: number) => {
    const h = { fn, ms, next: this.t + ms };
    this.intervals.push(h);
    return h;
  };
  clearInterval = (h: unknown) => {
    this.intervals = this.intervals.filter((i) => i !== h);
  };
  setTimeout = (fn: () => void, ms: number) => {
    const h = { fn, at: this.t + ms };
    this.timeouts.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    this.timeouts = this.timeouts.map((x) => (x === h ? null : x));
  };

  /** Advance, firing whatever is due. */
  advance(ms: number): void {
    this.t += ms;
    for (const to of this.timeouts.splice(0)) if (to && to.at <= this.t) to.fn();
    for (const iv of this.intervals) {
      while (iv.next <= this.t) {
        iv.next += iv.ms;
        iv.fn();
      }
    }
  }
}

function source(id: string, body: () => string): DataSource {
  return {
    id,
    appId: 3,
    everyMs: 60_000,
    async fetch() {
      return encodeFfsm([{ name: "T", unread: true, messages: [{ fromMe: false, ageMin: 0, body: body() }] }]);
    },
  };
}

function harness(opts: { body?: () => string } = {}) {
  const clock = new Clock();
  const sent: Uint8Array[] = [];
  const events: DataEvent[] = [];
  let up = true;
  let text = "one";
  const svc = new DataService({
    sources: [source("s", opts.body ?? (() => text))],
    send: async (f) => void sent.push(f),
    linkUp: () => up,
    now: () => clock.t,
    log: (e) => events.push(e),
    tickMs: 30_000,
    nudgeMs: 1_000,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return {
    clock,
    sent,
    events,
    svc,
    setUp: (v: boolean) => {
      up = v;
    },
    setText: (v: string) => {
      text = v;
    },
  };
}

describe("DataService", () => {
  it("pushes once on start and then stays quiet while nothing changes", async () => {
    const h = harness();
    h.svc.start();
    await h.svc.tick();
    expect(h.sent.length).toBe(1);
    h.clock.advance(60_000);
    await h.svc.tick();
    expect(h.sent.length).toBe(1);
    expect(h.events.some((e) => e.kind === "unchanged")).toBe(true);
    h.svc.stop();
  });

  it("★ re-sends after a reconnect, because the glasses may have rebooted and lost the mailbox", async () => {
    // The bug this prevents is invisible and permanent: the pump suppresses a duplicate value, the
    // glasses' mailbox is empty after a reboot, and the app renders its fixture forever while the
    // phone politely says nothing.
    const h = harness();
    h.svc.start();
    await h.svc.tick();
    expect(h.sent.length).toBe(1);

    h.setUp(false);
    await h.svc.tick();
    h.setUp(true);
    h.clock.advance(60_000);
    await h.svc.tick();

    expect(h.sent.length).toBe(2); // same bytes, sent again — deliberately
    h.svc.stop();
  });

  it("coalesces a burst of nudges into one tick", async () => {
    const h = harness();
    h.svc.start();
    await h.svc.tick();
    const before = h.sent.length;
    h.setText("two");
    for (let i = 0; i < 20; i++) h.svc.nudge("s");
    h.clock.advance(1_000);
    await Promise.resolve();
    await h.svc.tick();
    expect(h.sent.length).toBe(before + 1);
    h.svc.stop();
  });

  it("never runs two ticks at once, so a slow BLE write cannot stack drains", async () => {
    const h = harness();
    let inFlight = 0;
    let maxInFlight = 0;
    const svc = new DataService({
      sources: [source("s", () => "x")],
      send: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      linkUp: () => true,
      now: () => h.clock.t,
      tickMs: 30_000,
      setInterval: h.clock.setInterval,
      clearInterval: h.clock.clearInterval,
      setTimeout: h.clock.setTimeout,
      clearTimeout: h.clock.clearTimeout,
    });
    svc.start();
    await Promise.all([svc.tick(), svc.tick(), svc.tick()]);
    expect(maxInFlight).toBe(1);
    svc.stop();
  });

  it("a nudge after stop() does nothing", () => {
    const h = harness();
    h.svc.start();
    h.svc.stop();
    h.svc.nudge("s");
    h.clock.advance(10_000);
    expect(h.svc.isRunning).toBe(false);
  });
});
