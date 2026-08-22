// The native-push acknowledgement LOOP, stated as tests rather than as hope.
//
// PushAckController is pure: every side effect (pushPayload, requestDeviceInfo, schedule,
// setStatus, log) is injected, so "the loader is absent", "the link dropped mid-ack", "the
// poll timed out" and "a foreign frame came back" are all ordinary branches here instead of
// things nobody finds out about until a HUD is blank on someone's face. It used to live
// inline in App.tsx where none of this was reachable without a phone and glasses.

import { beforeEach, describe, expect, it } from "bun:test";
import { PushAckController, type DeviceVersions } from "../pushAckController";
import { toBase64 } from "../../sdk/base64";

// ── a controllable world ──────────────────────────────────────────────────────────────
type Scheduled = { fn: () => void; ms: number };

class World {
  statuses: string[] = [];
  logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  pushed: string[] = [];
  reads = 0;
  scheduled: Scheduled[] = [];

  deps = {
    pushPayload: (b64: string) => void this.pushed.push(b64),
    requestDeviceInfo: () => void (this.reads += 1),
    setStatus: (msg: string) => void this.statuses.push(msg),
    schedule: (fn: () => void, ms: number) => void this.scheduled.push({ fn, ms }),
    log: (event: string, data: Record<string, unknown>) => void this.logs.push({ event, data }),
  };

  status = () => this.statuses[this.statuses.length - 1];
  events = () => this.logs.map((l) => l.event);
  /** Fire the oldest pending timer (a callback may schedule more). Returns its delay. */
  runNextTimer(): number {
    const t = this.scheduled.shift();
    if (!t) throw new Error("no timer pending");
    t.fn();
    return t.ms;
  }
}

// A ⟨LOADER⟩ device-info line, exactly as the CFW appends it to the L-lens version string.
const line = (o: Partial<{ gen: number; ran: number; len: number; rxlen: number; rej: number }> = {}) =>
  `2.2.7.14 ⟨LOADER gen=${o.gen ?? 8} ran=${o.ran ?? 8} ret=0x7E8000FF ` +
  `len=${o.len ?? 618} calls=9 rxlen=${o.rxlen ?? 630} first4=0x31505846 ` +
  `rej=${o.rej ?? 0}/NONE(accepted)⟩`;

// A canonical base64 frame of exactly `n` bytes — frameLen the controller measures.
const frameOf = (n: number) => toBase64(new Uint8Array(n));
const FRAME = frameOf(630); // rxlen 630, body len 618 — matches line() above
const di = (v: string | null): DeviceVersions => ({ leftVersion: v, rightVersion: null });

let w: World;
let c: PushAckController;
beforeEach(() => {
  w = new World();
  c = new PushAckController(w.deps);
});

describe("the guard", () => {
  it("does nothing when the pair is not ready", () => {
    c.guardedPush("A", "push_a", FRAME, di(line()), false);
    expect(w.pushed.length).toBe(0);
    expect(w.statuses.length).toBe(0);
    expect(w.reads).toBe(0);
  });

  it("sends immediately when the loader is already advertised, and arms the ack", () => {
    c.guardedPush("A", "push_a", FRAME, di(line({ gen: 7, ran: 7 })), true);
    expect(w.pushed).toEqual([FRAME]);
    expect(w.events()).toContain("push_a");
    expect(w.status()).toMatch(/waiting for attributed loader execution/);
    // a 2500 ms self-poll is scheduled after the send
    expect(w.scheduled.length).toBe(1);
    expect(w.scheduled[0].ms).toBe(2500);
  });

  it("blocks a second push while one is still awaiting attribution", () => {
    c.guardedPush("A", "push_a", FRAME, di(line({ gen: 7, ran: 7 })), true);
    c.guardedPush("B", "push_b", FRAME, di(line({ gen: 7, ran: 7 })), true);
    expect(w.pushed.length).toBe(1); // only A went out
    expect(w.status()).toMatch(/another payload is still awaiting/);
  });

  it("refuses a payload that is not canonical base64 instead of pushing garbage", () => {
    // loader present so we reach the send path; the frame itself is the problem.
    c.guardedPush("A", "push_a", "not-base64!", di(line({ gen: 7, ran: 7 })), true);
    expect(w.pushed.length).toBe(0);
    expect(w.status()).toMatch(/PUSH BLOCKED — A:/);
  });
});

describe("parking a push until the loader is proven", () => {
  it("parks + reads device info when no loader is advertised yet, then sends on the marker", () => {
    // No ⟨LOADER⟩ yet → park and read.
    c.guardedPush("A", "push_a", FRAME, di("2.2.7.14"), true);
    expect(w.pushed.length).toBe(0);
    expect(w.reads).toBe(1);
    expect(w.status()).toMatch(/checking the glasses for the OTA loader/);

    // The readback lands WITH a loader record → the parked push fires.
    c.onDeviceInfo(line({ gen: 7, ran: 7 }), null);
    expect(w.pushed).toEqual([FRAME]);
    expect(w.events()).toContain("push_a");
  });

  it("concludes 'no loader' only after three marker-less readbacks", () => {
    c.guardedPush("A", "push_a", FRAME, di("2.2.7.14"), true);
    // readback 1 and 2: still no marker → re-read, do not give up
    c.onDeviceInfo("2.2.7.14", null);
    c.onDeviceInfo("2.2.7.14", null);
    expect(w.status()).toMatch(/checking the glasses/);
    expect(w.events()).not.toContain("push_blocked");
    // readback 3: give up
    c.onDeviceInfo("2.2.7.14", null);
    expect(w.status()).toMatch(/no OTA loader on the glasses/);
    expect(w.events()).toContain("push_blocked");
    expect(w.pushed.length).toBe(0);
  });
});

describe("attributing the ack", () => {
  // Arm an ack and run its 2500 ms self-poll, so pollScheduled is false and the next
  // readback is attributable (mirrors the real send → self-poll → readback sequence).
  function armed() {
    c.guardedPush("A", "push_a", FRAME, di(line({ gen: 7, ran: 7 })), true);
    w.runNextTimer(); // the 2500 ms self-poll: clears pollScheduled, fires one read
  }

  it("accepts a fresh exact frame", () => {
    armed();
    c.onDeviceInfo(line({ gen: 8, ran: 8, rxlen: 630, len: 618 }), null);
    expect(w.status()).toMatch(/✅ loader ran A/);
    expect(w.events()).toContain("push_acked");
    // ack cleared: a further push is allowed
    c.guardedPush("B", "push_b", FRAME, di(line({ gen: 8, ran: 8 })), true);
    expect(w.pushed.length).toBe(2);
  });

  it("fails a rejected frame", () => {
    armed();
    c.onDeviceInfo(line({ gen: 8, ran: 8, rej: 6 }), null);
    expect(w.status()).toMatch(/PUSH FAILED — A: loader rejected/);
    expect(w.events()).toContain("push_failed");
  });

  it("fails a foreign frame whose rxlen does not match", () => {
    armed();
    c.onDeviceInfo(line({ gen: 8, ran: 8, rxlen: 629 }), null);
    expect(w.status()).toMatch(/PUSH FAILED — A: foreign frame rxlen=629/);
  });

  it("polls, then gives up as UNCONFIRMED after four pending readbacks", () => {
    armed(); // pollScheduled is now false
    // Each pending readback increments tries and schedules a 1200 ms re-poll; that poll must
    // fire (clearing pollScheduled) before the next readback counts. The generation never
    // advances past the baseline, so every readback stays "pending".
    for (let i = 1; i <= 3; i++) {
      c.onDeviceInfo(line({ gen: 7, ran: 7 }), null); // gen == baseline → "pending", tries=i
      expect(w.status()).not.toMatch(/UNCONFIRMED/);
      expect(w.runNextTimer()).toBe(1200); // the re-poll — clears pollScheduled, reads again
    }
    // the 4th pending readback trips the tries>=4 ceiling
    c.onDeviceInfo(line({ gen: 7, ran: 7 }), null);
    expect(w.status()).toMatch(/PUSH UNCONFIRMED — A/);
    expect(w.events()).toContain("push_unconfirmed");
  });

  it("a scheduled poll re-reads device info (only while its ack is still current)", () => {
    c.guardedPush("A", "push_a", FRAME, di(line({ gen: 7, ran: 7 })), true);
    expect(w.reads).toBe(0);
    const ms = w.runNextTimer(); // the 2500 ms self-poll
    expect(ms).toBe(2500);
    expect(w.reads).toBe(1); // it fired a device-info read
  });

  it("a stale poll after acceptance does not re-read", () => {
    c.guardedPush("A", "push_a", FRAME, di(line({ gen: 7, ran: 7 })), true);
    c.onDeviceInfo(line({ gen: 8, ran: 8 }), null); // accepted → ack cleared
    const readsBefore = w.reads;
    w.runNextTimer(); // the old 2500 ms poll fires late — token no longer matches
    expect(w.reads).toBe(readsBefore);
  });
});

describe("the link drops mid-ack", () => {
  it("fails an in-flight ack loudly and clears a parked push", () => {
    c.guardedPush("A", "push_a", FRAME, di(line({ gen: 7, ran: 7 })), true);
    c.onLinkDropped();
    expect(w.status()).toMatch(/link dropped before loader acknowledgement/);
    const failed = w.logs.find((l) => l.event === "push_failed");
    expect(failed?.data.reason).toBe("link_dropped_before_ack");
    // ack is gone: a new push is accepted again
    c.guardedPush("B", "push_b", FRAME, di(line({ gen: 7, ran: 7 })), true);
    expect(w.pushed.length).toBe(2);
  });

  it("is a no-op when nothing is in flight", () => {
    c.onLinkDropped();
    expect(w.statuses.length).toBe(0);
    expect(w.logs.length).toBe(0);
  });
});

describe("the loader-seen latch", () => {
  it("stays seen once a marker has appeared, even for an empty later readback", () => {
    expect(c.loaderPresent(null)).toBe(false);
    c.onDeviceInfo(line(), null); // a marker appears
    expect(c.loaderSeen).toBe(true);
    expect(c.loaderPresent(null)).toBe(true); // latched — survives a marker-less readback
    expect(c.loaderPresent(di("2.2.7.14"))).toBe(true);
  });

  it("reads a live marker before it has ever latched", () => {
    expect(c.loaderPresent(di(line()))).toBe(true);
    expect(c.loaderPresent(di("2.2.7.14"))).toBe(false);
  });
});

describe("recognising a freshly flashed image (⟨CAPS⟩ EVENCFW, no push receipt yet)", () => {
  // A caps-only readback: the CFW advertises itself on every device-info read via ⟨CAPS=EVENCFW…⟩
  // BEFORE any payload is pushed, so there is no ⟨LOADER⟩ receipt block. This is the exact state
  // after a fresh firmware flash + fresh app install that made the Music app show "no music": the
  // data-plane gate (canSend = pairReady && loaderPresent) refused to push media frames.
  const caps = "2.2.7.14  ⟨CAPS=EVENCFW/1 img576 imgz xordelta stereo fontprobe rxok peer=1⟩";

  it("loaderPresent is TRUE on a caps-only readback — media frames can flow", () => {
    expect(caps.includes("LOADER")).toBe(false); // guard: genuinely receipt-free
    expect(c.loaderPresent(di(caps))).toBe(true);
  });

  it("a caps-only readback latches loaderSeen (survives a later marker-less readback)", () => {
    c.onDeviceInfo(caps, null);
    expect(c.loaderSeen).toBe(true);
    expect(c.loaderPresent(null)).toBe(true);
    expect(c.loaderPresent(di("2.2.7.14"))).toBe(true); // latched
  });

  it("stays FALSE on stock firmware — the destructive-push guard is preserved", () => {
    expect(c.loaderPresent(di("2.2.7.14"))).toBe(false);
    c.onDeviceInfo("2.2.7.14", "2.2.7.14"); // a stock readback must never latch
    expect(c.loaderSeen).toBe(false);
    expect(c.loaderPresent(di("2.2.7.14"))).toBe(false);
  });
});
