// Session-layer tests. No glasses, no transport, no clock — a fake Transport stands in, and
// inbound events are the REAL captured bytes from the device.

import { ListScreen, newStats, type Transport } from "../screen";
import { PROVENANCE, assertProven, UnprovenCapabilityError, LIMITS } from "../types";
import { fromHex } from "../proto";

/** Captured envelope helper: Cmd(1)=2 OS_NOITY_EVENT_TO_APP_PACKET, DevEvent(13)=<body>. */
const envelope = (bodyHex: string) => {
  const body = fromHex(bodyHex);
  return Uint8Array.from([0x08, 0x02, 0x6a, body.length, ...Array.from(body)]);
};
/** CAPTURED: tap on row 0 — no index field at all (proto3 omits the default). */
const TAP_ROW0 = envelope("0a0c080312086666732d6c697374");
/** CAPTURED: scrolled to row 1 on-glass, then tapped. `2001` = field 4 varint 1. */
const TAP_ROW1 = envelope("0a0e080312086666732d6c6973742001");
/** CAPTURED: double tap on the right temple -> SysEvent{type=3 DOUBLE_CLICK, source=1}. */
const DOUBLE_TAP = envelope("1a0408031001");

function fakeTransport() {
  const sent: Uint8Array[] = [];
  let handler: ((p: Uint8Array) => void) | null = null;
  const tx: Transport = {
    async sendEvenHub(bytes) { sent.push(bytes); },
    onInbound(h) { handler = h; return () => { handler = null; }; },
  };
  return { tx, sent, deliver: (p: Uint8Array) => handler?.(p) };
}

const rows = (...labels: string[]) => labels.map((label) => ({ label, value: label }));

describe("ListScreen — declare", () => {
  it("first declare is a CREATE, later ones are REBUILD", async () => {
    const { tx, sent } = fakeTransport();
    const s = new ListScreen(tx, newStats(), { rows: rows("A", "B") }, () => 100);
    const a = await s.declare();
    expect(a.ops[0].op).toBe("pageCreate");
    // A second CREATE is silently ignored by the firmware — this must become a REBUILD.
    const b = await s.update(rows("A", "B", "C"));
    expect(b.ops[0].op).toBe("pageRebuild");
    expect(sent.length).toBe(2);
  });

  it("re-declaring IDENTICAL rows costs zero bytes", async () => {
    const { tx, sent } = fakeTransport();
    const st = newStats();
    const s = new ListScreen(tx, st, { rows: rows("A", "B") }, () => 100);
    await s.declare();
    const before = st.bytesOut;
    const r = await s.update(rows("A", "B"));
    expect(r.reason).toBe("identical");
    expect(r.bytes).toBe(0);
    expect(sent.length).toBe(1);        // nothing new went out
    expect(st.bytesOut).toBe(before);
  });

  /**
   * THE TEST THAT PROTECTS THE ARCHITECTURE.
   *
   * Scrolling happens ENTIRELY on the glasses — measured on hardware: row 0 -> row 1 produced
   * zero wire traffic. If a future change reintroduces a re-render per scroll, this fails.
   */
  it("20 on-glass scrolls cost ONE declaration and ZERO extra bytes", async () => {
    const { tx, deliver } = fakeTransport();
    const st = newStats();
    const s = new ListScreen(tx, st, { rows: rows(...Array.from({ length: 20 }, (_, i) => `R${i}`)) }, () => 100);
    await s.declare();
    const afterDeclare = { declares: st.declareCount, bytes: st.bytesOut };

    // The firmware sends NOTHING while the user scrolls; the phone only hears the final tap.
    deliver(TAP_ROW1);
    const sel = await s.next();

    expect(sel.kind).toBe("select");
    expect(st.declareCount).toBe(afterDeclare.declares); // still 1
    expect(st.bytesOut).toBe(afterDeclare.bytes);        // still 0 extra
    expect(st.scrollRoundTrips).toBe(0);
  });
});

describe("ListScreen — events", () => {
  it("maps a row-0 tap (no index field) to index 0 with the right row", async () => {
    const { tx, deliver } = fakeTransport();
    const s = new ListScreen(tx, newStats(), { rows: rows("first", "second") }, () => 1);
    await s.declare();
    deliver(TAP_ROW0);
    const e = await s.next();
    expect(e.kind).toBe("select");
    if (e.kind !== "select") return;
    expect(e.index).toBe(0);
    expect(e.row.label).toBe("first");
    expect(e.value).toBe("first");
  });

  it("maps a row-1 tap to the correct row", async () => {
    const { tx, deliver } = fakeTransport();
    const s = new ListScreen(tx, newStats(), { rows: rows("first", "second") }, () => 1);
    await s.declare();
    deliver(TAP_ROW1);
    const e = await s.next();
    if (e.kind !== "select") throw new Error("expected select");
    expect(e.index).toBe(1);
    expect(e.row.label).toBe("second");
  });

  it("double tap becomes `back` — a VALUE, not an exception", async () => {
    const { tx, deliver } = fakeTransport();
    const s = new ListScreen(tx, newStats(), { rows: rows("a") }, () => 1);
    await s.declare();
    deliver(DOUBLE_TAP);
    const e = await s.next();
    expect(e.kind).toBe("back");
  });

  it("QUEUES an event that arrives before the next await — a fast second tap is not lost", async () => {
    const { tx, deliver } = fakeTransport();
    const s = new ListScreen(tx, newStats(), { rows: rows("a", "b") }, () => 1);
    await s.declare();
    deliver(TAP_ROW0);   // nobody is awaiting yet
    deliver(TAP_ROW1);
    const first = await s.next();
    const second = await s.next();
    expect(first.kind === "select" && first.index).toBe(0);
    expect(second.kind === "select" && second.index).toBe(1);
  });

  it("nextSelection absorbs `back` and returns null instead of throwing", async () => {
    const { tx, deliver } = fakeTransport();
    const s = new ListScreen(tx, newStats(), { rows: rows("a") }, () => 1);
    await s.declare();
    deliver(DOUBLE_TAP);
    expect(await s.nextSelection()).toBeNull();
  });

  it("nextSelection skips disabled rows and re-arms", async () => {
    const { tx, deliver } = fakeTransport();
    const s = new ListScreen<string>(
      tx, newStats(),
      { rows: [{ label: "nope", disabled: true }, { label: "yes", value: "yes" }] },
      () => 1
    );
    await s.declare();
    deliver(TAP_ROW0);   // the disabled row — absorbed
    deliver(TAP_ROW1);   // the real one
    const sel = await s.nextSelection();
    expect(sel?.row.label).toBe("yes");
  });

  it("a heartbeat never becomes an event", async () => {
    const { tx, deliver } = fakeTransport();
    const st = newStats();
    const s = new ListScreen(tx, st, { rows: rows("a") }, () => 1);
    await s.declare();
    deliver(fromHex("080c10137a02100c"));
    expect(st.eventsIn).toBe(0);
  });
});

describe("provenance gate", () => {
  it("every PROVENANCE entry cites evidence", () => {
    for (const [k, v] of Object.entries(PROVENANCE)) {
      expect(v.evidence.length).toBeGreaterThan(10);
      expect(["proven", "derived", "unproven"]).toContain(v.status);
    }
  });

  it("throws for an unproven capability, and names the evidence", () => {
    expect(() => assertProven("cfw.injectSelect")).toThrow(UnprovenCapabilityError);
    try { assertProven("source.ring"); } catch (e: any) {
      expect(e.message).toContain("never observed");
    }
  });

  it("allows an unproven capability ONLY with an explicit opt-in", () => {
    expect(() => assertProven("source.ring", true)).not.toThrow();
  });

  it("proven capabilities pass", () => {
    expect(() => assertProven("list.declare")).not.toThrow();
    expect(() => assertProven("list.select")).not.toThrow();
  });

  it("an unknown capability is an error, not a silent pass", () => {
    expect(() => assertProven("does.not.exist")).toThrow(/unknown capability/);
  });

  it("SELECT injection is gated — it reboots a lens", () => {
    expect(PROVENANCE["cfw.injectSelect"].status).toBe("unproven");
    expect(PROVENANCE["cfw.injectSelect"].evidence).toContain("FAULTS THE LENS");
  });
});

describe("limits", () => {
  it("declaring more rows than proven warns rather than failing silently", async () => {
    const { tx } = fakeTransport();
    const many = rows(...Array.from({ length: LIMITS.LIST_ROWS_PROVEN + 5 }, (_, i) => `R${i}`));
    const s = new ListScreen(tx, newStats(), { rows: many, allowUnproven: true }, () => 1);
    const r = await s.declare();
    expect(r.warnings.join(" ")).toMatch(/exceeds/);
  });

  it("an over-long container name warns", async () => {
    const { tx } = fakeTransport();
    const s = new ListScreen(tx, newStats(), { rows: rows("a"), containerName: "way-too-long-a-name" }, () => 1);
    const r = await s.declare();
    expect(r.warnings.join(" ")).toMatch(/container name/);
  });
});
