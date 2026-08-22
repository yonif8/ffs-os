// Reply / act-back, as tests. The dispatcher is pure with the two native calls injected, so every
// path — RemoteInput, the SMS fallback, no-path, validation, de-dup, and the privacy contract —
// runs with no phone.
//
// ⛔ Every reply body here is INVENTED. `ffs_os` is PUBLIC.

import { describe, expect, it } from "bun:test";

import { ReplyDispatcher, type ReplyTarget } from "../actions";

const KEY = "com.whatsapp|thread-1";
const remoteTarget: ReplyTarget = { key: KEY, canRemoteInput: true };
const smsTarget: ReplyTarget = { key: "com.android.messaging|t2", canRemoteInput: false, smsAddress: "+15550000" };

describe("ReplyDispatcher", () => {
  it("sends over the thread's own RemoteInput action (the RCS-preserving path)", () => {
    const calls: Array<[string, string]> = [];
    const d = new ReplyDispatcher({ remoteInput: (k, t) => (calls.push([k, t]), true) });
    const out = d.reply(remoteTarget, "on my way", "r1");
    expect(out).toEqual({ ok: true, via: "remote-input" });
    expect(calls).toEqual([[KEY, "on my way"]]);
  });

  it("falls back to SMS only when there is no RemoteInput and an address is known", () => {
    const sms: Array<[string, string]> = [];
    const d = new ReplyDispatcher({
      remoteInput: () => false,
      sms: (a, t) => (sms.push([a, t]), true),
    });
    const out = d.reply(smsTarget, "running late", "r1");
    expect(out).toEqual({ ok: true, via: "sms" });
    expect(sms).toEqual([["+15550000", "running late"]]);
  });

  it("prefers RemoteInput even when an SMS address is also present", () => {
    let smsUsed = false;
    const d = new ReplyDispatcher({
      remoteInput: () => true,
      sms: () => ((smsUsed = true), true),
    });
    const out = d.reply({ key: KEY, canRemoteInput: true, smsAddress: "+1555" }, "hi", "r1");
    expect(out.via).toBe("remote-input");
    expect(smsUsed).toBe(false);
  });

  it("reports no path when there is neither RemoteInput nor an SMS fallback", () => {
    const d = new ReplyDispatcher({ remoteInput: () => false });
    expect(d.reply({ key: KEY, canRemoteInput: false }, "hello", "r1")).toEqual({
      ok: false,
      via: "none",
      reason: "no-reply-path",
    });
  });

  it("rejects an empty or whitespace-only reply without firing anything", () => {
    let fired = false;
    const d = new ReplyDispatcher({ remoteInput: () => ((fired = true), true) });
    expect(d.reply(remoteTarget, "   ", "r1").reason).toBe("empty");
    expect(fired).toBe(false);
  });

  it("rejects an over-long reply", () => {
    const d = new ReplyDispatcher({ remoteInput: () => true, maxLen: 5 });
    expect(d.reply(remoteTarget, "way too long", "r1").reason).toBe("too-long");
  });

  it("swallows a double-tapped send with the same requestId inside the window", () => {
    let n = 0;
    const d = new ReplyDispatcher({ remoteInput: () => (n++, true), now: () => 1000 });
    expect(d.reply(remoteTarget, "yes", "confirm-A").via).toBe("remote-input");
    const second = d.reply(remoteTarget, "yes", "confirm-A");
    expect(second.via).toBe("deduped");
    expect(second.ok).toBe(true);
    expect(n).toBe(1); // fired exactly once
  });

  it("lets the SAME requestId through again once the window has passed", () => {
    let clock = 1000;
    let n = 0;
    const d = new ReplyDispatcher({ remoteInput: () => (n++, true), now: () => clock, dedupMs: 5000 });
    d.reply(remoteTarget, "yes", "c");
    clock += 6000;
    expect(d.reply(remoteTarget, "yes", "c").via).toBe("remote-input");
    expect(n).toBe(2);
  });

  it("does NOT de-dup a validation reject — a corrected reply can be sent at once", () => {
    let n = 0;
    const d = new ReplyDispatcher({ remoteInput: () => (n++, true) });
    expect(d.reply(remoteTarget, "", "r1").reason).toBe("empty");
    expect(d.reply(remoteTarget, "actual text", "r1").via).toBe("remote-input");
    expect(n).toBe(1);
  });

  it("treats a throwing native call as a failed send, not a crash", () => {
    const d = new ReplyDispatcher({
      remoteInput: () => {
        throw new Error("PendingIntent canceled");
      },
    });
    expect(d.reply(remoteTarget, "hi", "r1")).toEqual({ ok: false, via: "none", reason: "remote-input-failed" });
  });

  it("a reply body never appears in any outcome — outcomes are status only", () => {
    const BODY = "ZZ-REPLY-BODY-3f8a-DO-NOT-LEAK";
    const outcomes: unknown[] = [];
    const d = new ReplyDispatcher({ remoteInput: () => true, sms: () => true });
    outcomes.push(d.reply(remoteTarget, BODY, "r1"));
    outcomes.push(d.reply(smsTarget, BODY, "r2"));
    outcomes.push(d.reply({ key: "x|y", canRemoteInput: false }, BODY, "r3"));
    outcomes.push(d.reply(remoteTarget, "", "r4"));
    expect(JSON.stringify(outcomes)).not.toContain(BODY);
    expect(JSON.stringify(outcomes)).not.toContain("REPLY-BODY");
  });
});
