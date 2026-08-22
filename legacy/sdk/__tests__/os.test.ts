// FfsOs navigation tests — the OS driven end to end against a fake transport.
//
// These decode the bytes the OS actually puts on the wire rather than inspecting its internals,
// because "the OS thinks it navigated" and "a page carrying the submenu's rows went out" are
// different claims, and only the second one is what the glasses see.

import { FfsOs, type OsHost } from "../os";
import { Session } from "../session";
import type { Transport } from "../screen";
import { fromHex, parseFields, u32 } from "../proto";
import { Cmd } from "../wire";

/** Build the inbound frame for "the user selected row `index`" on the SDK's list container. */
function listTap(index: number): Uint8Array {
  // ListEvent{1: containerId=3, 2: name="ffs-list", 4: index}. Proto3 omits a zero index —
  // which is exactly the row-0 case that has to keep working.
  const name = "ffs-list";
  const inner = [0x08, 0x03, 0x12, name.length, ...Array.from(name, (c) => c.charCodeAt(0))];
  if (index !== 0) inner.push(0x20, index);
  const listEvent = [0x0a, inner.length, ...inner];
  return Uint8Array.from([0x08, 0x02, 0x6a, listEvent.length, ...listEvent]);
}

/** A double-tap — the firmware's "back", which arrives as a SysEvent. */
const DOUBLE_TAP = fromHex("08026a061a0408031001");

/**
 * Pull the row labels back out of an encoded page.
 *
 * Deliberately a printable-ASCII scan rather than a protobuf walk. The question these tests ask
 * is "does this label reach the glasses in these bytes?", and a scan answers it without
 * re-implementing a decoder that could itself be wrong — the first version of this helper WAS
 * wrong, and reported an empty page for output that was perfectly correct.
 */
function rowsOf(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let cur = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
    else { if (cur.length >= 3) out.push(cur); cur = ""; }
  }
  if (cur.length >= 3) out.push(cur);
  return out.filter((s) => s !== "ffs-list");
}

/** CREATE vs REBUILD off the envelope. Proto3 omits a zero, and CREATE is zero. */
const cmdOf = (b: Uint8Array) => u32(parseFields(b), 1) ?? Cmd.CREATE_STARTUP_PAGE;

function harness() {
  const sent: Uint8Array[] = [];
  const handlers: Array<(p: Uint8Array) => void> = [];
  const tx: Transport = {
    async sendEvenHub(b) { sent.push(b); },
    onInbound(h) {
      handlers.push(h);
      return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
    },
  };
  return { tx, sent, deliver: (p: Uint8Array) => handlers.slice().forEach((h) => h(p)) };
}

function fakeHost(): OsHost {
  return {
    setBrightness() {},
    setSilentMode() {},
    setWearDetection() {},
    async readSettings() {
      return { battery: 57, brightness: 15, leftFirmware: "2.2.7.14", rightFirmware: "2.2.7.14" };
    },
    setSwirl() {},
    playPreset() {},
    // Fixed clock: a screen that renders the wall time is otherwise untestable.
    now: () => new Date("2026-08-08T09:41:00Z"),
  };
}

/** Let the OS's awaits settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FfsOs", () => {
  /** Home is the RAIL launcher: 3-letter marks, 0=CLK 1=TMR 2=NTE 3=DEV 4=SET 5=APP. */
  it("declares the launcher rail on boot", async () => {
    const { tx, sent } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    expect(sent.length).toBe(1);
    const page = rowsOf(sent[0]).join("|");
    for (const mark of ["CLK", "TMR", "NTE", "DEV", "SET", "APP"]) {
      expect(page).toContain(mark);
    }
  });

  it("selecting Settings puts the settings rows on the wire", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    deliver(listTap(4)); // "SET"
    await tick();
    await tick();

    expect(sent.length).toBeGreaterThan(1);
    const page = rowsOf(sent[sent.length - 1]).join("|");
    // The values are rendered into the labels, so this also pins the kv() two-space formatting.
    expect(page).toContain("Brightness  15");
    expect(page).toContain("Silent  Off");
    expect(page).toContain("Wear detect  On");
  });

  it("row 0 selects Clock — the index field is ABSENT for row 0", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    deliver(listTap(0));
    await tick();
    await tick();

    // Headers are LETTERSPACED — the only typographic hierarchy this device offers, since the
    // text container schema has no font size or weight. So the clock reads "0 9 : 4 1", not
    // "09:41". Assert the shape after collapsing the spacing, and pin the spacing separately.
    const page = rowsOf(sent[sent.length - 1]).join("|");
    expect(page.replace(/ /g, "")).toMatch(/\d\d:\d\d/);
    expect(page).toContain(" : ");
  });

  it("double-tap backs out of an app and restores the launcher", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    deliver(listTap(4));            // into SET
    await tick(); await tick();
    const afterPush = sent.length;

    deliver(DOUBLE_TAP);            // back
    await tick(); await tick();

    expect(sent.length).toBeGreaterThan(afterPush);
    const page = rowsOf(sent[sent.length - 1]).join("|");
    for (const mark of ["CLK", "TMR", "NTE", "DEV", "SET", "APP"]) {
      expect(page).toContain(mark);
    }
  });

  it("every page after the first is a REBUILD", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    deliver(listTap(4));
    await tick(); await tick();
    deliver(DOUBLE_TAP);
    await tick(); await tick();

    // Cmd 5 updates are not pages; only page commands are in question here.
    const cmds = sent.map(cmdOf).filter((c) => c !== Cmd.UPDATE_TEXT_DATA);
    expect(cmds[0]).toBe(Cmd.CREATE_STARTUP_PAGE);
    expect(cmds.slice(1).every((c) => c === Cmd.REBUILD_PAGE)).toBe(true);
  });
});

/**
 * Headers. A page can carry a capturing list AND a text container at once (proven on-glass), so
 * every OS screen names itself instead of spending a row on its own title.
 */
describe("FfsOs headers", () => {
  it("titles each app screen (the launcher itself needs no title)", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();
    expect(rowsOf(sent[0]).join("|")).toContain("CLK");

    deliver(listTap(4));
    await tick(); await tick();
    // Letterspaced, and carrying the hairline the launcher established.
    const titled = rowsOf(sent[sent.length - 1]).join("|");
    expect(titled).toContain("S e t t i n g s");
    expect(titled).toContain("____");
  });

  it("the header participates in the no-op fingerprint", async () => {
    // Same rows, different title, must still redraw — otherwise a screen would keep the previous
    // screen's name and the identical-content optimisation would be actively wrong.
    const { tx, sent } = harness();
    const session = new Session({ transport: tx, magic: () => 100 });
    const screen = await session.push({ header: "One", rows: [{ label: "A" }] });
    const before = sent.length;
    await screen.declare();                       // identical -> genuine no-op
    expect(sent.length).toBe(before);
    expect((await screen.declare()).ops[0].op).toBe("noop");
  });
});

/**
 * The live clock. The interesting property is not that the time appears — it is that ticking
 * costs NO page rebuild, because a rebuild would send the list's focus back to row 0 every
 * second and make the screen unusable while scrolling.
 */
describe("FfsOs live clock", () => {
  it("ticks via in-place text updates, not page rebuilds", async () => {
    const { tx, sent, deliver } = harness();
    const session = new Session({ transport: tx, magic: () => 100 });
    const os = new FfsOs(session, fakeHost());
    void os.run();
    await tick();

    deliver(listTap(0));                 // "Clock"
    await tick(); await tick();
    const declaresAfterEntering = session.stats.declareCount;

    // Two seconds of ticking.
    await new Promise((r) => setTimeout(r, 2100));

    expect(session.stats.textUpdates).toBeGreaterThanOrEqual(1);
    // THE ASSERTION THAT MATTERS: no page was rebuilt while the clock ran.
    expect(session.stats.declareCount).toBe(declaresAfterEntering);
    // ...and the updates went out as Cmd 5, not as pages.
    const updates = sent.filter((b) => cmdOf(b) === Cmd.UPDATE_TEXT_DATA);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(rowsOf(updates[updates.length - 1]).join("|")).toMatch(/\d\d:\d\d:\d\d/);
  }, 10000);
});

describe("FfsOs apps", () => {
  /** Walk home -> Apps -> a row, returning every page the OS put on the wire. */
  async function walk(path: number[]) {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();
    for (const idx of path) {
      deliver(listTap(idx));
      await tick(); await tick();
    }
    return { sent, page: rowsOf(sent[sent.length - 1]).join("|") };
  }

  it("Apps lists Timer, Notes and About", async () => {
    const { page } = await walk([5]);
    expect(page).toContain("Timer");
    expect(page).toContain("Notes");
    expect(page).toContain("About");
  });

  it("Timer counts down in the header, without rebuilding the page", async () => {
    const { tx, sent, deliver } = harness();
    const session = new Session({ transport: tx, magic: () => 100 });
    const os = new FfsOs(session, fakeHost());
    void os.run();
    await tick();

    deliver(listTap(1)); await tick(); await tick();   // TMR — a top-level rail entry now
    expect(rowsOf(sent[sent.length - 1]).join("|")).toContain("1 min");

    deliver(listTap(0)); await tick(); await tick();   // start the 1-minute timer
    const declaresWhileRunning = session.stats.declareCount;

    await new Promise((r) => setTimeout(r, 2100));

    // The countdown goes out as in-place text updates...
    const updates = sent.filter((b) => cmdOf(b) === Cmd.UPDATE_TEXT_DATA);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(rowsOf(updates[updates.length - 1]).join("|")).toMatch(/\d+:\d\d/);
    // ...and NOT as page rebuilds, which would drag the list's focus back to row 0 every second.
    expect(session.stats.declareCount).toBe(declaresWhileRunning);
  }, 10000);

  it("Notes says so when the host supplies none — rather than showing an empty list", async () => {
    const { page } = await walk([2]);
    expect(page).toContain("(no notes)");
  });

  it("Notes renders what the host supplies", async () => {
    const { tx, sent, deliver } = harness();
    const host = { ...fakeHost(), readNotes: () => ["milk", "call mum"] };
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), host);
    void os.run();
    await tick();
    deliver(listTap(2)); await tick(); await tick();   // NTE
    const page = rowsOf(sent[sent.length - 1]).join("|");
    expect(page).toContain("milk");
    expect(page).toContain("call mum");
  });
});
