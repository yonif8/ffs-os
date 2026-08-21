// The notification bridge, stated as tests.
//
// Two kinds of test live here and the second kind is the point:
//
//   1. BEHAVIOUR — ordering, age quantisation, and what a burst / a dropped link / an empty store
//      actually do, run end-to-end through the real `DataPump` with an injected world.
//
//   2. ⭐ THE PRIVACY CONTRACT, ENFORCED. A message body must never reach a log, a telemetry
//      record, an event payload or this repo. Those are structural claims, so they are checked
//      structurally: one test drives a body with a unique marker through the whole pipeline and
//      fails if the marker appears in ANY emitted metadata; others read the source files and fail
//      if the shapes that carry metadata gain a non-numeric field, if the listener gains a log
//      call, or if the two copies of the allowlist drift apart.
//
// ⛔ Every message in this file is INVENTED. `ffs_os` is PUBLIC — a real message in a fixture is
//    the same mistake as a rig photo in this repo, and it is permanent.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DataPump } from "../pump";
import { notificationsSource, quantiseAgeMin, threadsToFfsm } from "../sources/notifications";
import { DEFAULT_ALLOW, KNOWN_MESSAGING, looksSensitive, normaliseAllowlist } from "../../notifications/allowlist";
import { decodeFfsm } from "../../sdk/ffsm";
import { decodeFfsc } from "../../sdk/ffsc";
import type { DataEvent } from "../types";

const REPO = join(import.meta.dir, "..", "..", "..");
const KOTLIN_ALLOWLIST = join(REPO, "modules", "ffs-notify", "android", "src", "main", "java", "expo", "modules", "ffsnotify", "Allowlist.kt");
const KOTLIN_LISTENER = join(REPO, "modules", "ffs-notify", "android", "src", "main", "java", "expo", "modules", "ffsnotify", "FfsNotificationListener.kt");
const KOTLIN_STORE = join(REPO, "modules", "ffs-notify", "android", "src", "main", "java", "expo", "modules", "ffsnotify", "NotifyStore.kt");
const TS_NATIVE = join(REPO, "modules", "ffs-notify", "src", "FfsNotifyModule.ts");

const MIN = 60_000;
const NOW = 1_800_000_000_000;

// An invented inbox. `msg()` takes an age in minutes so the cases read like the screen does.
const msg = (agoMin: number, body: string, fromMe = false) => ({ fromMe, atMs: NOW - agoMin * MIN, body });
const thread = (name: string, pkg: string, messages: Array<ReturnType<typeof msg>>, unread = true) => ({
  pkg,
  name,
  unread,
  lastAtMs: Math.max(...messages.map((m) => m.atMs)),
  messages,
});

// ── 1. mapping ────────────────────────────────────────────────────────────────────────────

describe("threadsToFfsm", () => {
  it("lists threads newest-activity first and messages oldest first", () => {
    // ★ Both orders are load-bearing: the inbox draws threads in list order, and the app opens a
    //   thread at its LAST message. Reversed, this renders perfectly and shows the wrong thing.
    const out = threadsToFfsm(
      [
        thread("Mum", "com.whatsapp", [msg(90, "call me"), msg(80, "when you can")]),
        thread("Sarah", "org.thoughtcrime.securesms", [msg(30, "older"), msg(4, "newest")]),
      ],
      NOW,
    );
    expect(out.map((t) => t.name)).toEqual(["Sarah", "Mum"]);
    expect(out[0].messages.map((m) => m.body)).toEqual(["older", "newest"]);
  });

  it("survives messages that arrive out of order", () => {
    const out = threadsToFfsm([thread("Dan", "com.whatsapp", [msg(2, "b"), msg(9, "a"), msg(5, "c")])], NOW);
    expect(out[0].messages.map((m) => m.body)).toEqual(["a", "c", "b"]);
  });

  it("drops an empty thread rather than encoding one the glasses would REFUSE", () => {
    // ms_valid() rejects the whole blob over a thread with zero messages — which surfaces as
    // "the app won't launch", about as far from the cause as a symptom can get.
    const out = threadsToFfsm(
      [thread("Ghost", "com.whatsapp", []), thread("Real", "com.whatsapp", [msg(1, "hi")])],
      NOW,
    );
    expect(out.map((t) => t.name)).toEqual(["Real"]);
  });

  it("throws when there is nothing to show — an empty inbox is not a screen", () => {
    expect(() => threadsToFfsm([], NOW)).toThrow(/nothing held/);
  });

  it("keeps the sent/received distinction", () => {
    const out = threadsToFfsm([thread("Sarah", "com.whatsapp", [msg(5, "them"), msg(1, "me", true)])], NOW);
    expect(out[0].messages.map((m) => m.fromMe)).toEqual([false, true]);
  });
});

describe("quantiseAgeMin", () => {
  it("matches what ms_age() actually draws, so an unchanged screen costs no push", () => {
    expect(quantiseAgeMin(0)).toBe(0);
    expect(quantiseAgeMin(4.9)).toBe(4);
    expect(quantiseAgeMin(59)).toBe(59);
    expect(quantiseAgeMin(60)).toBe(60); // "1h"
    expect(quantiseAgeMin(119)).toBe(60); // still "1h" — same bytes, no push
    expect(quantiseAgeMin(120)).toBe(120); // "2h"
    expect(quantiseAgeMin(1439)).toBe(1380);
    expect(quantiseAgeMin(1440)).toBe(1440); // "1d"
    expect(quantiseAgeMin(2879)).toBe(1440); // still "1d"
    expect(quantiseAgeMin(-5)).toBe(0); // a phone clock that ran backwards is not negative age
  });
});

// ── 2. the world, for end-to-end runs through the real pump ───────────────────────────────

class World {
  clock = NOW;
  up = true;
  threads: Array<ReturnType<typeof thread>> = [];
  sent: Uint8Array[] = [];
  events: DataEvent[] = [];

  pump(everyMs = MIN): DataPump {
    return new DataPump({
      sources: [notificationsSource({ read: () => this.threads, everyMs })],
      send: async (frame) => {
        this.sent.push(frame);
      },
      linkUp: () => this.up,
      now: () => this.clock,
      log: (ev) => this.events.push(ev),
    });
  }

  /**
   * The FFSM blob of the Nth push, decoded the way the glasses' parser would read it: strip the
   * 12-byte FXP1 header, read the FFSC channel header (which verifies the value's own CRC), then
   * run `decodeFfsm`, which mirrors `ms_valid()`. A test that only counted frames would pass
   * while shipping bytes the app refuses.
   */
  decode(i: number) {
    return decodeFfsm(decodeFfsc(this.sent[i].slice(12)).blob);
  }
}

describe("the pipeline end to end", () => {
  it("a burst of twenty arrivals is ONE push carrying the newest state", async () => {
    // ★ The design answer to "what happens on a burst", and it is inherited rather than invented:
    //   the native store merges (messaging apps re-post the whole history), and the outbox is
    //   latest-wins with no queue. Twenty messages inside one interval = one push, not twenty,
    //   and never a backlog that replays stale screens after a reconnect.
    const w = new World();
    const p = w.pump();
    for (let i = 1; i <= 20; i++) {
      w.threads = [thread("Sarah", "com.whatsapp", Array.from({ length: Math.min(i, 12) }, (_, k) => msg(20 - i + k, `m${i}-${k}`)))];
      p.refresh(); // each arrival nudges the source
      await p.poll();
    }
    await p.drain();
    expect(w.sent.length).toBe(1);
    expect(w.events.filter((e) => e.kind === "superseded").length).toBe(19);
    expect(w.decode(0)[0].messages.length).toBe(12);
  });

  it("a dropped link holds the value and delivers the CURRENT one on reconnect", async () => {
    const w = new World();
    const p = w.pump();
    w.up = false;
    w.threads = [thread("Sarah", "com.whatsapp", [msg(5, "stale one")])];
    await p.tick();
    expect(w.sent.length).toBe(0);
    expect(w.events.some((e) => e.kind === "holding")).toBe(true);

    w.clock += 4 * MIN;
    w.threads = [thread("Sarah", "com.whatsapp", [msg(9, "stale one"), msg(0, "the current one")])];
    p.refresh();
    w.up = true;
    await p.tick();

    expect(w.sent.length).toBe(1);
    const bodies = w.decode(0)[0].messages.map((m) => m.body);
    expect(bodies).toEqual(["stale one", "the current one"]); // one screen, already up to date
  });

  it("says nothing at all while nothing has arrived, instead of pushing an empty screen", async () => {
    const w = new World();
    const p = w.pump();
    await p.tick();
    expect(w.sent.length).toBe(0);
    expect(w.events.some((e) => e.kind === "fetch-failed")).toBe(true);
  });

  it("re-pushes only when the age the glasses DRAW would change", async () => {
    const w = new World();
    const p = w.pump(1); // poll every tick; the dedupe must be the thing that stays quiet
    w.threads = [thread("Sarah", "com.whatsapp", [msg(0, "on my way")])];
    await p.tick();
    expect(w.sent.length).toBe(1);

    w.clock += 30_000; // still "0m"
    p.refresh();
    await p.tick();
    expect(w.sent.length).toBe(1);
    expect(w.events.some((e) => e.kind === "unchanged")).toBe(true);

    w.clock += 40_000; // now "1m"
    p.refresh();
    await p.tick();
    expect(w.sent.length).toBe(2);
  });

  it("is disabled cleanly when the listener is not granted", async () => {
    const w = new World();
    const p = new DataPump({
      sources: [notificationsSource({ read: () => w.threads, enabled: () => false })],
      send: async (f) => void w.sent.push(f),
      linkUp: () => true,
      now: () => w.clock,
      log: (ev) => w.events.push(ev),
    });
    w.threads = [thread("Sarah", "com.whatsapp", [msg(1, "hello")])];
    await p.tick();
    expect(w.sent.length).toBe(0);
    const failed = w.events.find((e) => e.kind === "fetch-failed");
    expect(failed && "error" in failed ? failed.error : "").toMatch(/listener not enabled/);
  });
});

// ── 3. ⭐ the privacy contract, enforced ──────────────────────────────────────────────────

describe("privacy", () => {
  it("NO message content reaches any log, event or telemetry record", async () => {
    // The whole pipeline runs with a marker string as the body. `src/os/log.ts` ships every
    // structured record off-device to a Cloudflare collector and our tooling greps logcat
    // constantly, so a body in a DataEvent is a body on a PC in another room. This test is the
    // thing that notices.
    const MARKER = "ZZ-MARKER-BODY-9f31c7-DO-NOT-LEAK";
    const SENDER = "ZZ-MARKER-SENDER-4b02de";
    const w = new World();
    const p = w.pump(1);
    w.threads = [thread(SENDER, "com.whatsapp", [msg(3, MARKER), msg(1, `re: ${MARKER}`, true)])];
    await p.tick();
    w.up = false;
    w.clock += 5 * MIN;
    p.refresh();
    await p.tick(); // exercise the holding/superseded paths too
    w.threads = [];
    p.refresh();
    await p.tick(); // ...and the failure path, whose error text is the other classic leak

    expect(w.sent.length).toBeGreaterThan(0); // the bytes DID go out — this is not a vacuous pass
    const spilled = JSON.stringify([w.events, p.stats]);
    expect(spilled).not.toContain(MARKER);
    expect(spilled).not.toContain(SENDER);
    // ...and not a fragment of one either.
    expect(spilled).not.toContain("MARKER");
  });

  it("every field a DataEvent carries about this source is a number or a fixed label", async () => {
    const w = new World();
    const p = w.pump(1);
    w.threads = [thread("Sarah", "com.whatsapp", [msg(1, "an invented message")])];
    await p.tick();
    expect(w.events.length).toBeGreaterThan(0);
    for (const ev of w.events) {
      for (const [k, v] of Object.entries(ev)) {
        if (k === "kind" || k === "reason") continue;
        if (k === "source") {
          expect(v).toBe("notifications"); // a fixed id, never a package, a sender or a title
          continue;
        }
        if (k === "error") {
          expect(typeof v).toBe("string");
          continue;
        }
        expect(typeof v).toBe("number");
      }
    }
  });

  it("NotifyStats — the loggable shape — declares nothing but numbers", () => {
    // The same discipline MicStats established for audio (S-INPUT §4.3): the loggable surface is
    // all counts, so the first `lastSender: string` added to it fails the suite. Checked against
    // the DECLARATION rather than an instance, so it cannot be satisfied by an example.
    const src = readFileSync(TS_NATIVE, "utf8");
    const body = src.match(/export interface NotifyStats \{([\s\S]*?)\n\}/);
    expect(body).not.toBeNull();
    const fields = body![1]
      .split("\n")
      .map((l) => l.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "").trim())
      .filter((l) => l.includes(":"));
    expect(fields.length).toBeGreaterThan(6);
    for (const f of fields) expect(f).toMatch(/:\s*number;?$/);
  });

  it("the listener has no logging at all, and the store has none either", () => {
    // A `Log.d(TAG, "got: $body")` added while debugging is how audio nearly shipped off-device
    // (S-INPUT §4.1). Nothing on the intake path may log, so the rule is absolute rather than
    // "no logging OF CONTENT" — a rule with a judgement call in it does not survive a late night.
    for (const f of [KOTLIN_LISTENER, KOTLIN_STORE]) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toMatch(/\bandroid\.util\.Log\b/);
      expect(src).not.toMatch(/\bLog\.[vdiwe]\s*\(/);
      expect(src).not.toMatch(/\bprintln\s*\(/);
      expect(src).not.toMatch(/\bSystem\.out\b/);
    }
  });

  it("nothing on the intake path writes content to disk", () => {
    const src = readFileSync(KOTLIN_STORE, "utf8");
    expect(src).not.toMatch(/\bFileOutputStream\b|\bopenFileOutput\b|\bSQLite\b|\bgetSharedPreferences\b/);
  });

  it("the allowlist gate is the FIRST thing the listener does with a package", () => {
    // Structural, because the ordering IS the design: a non-allowlisted notification must be
    // refused before `sbn.notification` is touched, so nothing downstream can mishandle it.
    const src = readFileSync(KOTLIN_LISTENER, "utf8");
    const fn = src.slice(src.indexOf("override fun onNotificationPosted"));
    const gate = fn.indexOf("Rules.allows(");
    const firstRead = fn.indexOf("sbn.notification");
    expect(gate).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstRead);
  });
});

// ── 4. the allowlist itself ───────────────────────────────────────────────────────────────

describe("the allowlist", () => {
  it("the TypeScript defaults and the Kotlin defaults have not drifted", () => {
    // The settings screen shows one list; the gate uses the other. If they disagree, the privacy
    // claim the screen makes is quietly false — so this is a hard failure, not a lint.
    const kt = readFileSync(KOTLIN_ALLOWLIST, "utf8");
    const block = kt.match(/DEFAULT_ALLOW: List<String> = listOf\(([\s\S]*?)\n\s*\)/);
    expect(block).not.toBeNull();
    const kotlinPkgs = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(kotlinPkgs).toEqual(DEFAULT_ALLOW);
  });

  it("every default is in the catalogue the settings screen renders", () => {
    for (const pkg of DEFAULT_ALLOW) {
      expect(KNOWN_MESSAGING.some((a) => a.pkg === pkg)).toBe(true);
    }
  });

  it("the catalogue is messaging apps and nothing else", () => {
    // The failure this guards: someone adds a mail or banking package "just to try it" and the
    // allowlist stops meaning what the header says it means.
    for (const a of KNOWN_MESSAGING) expect(looksSensitive(a.pkg)).toBe(false);
    expect(KNOWN_MESSAGING.map((a) => a.pkg)).toEqual([...new Set(KNOWN_MESSAGING.map((a) => a.pkg))]);
  });

  it("warns about a hand-typed package that does not look like a messenger", () => {
    expect(looksSensitive("com.mybank.app")).toBe(true);
    expect(looksSensitive("com.google.android.gm")).toBe(true);
    expect(looksSensitive("com.duo.authenticator")).toBe(true);
    expect(looksSensitive("com.whatsapp")).toBe(false);
  });

  it("normalises a hand-edited list the way the native side does", () => {
    expect(normaliseAllowlist([" com.whatsapp ", "", "com.whatsapp", "com.discord"])).toEqual([
      "com.whatsapp",
      "com.discord",
    ]);
  });
});
