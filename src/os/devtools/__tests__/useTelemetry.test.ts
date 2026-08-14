// Pure-logic tests for the telemetry feed: history dedup/bounding + per-lens split. The React
// wiring is not tested here (it needs a device); these are the parts a bug would silently corrupt
// the trend with.

import { appendReading, splitReadingsByLens, type TelemetryReading } from "../telemetryFeed";
import { decodeTelemetryA } from "../../../sdk/telemetry";

function packA(pool: number, lens: number): number {
  return ((0x7d << 24) | (pool & 0x3ff) | ((0x35 & 0x3f) << 10) | ((1 & 0x1) << 19) | ((lens & 0x3) << 22)) >>> 0;
}
function reading(pool: number, lens: number, at: number): TelemetryReading {
  return { t: decodeTelemetryA(packA(pool, lens)), at };
}

describe("appendReading", () => {
  it("appends distinct readings", () => {
    let h: TelemetryReading[] = [];
    h = appendReading(h, reading(50, 1, 1000));
    h = appendReading(h, reading(49, 1, 2000));
    expect(h).toHaveLength(2);
    expect(h.map((r) => r.t.pool_free_kb)).toEqual([50, 49]);
  });

  it("drops an exact-duplicate Carrier-A reading inside the poll window", () => {
    let h: TelemetryReading[] = [];
    h = appendReading(h, reading(50, 1, 1000));
    h = appendReading(h, reading(50, 1, 1300)); // same last_ret, <1500ms later
    expect(h).toHaveLength(1);
  });

  it("keeps a repeat once the window has passed (a real re-sample)", () => {
    let h: TelemetryReading[] = [];
    h = appendReading(h, reading(50, 1, 1000));
    h = appendReading(h, reading(50, 1, 3000)); // same value, but 2s later
    expect(h).toHaveLength(2);
  });

  it("bounds the history to the cap, dropping oldest", () => {
    let h: TelemetryReading[] = [];
    for (let i = 0; i < 10; i++) h = appendReading(h, reading(i, 1, i * 2000), 5);
    expect(h).toHaveLength(5);
    expect(h[0].t.pool_free_kb).toBe(5); // oldest five dropped
    expect(h[4].t.pool_free_kb).toBe(9);
  });
});

describe("splitReadingsByLens", () => {
  it("separates by self-reported lens stamp", () => {
    const h = [reading(50, 1, 1), reading(40, 2, 2), reading(45, 1, 3), reading(30, 0, 4)];
    const g = splitReadingsByLens(h);
    expect(g.right).toHaveLength(2);
    expect(g.left).toHaveLength(1);
    expect(g.unknown).toHaveLength(1);
  });
});
