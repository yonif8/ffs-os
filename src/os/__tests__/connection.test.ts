// The connection supervisor's decision core, stated as tests.
//
// useConnectionSupervisor is a react hook (AppState + refs + effects), so its DECISIONS were
// split into connectionCore.ts — pure functions with no react-native import — precisely so the
// drop/recovery logic that used to be un-testable inline in an effect can be pinned here. These
// tests drive the reducer through the sequences a real day produces: first connect, an
// unexpected drop, a recovery, and a user-initiated disconnect.

import { describe, expect, it } from "bun:test";
import {
  deriveHealth,
  healthLabel,
  reduceConnection,
  type ConnTransitionPrev,
} from "../connectionCore";

describe("deriveHealth", () => {
  it("is healthy only when connected AND the pair is ready", () => {
    expect(deriveHealth(true, true, "ready", false)).toBe("healthy");
  });

  it("is degraded when a lens is up but the pair is not ready yet", () => {
    expect(deriveHealth(true, false, "connecting", false)).toBe("degraded");
  });

  it("reports connecting while the driver is scanning or connecting", () => {
    expect(deriveHealth(false, false, "scanning", false)).toBe("connecting");
    expect(deriveHealth(false, false, "connecting", false)).toBe("connecting");
  });

  it("reports reconnecting when an established link dropped unexpectedly", () => {
    expect(deriveHealth(false, false, "idle", true)).toBe("reconnecting");
  });

  it("is disconnected when idle with nothing to recover", () => {
    expect(deriveHealth(false, false, "idle", false)).toBe("disconnected");
  });

  it("connected always wins over any raw/dropped signal", () => {
    // a stale rawState or a leftover drop flag must never mask a live link
    expect(deriveHealth(true, true, "scanning", true)).toBe("healthy");
    expect(deriveHealth(true, false, "idle", true)).toBe("degraded");
  });
});

describe("healthLabel", () => {
  it("maps every health to a human label", () => {
    expect(healthLabel("healthy")).toBe("Connected");
    expect(healthLabel("degraded")).toBe("Booting…");
    expect(healthLabel("connecting")).toBe("Connecting…");
    expect(healthLabel("reconnecting")).toBe("Reconnecting…");
    expect(healthLabel("disconnected")).toBe("Disconnected");
  });
});

describe("reduceConnection", () => {
  const down: ConnTransitionPrev = { wasConnected: false, droppedUnexpectedly: false };
  const up: ConnTransitionPrev = { wasConnected: true, droppedUnexpectedly: false };

  it("emits 'connected' healthy on the first ready link", () => {
    const t = reduceConnection(down, { connected: true, ready: true, rawState: "ready", userDisconnected: false });
    expect(t.wasConnected).toBe(true);
    expect(t.droppedUnexpectedly).toBe(false);
    expect(t.event).toEqual({ health: "healthy", note: "connected" });
  });

  it("emits 'connected' degraded when up but the pair is not ready", () => {
    const t = reduceConnection(down, { connected: true, ready: false, rawState: "connecting", userDisconnected: false });
    expect(t.event).toEqual({ health: "degraded", note: "connected" });
  });

  it("says nothing while an already-established link stays up", () => {
    const t = reduceConnection(up, { connected: true, ready: true, rawState: "ready", userDisconnected: false });
    expect(t.event).toBeNull();
    expect(t.wasConnected).toBe(true);
  });

  it("coming up clears a pending drop flag", () => {
    const dropped: ConnTransitionPrev = { wasConnected: false, droppedUnexpectedly: true };
    const t = reduceConnection(dropped, { connected: true, ready: true, rawState: "ready", userDisconnected: false });
    expect(t.droppedUnexpectedly).toBe(false);
  });

  it("flags an UNEXPECTED drop from an established link and surfaces reconnecting", () => {
    const t = reduceConnection(up, { connected: false, ready: false, rawState: "idle", userDisconnected: false });
    expect(t.wasConnected).toBe(false);
    expect(t.droppedUnexpectedly).toBe(true);
    expect(t.event).toEqual({ health: "reconnecting", note: "link dropped" });
  });

  it("a user-initiated disconnect reads 'disconnected', not 'reconnecting'", () => {
    const t = reduceConnection(up, { connected: false, ready: false, rawState: "idle", userDisconnected: true });
    expect(t.droppedUnexpectedly).toBe(false);
    expect(t.event).toEqual({ health: "disconnected" });
  });

  it("a down state that was never up derives its idle health (no phantom drop)", () => {
    const scanning = reduceConnection(down, { connected: false, ready: false, rawState: "scanning", userDisconnected: false });
    expect(scanning.droppedUnexpectedly).toBe(false);
    expect(scanning.event).toEqual({ health: "connecting" });

    const idle = reduceConnection(down, { connected: false, ready: false, rawState: "idle", userDisconnected: false });
    expect(idle.event).toEqual({ health: "disconnected" });
  });

  it("★ a full day: connect → drop → recover, threading the latch by hand", () => {
    // 1. first connect
    let prev: ConnTransitionPrev = { wasConnected: false, droppedUnexpectedly: false };
    let t = reduceConnection(prev, { connected: true, ready: true, rawState: "ready", userDisconnected: false });
    expect(t.event?.health).toBe("healthy");
    prev = { wasConnected: t.wasConnected, droppedUnexpectedly: t.droppedUnexpectedly };

    // 2. the link drops on its own
    t = reduceConnection(prev, { connected: false, ready: false, rawState: "idle", userDisconnected: false });
    expect(t.event?.health).toBe("reconnecting");
    expect(t.droppedUnexpectedly).toBe(true);
    prev = { wasConnected: t.wasConnected, droppedUnexpectedly: t.droppedUnexpectedly };

    // 3. it comes back — the drop flag clears and we announce the reconnect once
    t = reduceConnection(prev, { connected: true, ready: true, rawState: "ready", userDisconnected: false });
    expect(t.event).toEqual({ health: "healthy", note: "connected" });
    expect(t.droppedUnexpectedly).toBe(false);
  });
});
