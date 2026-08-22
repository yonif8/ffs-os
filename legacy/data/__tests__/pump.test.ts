// The brain's failure behaviour, stated as tests rather than as hope.
//
// Every dependency is injected, so "the link dropped mid-send", "the API 503'd", "the value
// is too big" and "nothing changed" are all ordinary branches here instead of things nobody
// finds out about until a HUD is blank on someone's face.

import { beforeEach, describe, expect, it } from "bun:test";
import { DataPump } from "../pump";
import { Outbox } from "../outbox";
import { decodeFfsc } from "../../sdk/ffsc";
import type { DataEvent, DataSource } from "../types";

// ── a controllable world ──────────────────────────────────────────────────────────────
class World {
  clock = 1_000_000;
  up = true;
  sent: Array<{ frame: Uint8Array; appId: number; seq: number; sourceId: string }> = [];
  events: DataEvent[] = [];
  failSend: string | null = null;

  now = () => this.clock;
  linkUp = () => this.up;
  log = (ev: DataEvent) => void this.events.push(ev);
  send = async (frame: Uint8Array, meta: { appId: number; seq: number; sourceId: string }) => {
    if (this.failSend) throw new Error(this.failSend);
    this.sent.push({ frame, ...meta });
  };
  kinds = () => this.events.map((e) => e.kind);
  /** the FFSC body inside the last FXP1 frame we "sent" */
  lastBody = () => decodeFfsc(this.sent[this.sent.length - 1].frame.slice(12));
}

function source(id: string, appId: number, everyMs: number, next: () => Uint8Array | Error): DataSource {
  return {
    id,
    appId,
    everyMs,
    async fetch() {
      const v = next();
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

const bytes = (...n: number[]) => Uint8Array.from(n);

let w: World;
beforeEach(() => {
  w = new World();
});

describe("the happy path", () => {
  it("polls, encodes and sends one value", async () => {
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(1, 2, 3))], ...w });
    await pump.tick();
    expect(w.sent.length).toBe(1);
    const body = w.lastBody();
    expect(body.appId).toBe(3);
    expect(body.seq).toBe(1);
    expect(Array.from(body.blob)).toEqual([1, 2, 3]);
    expect(w.kinds()).toEqual(["fetched", "sent"]);
    expect(pump.stats.sends).toBe(1);
  });

  it("respects the poll interval, and refresh() overrides it", async () => {
    let n = 0;
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(++n))], ...w });
    await pump.tick();
    w.clock += 500;
    await pump.tick();
    expect(pump.stats.polls).toBe(1); // not due yet

    pump.refresh("s");
    await pump.tick();
    expect(pump.stats.polls).toBe(2);
    expect(w.sent.length).toBe(2);
    expect(w.lastBody().seq).toBe(2); // ★ the seq CHANGED — the glasses will not dedupe it
  });

  it("gives each app its own channel and its own seq run", async () => {
    const pump = new DataPump({
      sources: [source("a", 3, 1000, () => bytes(1)), source("b", 7, 1000, () => bytes(2))],
      ...w,
    });
    await pump.tick();
    expect(w.sent.map((s) => [s.appId, s.seq])).toEqual([
      [3, 1],
      [7, 1],
    ]);
  });
});

describe("nothing changed", () => {
  it("does not re-send an identical value", async () => {
    const pump = new DataPump({ sources: [source("s", 3, 0, () => bytes(9, 9))], ...w });
    await pump.tick();
    await pump.tick();
    await pump.tick();
    expect(w.sent.length).toBe(1);
    expect(pump.stats.unchanged).toBe(2);
  });

  it("forgetLanded() re-sends it — the escape hatch for a rebooted pair", async () => {
    const pump = new DataPump({ sources: [source("s", 3, 0, () => bytes(9, 9))], ...w });
    await pump.tick();
    pump.forgetLanded(3);
    await pump.tick();
    expect(w.sent.length).toBe(2);
    expect(w.lastBody().seq).toBe(2);
  });
});

describe("the source fails", () => {
  it("keeps quiet and says so, rather than sending an empty screen", async () => {
    const pump = new DataPump({ sources: [source("s", 3, 0, () => new Error("HTTP 503 from x"))], ...w });
    await pump.tick();
    expect(w.sent.length).toBe(0);
    expect(w.kinds()).toEqual(["fetch-failed"]);
    expect(pump.stats.fetchFailures).toBe(1);
  });

  it("a failed poll does not lose the value the glasses already hold", async () => {
    let fail = false;
    const pump = new DataPump({
      sources: [source("s", 3, 0, () => (fail ? new Error("boom") : bytes(4, 4)))],
      ...w,
    });
    await pump.tick();
    fail = true;
    await pump.tick();
    await pump.tick();
    // exactly ONE send, and no CLEAR was ever emitted: the glasses still show 04 04
    expect(w.sent.length).toBe(1);
    expect(w.sent.every((s) => decodeFfsc(s.frame.slice(12)).op === 0)).toBe(true);
  });

  it("truncates a long error rather than shipping it whole", async () => {
    const pump = new DataPump({ sources: [source("s", 3, 0, () => new Error("x".repeat(500)))], ...w });
    await pump.tick();
    const ev = w.events[0] as Extract<DataEvent, { kind: "fetch-failed" }>;
    expect(ev.error.length).toBeLessThanOrEqual(121);
  });
});

describe("the blob is too big", () => {
  it("is refused HERE, with the source named, not on the glasses", async () => {
    const pump = new DataPump({ sources: [source("s", 3, 0, () => new Uint8Array(2000))], ...w });
    await pump.tick();
    expect(w.sent.length).toBe(0);
    const ev = w.events.find((e) => e.kind === "too-big") as Extract<DataEvent, { kind: "too-big" }>;
    expect(ev.source).toBe("s");
    expect(ev.bytes).toBe(2000);
    expect(ev.cap).toBe(1024);
  });
});

describe("the link drops", () => {
  it("holds the value and sends it when the link returns", async () => {
    w.up = false;
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(5))], ...w });
    await pump.tick();
    expect(w.sent.length).toBe(0);
    expect(w.kinds()).toEqual(["fetched", "holding"]);
    expect(pump.outbox.size).toBe(1);

    w.up = true;
    await pump.drain();
    expect(w.sent.length).toBe(1);
    expect(pump.outbox.size).toBe(0);
  });

  it("★ DROPS the stale value rather than queueing it — latest wins", async () => {
    w.up = false;
    let n = 0;
    const pump = new DataPump({ sources: [source("s", 3, 0, () => bytes(++n))], ...w });
    await pump.tick(); // value 1 held
    await pump.tick(); // value 2 supersedes it
    await pump.tick(); // value 3 supersedes that
    expect(pump.outbox.size).toBe(1);
    expect(pump.stats.superseded).toBe(2);

    w.up = true;
    await pump.drain();
    expect(w.sent.length).toBe(1);
    expect(Array.from(w.lastBody().blob)).toEqual([3]); // the CURRENT value, not the oldest
  });

  it("a failed send keeps the value and counts the attempt", async () => {
    w.failSend = "write timed out";
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(6))], ...w });
    await pump.tick();
    expect(pump.outbox.size).toBe(1);
    const ev = w.events.find((e) => e.kind === "send-failed") as Extract<DataEvent, { kind: "send-failed" }>;
    expect(ev.attempts).toBe(1);

    await pump.drain();
    expect(pump.outbox.pending()[0].attempts).toBe(2);

    w.failSend = null;
    await pump.drain();
    expect(w.sent.length).toBe(1);
    expect(pump.outbox.size).toBe(0);
  });

  it("a failed send does not mark the value as landed", async () => {
    w.failSend = "nope";
    const pump = new DataPump({ sources: [source("s", 3, 0, () => bytes(7))], ...w });
    await pump.tick();
    w.failSend = null;
    await pump.tick(); // same bytes — must NOT be skipped as "unchanged"
    expect(w.sent.length).toBe(1);
    expect(pump.stats.unchanged).toBe(0);
  });
});

describe("nothing about this leaks content", () => {
  it("no event carries the blob or anything derived from it but a byte count", async () => {
    const secret = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const pump = new DataPump({ sources: [source("s", 3, 0, () => secret)], ...w });
    await pump.tick();
    const json = JSON.stringify(w.events);
    expect(json).not.toContain("222"); // 0xde
    expect(json).not.toContain("dead");
    for (const ev of w.events) {
      expect(Object.values(ev).every((v) => typeof v !== "object")).toBe(true);
    }
  });
});

describe("the outbox on its own", () => {
  it("an acknowledgement for a superseded seq does not drop the newer value", () => {
    const box = new Outbox();
    const first = box.offer(3, "s", bytes(1), 0).entry;
    const second = box.offer(3, "s", bytes(2), 1).entry;
    expect(box.settle(3, first.seq)).toBe(false);
    expect(box.size).toBe(1);
    expect(box.settle(3, second.seq)).toBe(true);
    expect(box.size).toBe(0);
  });

  it("holds at most one entry per app, whatever you throw at it", () => {
    const box = new Outbox();
    for (let i = 0; i < 500; i++) box.offer(3, "s", bytes(i & 0xff), i);
    for (let i = 0; i < 500; i++) box.offer(7, "s", bytes(i & 0xff), i);
    expect(box.size).toBe(2);
  });

  it("wraps seq at 16 bits", () => {
    const box = new Outbox();
    for (let i = 0; i < 0x10000; i++) box.offer(3, "s", bytes(1), i);
    expect(box.lastSeq(3)).toBe(0);
  });

  it("drains the value that has been stuck longest first", () => {
    const box = new Outbox();
    box.offer(7, "s", bytes(1), 100);
    box.offer(3, "s", bytes(2), 50);
    expect(box.pending().map((p) => p.appId)).toEqual([3, 7]);
  });
});

// ── the circuit-breaker: a crashing LOOP must never continue on its own ────────────────
describe("the circuit-breaker", () => {
  // One send + one crash-correlated drop is ambiguous (it also looks like a normal reconnect),
  // so it is allowed to resend once. A crash LOOP — the resend that ALSO drops — is what trips.
  async function sendThenDrop(pump: DataPump, w: World, v: { n: number }) {
    v.n += 1;
    pump.forgetLanded();
    pump.refresh();
    await pump.tick();
    w.clock += 1_000;              // the lens crashes ~1 s after the push
    pump.noteLinkDown(w.now());
    w.clock += 3_000;              // ...and reconnects
    w.up = true;
  }

  it("survives one crash-correlated drop (allows the reconnect resend), trips on the second", async () => {
    const v = { n: 0 };
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(v.n))], ...w });

    await sendThenDrop(pump, w, v);        // cycle 1
    expect(pump.isTripped(3)).toBe(false); // one drop is ambiguous — not tripped
    expect(w.sent.length).toBe(1);

    await sendThenDrop(pump, w, v);        // cycle 2 — the resend crashed too: a LOOP
    expect(pump.isTripped(3)).toBe(true);
    expect(w.kinds()).toContain("breaker-tripped");

    // now withheld: a fresh value with the link up is NOT auto-sent
    v.n += 1;
    pump.forgetLanded();
    pump.refresh();
    await pump.tick();
    expect(w.kinds()).toContain("breaker-blocked");
    expect(pump.stats.breakerBlocked).toBeGreaterThan(0);
  });

  it("re-arms only on an explicit resetBreaker(), then delivers", async () => {
    const v = { n: 0 };
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(v.n))], ...w });
    await sendThenDrop(pump, w, v);
    await sendThenDrop(pump, w, v);
    expect(pump.isTripped(3)).toBe(true);
    const before = w.sent.length;

    pump.resetBreaker(3);                    // the deliberate manual retry
    expect(pump.isTripped(3)).toBe(false);
    expect(w.kinds()).toContain("breaker-reset");

    v.n += 1;
    pump.forgetLanded();
    pump.refresh();
    await pump.tick();
    expect(w.sent.length).toBe(before + 1);  // it goes out again
  });

  it("does NOT trip on two drops that are far apart (unrelated disconnects, not a loop)", async () => {
    const v = { n: 0 };
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(v.n))], ...w });
    await sendThenDrop(pump, w, v);
    w.clock += 120_000;                      // two minutes later — the strike has decayed
    await sendThenDrop(pump, w, v);
    expect(pump.isTripped(3)).toBe(false);
  });

  it("does NOT trip on a drop long after the last send (an ordinary disconnect)", async () => {
    const pump = new DataPump({ sources: [source("s", 3, 1000, () => bytes(1))], ...w });
    await pump.tick();
    w.clock += 60_000;
    pump.noteLinkDown(w.now());
    expect(pump.isTripped(3)).toBe(false);
  });
});
