// Screen-stack tests. The point of most of these is the shared restore path: pop and reconnect
// must go through the same code, so ordinary navigation exercises the reconnect recovery that
// would otherwise only be tested by unplugging something.

import { Session } from "../session";
import type { Transport } from "../screen";
import { fromHex, parseFields, u32 } from "../proto";
import { Cmd } from "../wire";

/** Envelope field 1 is the Cmd. Proto3 omits a zero, and CREATE *is* zero — so absent = CREATE. */
const cmdOf = (bytes: Uint8Array) => u32(parseFields(bytes), 1) ?? Cmd.CREATE_STARTUP_PAGE;

const envelope = (bodyHex: string) => {
  const body = fromHex(bodyHex);
  return Uint8Array.from([0x08, 0x02, 0x6a, body.length, ...Array.from(body)]);
};
const TAP_ROW0 = envelope("0a0c080312086666732d6c697374");            // captured
const TAP_ROW1 = envelope("0a0e080312086666732d6c6973742001");        // captured
const DOUBLE_TAP = envelope("1a0408031001");                          // captured

function harness() {
  const sent: Uint8Array[] = [];
  const handlers: Array<(p: Uint8Array) => void> = [];
  const tx: Transport = {
    async sendEvenHub(b) { sent.push(b); },
    onInbound(h) { handlers.push(h); return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); }; },
  };
  // Deliver to every live screen; each decides whether the event is for it.
  return { tx, sent, deliver: (p: Uint8Array) => handlers.slice().forEach((h) => h(p)) };
}

const rows = (...l: string[]) => l.map((label) => ({ label, value: label }));

describe("Session stack", () => {
  it("push declares, and depth tracks", async () => {
    const { tx, sent } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    await s.push({ rows: rows("A", "B") });
    expect(s.depth).toBe(1);
    expect(sent.length).toBe(1);
    await s.push({ rows: rows("C") });
    expect(s.depth).toBe(2);
    expect(sent.length).toBe(2);
  });

  it("pop restores the parent — and that IS the reconnect path", async () => {
    const { tx, sent } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    await s.push({ rows: rows("parent-a", "parent-b") });
    await s.push({ rows: rows("child") });
    const before = sent.length;

    await s.pop();

    expect(s.depth).toBe(1);
    expect(sent.length).toBe(before + 1);          // the parent was re-declared
    expect(s.stats.restores.pop).toBe(1);
  });

  it("a pop-restore actually re-writes, despite identical content", async () => {
    // The subtle bug this guards: the parent's content has not changed, so the
    // identical-content no-op would suppress exactly the write that puts it back on-glass.
    const { tx, sent } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    await s.push({ rows: rows("same", "rows") });
    await s.push({ rows: rows("child") });
    const before = sent.length;
    await s.pop();
    expect(sent.length).toBeGreaterThan(before);
  });

  it("onReconnected re-declares the top through the same path as pop", async () => {
    const { tx, sent } = harness();
    const causes: string[] = [];
    const s = new Session({ transport: tx, magic: () => 100, onRestore: (c) => causes.push(c) });
    await s.push({ rows: rows("A") });
    const before = sent.length;

    await s.onReconnected();

    expect(sent.length).toBe(before + 1);
    expect(s.stats.restores.reconnect).toBe(1);
    expect(causes).toEqual(["reconnect"]);
  });

  it("reconnect with an empty stack is a harmless no-op", async () => {
    const { tx, sent } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    await s.onReconnected();
    expect(sent.length).toBe(0);
  });
});

describe("Session.menu", () => {
  it("runs the handler for the picked row and returns on back", async () => {
    const { tx, deliver } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    const picked: string[] = [];

    const done = s.menu<string>({ rows: rows("first", "second") }, (sel) => {
      picked.push(sel.row.label);
    });

    await new Promise((r) => setTimeout(r, 0));
    deliver(TAP_ROW1);                       // pick "second"
    await new Promise((r) => setTimeout(r, 0));
    deliver(DOUBLE_TAP);                     // back out
    await done;

    expect(picked).toEqual(["second"]);
    expect(s.depth).toBe(0);
  });

  it("menu -> submenu -> back leaves the parent restored and on top", async () => {
    const { tx, deliver } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    let submenuOpened = false;

    const done = s.menu<string>({ rows: rows("open-sub", "other") }, async () => {
      submenuOpened = true;
      const sub = await s.push({ rows: rows("sub-a", "sub-b") });
      expect(s.depth).toBe(2);
      await s.pop();                          // back out of the submenu
      expect(s.depth).toBe(1);
    });

    await new Promise((r) => setTimeout(r, 0));
    deliver(TAP_ROW0);                        // "open-sub"
    await new Promise((r) => setTimeout(r, 5));
    deliver(DOUBLE_TAP);                      // leave the parent
    await done;

    expect(submenuOpened).toBe(true);
    expect(s.depth).toBe(0);
    expect(s.stats.restores.pop).toBeGreaterThanOrEqual(1);
  });

  it("scrolling still costs nothing through the stack", async () => {
    const { tx, deliver } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    const screen = await s.push({ rows: rows(...Array.from({ length: 30 }, (_, i) => `R${i}`)) });
    const declares = s.stats.declareCount;
    const bytes = s.stats.bytesOut;

    deliver(TAP_ROW1);                        // the user scrolled on-glass, then tapped
    await screen.next();

    expect(s.stats.declareCount).toBe(declares);
    expect(s.stats.bytesOut).toBe(bytes);
    expect(s.stats.scrollRoundTrips).toBe(0);
  });
});

/**
 * REGRESSION — the firmware has ONE page slot and silently ignores a second CREATE (FUT-153).
 *
 * The SDK originally derived CREATE-vs-REBUILD from each screen's own generation counter, so
 * every pushed submenu started at generation 0 and sent a second CREATE. The firmware would drop
 * it without any error: the glasses would just keep showing the parent menu while the phone
 * believed it had navigated. Nothing in the stack could have reported that — which is precisely
 * why it needs a test rather than a comment.
 */
describe("the page slot is per-LINK, not per-screen", () => {
  it("a pushed submenu REBUILDs — a second CREATE would be silently dropped", async () => {
    const { tx, sent } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });

    await s.push({ rows: rows("home-a", "home-b") });
    expect(cmdOf(sent[0])).toBe(Cmd.CREATE_STARTUP_PAGE);

    await s.push({ rows: rows("child") });
    expect(cmdOf(sent[1])).toBe(Cmd.REBUILD_PAGE);

    // ...and so does the parent when the child pops back to it.
    await s.pop();
    expect(cmdOf(sent[sent.length - 1])).toBe(Cmd.REBUILD_PAGE);
    expect(sent.filter((b) => cmdOf(b) === Cmd.CREATE_STARTUP_PAGE)).toHaveLength(1);
  });

  it("a dropped link resets the slot, so recovery CREATEs a fresh page", async () => {
    const { tx, sent } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    await s.push({ rows: rows("a") });
    await s.push({ rows: rows("b") });
    expect(cmdOf(sent[1])).toBe(Cmd.REBUILD_PAGE);

    // The glasses went away and came back holding nothing at all.
    s.onDisconnected();
    await s.onReconnected();

    // REBUILDing a page the firmware no longer has would leave the HUD blank.
    expect(cmdOf(sent[sent.length - 1])).toBe(Cmd.CREATE_STARTUP_PAGE);
  });
});

/**
 * REGRESSION — a parent menu must not act on a tap that happened inside its CHILD.
 *
 * Every ListScreen subscribes to the inbound stream and only unsubscribes on close(), so while a
 * submenu is on the glasses the parent is still listening. A tap inside the child therefore also
 * reaches the parent, which has no waiter (it is parked inside its handler) and so QUEUES it.
 * The moment the child backs out, the parent's loop reads that stale event and navigates again —
 * from the user's point of view, backing out of Settings instantly re-enters a random screen.
 *
 * Only the screen actually ON the glasses can be the subject of an event.
 */
describe("event routing follows the top of the stack", () => {
  it("a tap inside a child is not replayed by the parent after back", async () => {
    const { tx, deliver } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });
    const settle = () => new Promise((r) => setTimeout(r, 0));

    const picked: string[] = [];
    // NOT awaited here — menu() only resolves once the user backs out, so awaiting it before
    // delivering any events would deadlock the test.
    const done = s.menu<string>(
      { rows: rows("home-0", "home-1") },
      async (sel) => {
        picked.push(`home:${sel.row.label}`);
        await s.menu<string>({ rows: rows("child-0", "child-1") }, async (c) => {
          picked.push(`child:${c.row.label}`);
        });
      }
    );

    await settle();
    deliver(TAP_ROW0);      // enter the child from home row 0
    await settle(); await settle();
    deliver(TAP_ROW1);      // tap row 1 INSIDE the child
    await settle(); await settle();
    deliver(DOUBLE_TAP);    // back out of the child
    await settle(); await settle();
    deliver(DOUBLE_TAP);    // back out of home
    await done;

    // The child's tap belongs to the child alone. A stale replay would append a second
    // "home:..." entry here.
    expect(picked).toEqual(["home:home-0", "child:child-1"]);
  });
});

/**
 * REGRESSION — a push that FAILS must not leave the OS deaf.
 *
 * push() suspends the parent before declaring the child, so if declare() throws (a transport
 * error, a page the firmware rejects, the provenance gate) the parent would stay suspended
 * forever and the half-born screen would stay on the stack. The glasses would keep rendering
 * the parent while every tap went nowhere — which looks exactly like a frozen list, and is the
 * hardest possible symptom to trace back to a failed push.
 */
describe("a failed push unwinds cleanly", () => {
  function flakyHarness(failOn: number) {
    const sent: Uint8Array[] = [];
    const handlers: Array<(p: Uint8Array) => void> = [];
    let n = 0;
    const tx: Transport = {
      async sendEvenHub(b) {
        if (++n === failOn) throw new Error("link went away mid-declare");
        sent.push(b);
      },
      onInbound(h) {
        handlers.push(h);
        return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
      },
    };
    return { tx, sent, deliver: (p: Uint8Array) => handlers.slice().forEach((h) => h(p)) };
  }

  it("restores the parent's ability to hear events, and leaves the stack intact", async () => {
    const { tx, deliver } = flakyHarness(2); // first declare succeeds, the child's fails
    const s = new Session({ transport: tx, magic: () => 100 });
    const parent = await s.push({ rows: rows("home-0", "home-1") });

    await expect(s.push({ rows: rows("child") })).rejects.toThrow("link went away");

    // The half-born screen must not be left on the stack.
    expect(s.depth).toBe(1);
    expect(s.top).toBe(parent);

    // ...and the parent must still be listening, or the OS is deaf from here on.
    const got = parent.next();
    deliver(TAP_ROW1);
    await expect(got).resolves.toMatchObject({ kind: "select", index: 1 });
  });
});

/**
 * REGRESSION — a menu that ABORTS must not leave screens it opened alive.
 *
 * If a handler pushes a screen and then throws, menu()'s own screen ends up BURIED under the
 * child. The old unwind only fired when the menu's screen was on TOP, so a buried one was never
 * closed: its inbound subscription leaked and it stayed suspended, i.e. deaf, forever.
 *
 * Note the handler must THROW rather than simply not pop: with a child on top the menu's screen
 * is suspended and cannot receive the back event at all, so a menu whose handler leaves a child
 * up never returns in the first place. The throwing path is the reachable one.
 */
describe("menu unwinds everything it opened", () => {
  it("closes buried screens when a handler pushes and then throws", async () => {
    const { tx, deliver } = harness();
    const s = new Session({ transport: tx, magic: () => 100 });

    const done = s.menu<string>({ rows: rows("a", "b") }, async () => {
      await s.push({ rows: rows("child") });   // pushed, then abandoned by the throw
      throw new Error("handler blew up");
    });

    await new Promise((r) => setTimeout(r, 0));
    deliver(TAP_ROW0);
    await expect(done).rejects.toThrow("handler blew up");

    // Both the menu's screen and the child it opened are gone.
    expect(s.depth).toBe(0);
  });
});
