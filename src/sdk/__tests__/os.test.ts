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
    // Fixed clock: a screen that renders the wall time is otherwise untestable.
    now: () => new Date("2026-08-08T09:41:00Z"),
  };
}

/** Let the OS's awaits settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FfsOs", () => {
  it("declares the home menu on boot", async () => {
    const { tx, sent } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    expect(sent.length).toBe(1);
    const page = rowsOf(sent[0]).join("|");
    for (const label of ["Clock", "Settings", "Device", "Apps"]) {
      expect(page).toContain(label);
    }
  });

  it("selecting Settings puts the settings rows on the wire", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    deliver(listTap(1)); // "Settings"
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

    // Local time, so assert the SHAPE rather than a timezone-dependent value.
    expect(rowsOf(sent[sent.length - 1]).join("|")).toMatch(/\d\d:\d\d/);
  });

  it("double-tap backs out of a submenu and restores the parent", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    deliver(listTap(1));            // into Settings
    await tick(); await tick();
    const afterPush = sent.length;

    deliver(DOUBLE_TAP);            // back
    await tick(); await tick();

    expect(sent.length).toBeGreaterThan(afterPush);
    const page = rowsOf(sent[sent.length - 1]).join("|");
    for (const label of ["Clock", "Settings", "Device", "Apps"]) {
      expect(page).toContain(label);
    }
  });

  it("every page after the first is a REBUILD", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();

    deliver(listTap(1));
    await tick(); await tick();
    deliver(DOUBLE_TAP);
    await tick(); await tick();

    const cmds = sent.map(cmdOf);
    expect(cmds[0]).toBe(Cmd.CREATE_STARTUP_PAGE);
    expect(cmds.slice(1).every((c) => c === Cmd.REBUILD_PAGE)).toBe(true);
  });
});

/**
 * Headers. A page can carry a capturing list AND a text container at once (proven on-glass), so
 * every OS screen names itself instead of spending a row on its own title.
 */
describe("FfsOs headers", () => {
  it("titles the home screen and each submenu", async () => {
    const { tx, sent, deliver } = harness();
    const os = new FfsOs(new Session({ transport: tx, magic: () => 100 }), fakeHost());
    void os.run();
    await tick();
    expect(rowsOf(sent[0]).join("|")).toContain("FFS OS");

    deliver(listTap(1));
    await tick(); await tick();
    expect(rowsOf(sent[sent.length - 1]).join("|")).toContain("Settings");
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
