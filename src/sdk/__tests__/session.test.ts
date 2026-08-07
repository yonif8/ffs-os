// Screen-stack tests. The point of most of these is the shared restore path: pop and reconnect
// must go through the same code, so ordinary navigation exercises the reconnect recovery that
// would otherwise only be tested by unplugging something.

import { Session } from "../session";
import type { Transport } from "../screen";
import { fromHex } from "../proto";

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
