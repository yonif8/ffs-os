// FFS Glasses OS — connection supervisor, the PURE decision core (FUT-136 / FUT-163).
//
// The health derivation and the drop/reconnect transition reducer, split out of connection.ts
// so they carry no react / react-native import and `bun test` can exercise them directly. The
// hook (useConnectionSupervisor) is the imperative shell around this: it holds the refs, runs
// the effects, and drives the driver; every non-trivial DECISION it makes is one of the pure
// functions below. (Same split as src/data/pump.ts pure logic vs its React consumers.)

/** Derived, human-meaningful connection health for the UI + diagnostics. */
export type ConnectionHealth =
  | "disconnected" // idle: not connected, no known link to recover (never connected / user disconnected)
  | "connecting" //   first connect in flight (scanning / connecting)
  | "reconnecting" // we had a link, it dropped unexpectedly — recovery pending (wake-nudge / FUT-162)
  | "degraded" //     one lens up but pair not yet ready (radios still coming up)
  | "healthy"; //     pair ready — the good state

export type ConnectionEvent = {
  at: number; // epoch ms
  health: ConnectionHealth;
  rawState: string; // underlying driver link state
  note?: string; // e.g. "link dropped", "user disconnect", "reconnect-on-wake nudge"
};

/**
 * Map raw driver flags to a single health readout. `connected` = at least one lens up;
 * `ready` = both lenses up + characteristics bound; `droppedUnexpectedly` = we had a link and
 * it fell over without the user asking (recovery pending).
 */
export function deriveHealth(
  connected: boolean,
  ready: boolean,
  rawState: string,
  droppedUnexpectedly: boolean,
): ConnectionHealth {
  if (connected) return ready ? "healthy" : "degraded";
  if (rawState === "scanning" || rawState === "connecting") return "connecting";
  if (droppedUnexpectedly) return "reconnecting"; // recovery pending (wake-nudge / FUT-162)
  return "disconnected";
}

/** Short human label for a health state (for the connection pill). */
export function healthLabel(h: ConnectionHealth): string {
  switch (h) {
    case "healthy":
      return "Connected";
    case "degraded":
      return "Booting…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "disconnected":
      return "Disconnected";
  }
}

/** What the supervisor remembers between connection-state changes. */
export type ConnTransitionPrev = {
  /** Did we have an established link at the previous tick? */
  wasConnected: boolean;
  /** Is a drop currently outstanding (recovery pending)? */
  droppedUnexpectedly: boolean;
};

/** The raw inputs a connection-state change presents. */
export type ConnTransitionInput = {
  connected: boolean;
  ready: boolean;
  rawState: string;
  /** Did the user press Disconnect (so a down state reads "disconnected", not "reconnecting")? */
  userDisconnected: boolean;
};

export type ConnTransition = {
  /** Next value for the wasConnected latch. */
  wasConnected: boolean;
  /** Next value for the droppedUnexpectedly flag. */
  droppedUnexpectedly: boolean;
  /** A transition to append to the log, or null when nothing meaningful changed. */
  event: { health: ConnectionHealth; note?: string } | null;
};

/**
 * The drop / recovery reducer — the heart of the supervisor's effect, made pure and testable.
 *
 *   • coming UP from down            → emit healthy/degraded "connected"; clear any drop flag.
 *   • staying UP                     → nothing to say.
 *   • going DOWN from an established
 *     link, user did NOT ask         → an UNEXPECTED drop: flag it, emit "reconnecting".
 *   • going/ staying DOWN otherwise  → emit "disconnected" (user) or the idle-derived health.
 */
export function reduceConnection(prev: ConnTransitionPrev, input: ConnTransitionInput): ConnTransition {
  const { connected, ready, rawState, userDisconnected } = input;

  if (connected) {
    const wasDown = !prev.wasConnected;
    return {
      wasConnected: true,
      droppedUnexpectedly: false,
      event: wasDown ? { health: ready ? "healthy" : "degraded", note: "connected" } : null,
    };
  }

  // Not connected.
  const wasUp = prev.wasConnected;
  if (wasUp && !userDisconnected) {
    // Unexpected drop from an established link. No native retry loop underneath us yet
    // (FUT-162) — surface "reconnecting"; the foreground wake-nudge is the recovery.
    return {
      wasConnected: false,
      droppedUnexpectedly: true,
      event: { health: "reconnecting", note: "link dropped" },
    };
  }
  return {
    wasConnected: false,
    droppedUnexpectedly: false,
    event: { health: userDisconnected ? "disconnected" : deriveHealth(false, false, rawState, false) },
  };
}
