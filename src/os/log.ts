// FFS Glasses OS — off-device structured logger (FUT-144)
//
// WHY: the OS runs on Yoni's iPhone; Rico debugs from a Linux box. To read what the
// OS is doing LIVE (esp. the ~20s "connection lost → home" cycle we're chasing on
// FUT-136), the app ships every structured log record over a WebSocket to our
// collector (g2app.x36.site/glog → localhost:8795 → ~/glasses-logs/<session>.jsonl),
// which Rico tails with the `glasses-logs` CLI.
//
// This is pure JS → deployable via OTA (no native rebuild). It is deliberately
// SELF-HARDENED so it can never hurt the very glasses it's debugging:
//   • collector-unreachable = silent, buffered no-op (bounded ring buffer, oldest
//     dropped) — never a hot reconnect loop (exponential backoff, capped at 30s + jitter),
//   • one socket at a time, all sends wrapped, emit() never throws into the app,
//   • high-frequency SDK events (mic/accel) are NOT subscribed — no render-thread flood.
//
// SECURITY NOTE: the endpoint is public and the token below is a light spam-guard on a
// THROWAWAY diagnostic sink (the collector only accepts writes, it can't read back).
// Tear the /glog route down + rotate when diagnosis is done (see FUT-144).

import { AppState, type AppStateStatus } from "react-native";

// Minimal local shapes for the optional connection/reclaim convenience wrappers.
// (The @mentra-based shell that produced these lives in the legacy repo; this clean
// OS repo carries only the type surface the logger's helpers need.)
type ConnectionEvent = { health: string; rawState: string; note?: string; at?: number };
type ReclaimTrigger = string;

const ENDPOINT = "wss://g2app.x36.site/glog/ingest";
// Injected at build time from a private GitHub Actions secret (EXPO_PUBLIC_GLOG_TOKEN);
// never hardcoded in this public repo. Empty = telemetry ships without a token (the
// collector may reject it) — the logger degrades silently, it never breaks the app.
const TOKEN = process.env.EXPO_PUBLIC_GLOG_TOKEN ?? "";
const BUFFER_CAP = 3000; // records held while offline; oldest dropped past this
const MAX_BACKOFF_MS = 30_000;

type Rec = { t: number; cat: string; event: string; seq: number; dt: number; [k: string]: unknown };

let seq = 0;
let lastT = 0;
let sessionId = "";
let deviceTag = "g2os";
let ws: WebSocket | null = null;
let connecting = false;
let backoff = 2_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Rec[] = [];
let started = false;
let subs: { remove(): void }[] = [];

function newSessionId(): void {
  const rnd = Math.random().toString(36).slice(2, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  sessionId = `${deviceTag}-${stamp}-${rnd}`;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const jitter = Math.floor(Math.random() * 1000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff + jitter);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

function connect(): void {
  if (connecting) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // CONNECTING/OPEN
  connecting = true;
  try {
    const url =
      `${ENDPOINT}?session=${encodeURIComponent(sessionId)}` +
      `&device=${encodeURIComponent(deviceTag)}&token=${TOKEN}`;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      connecting = false;
      backoff = 2_000; // reset on a good connection
      flush();
    };
    sock.onclose = () => {
      connecting = false;
      if (ws === sock) ws = null;
      scheduleReconnect();
    };
    sock.onerror = () => {
      // onclose fires right after; reconnect is handled there.
    };
  } catch {
    connecting = false;
    scheduleReconnect();
  }
}

function flush(): void {
  if (!ws || ws.readyState !== 1) return;
  try {
    while (queue.length) {
      ws.send(JSON.stringify(queue[0]));
      queue.shift();
    }
  } catch {
    // Socket went bad mid-flush; leave the rest queued for the next flush/reconnect.
  }
}

/** Core: record a structured event. Cheap, non-throwing, safe from any context. */
export function emit(cat: string, event: string, data?: Record<string, unknown>): void {
  try {
    const t = Date.now();
    const rec: Rec = { t, cat, event, seq: seq++, dt: lastT ? t - lastT : 0, ...(data || {}) };
    lastT = t;
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log(`[glog ${cat}] ${event}`, data ?? "");
    }
    queue.push(rec);
    if (queue.length > BUFFER_CAP) queue.splice(0, queue.length - BUFFER_CAP);
    flush();
    if (!ws || ws.readyState > 1) connect(); // CLOSING/CLOSED → reconnect
  } catch {
    // Logging must NEVER break the app.
  }
}

/** Convenience wrappers used by the OS wiring. */
export const glog = {
  emit,
  /** ConnectionSupervisor transition (its onEvent sink). */
  conn(e: ConnectionEvent): void {
    emit("conn", "supervisor", { health: e.health, rawState: e.rawState, note: e.note, at: e.at });
  },
  /** Raw connection snapshot — every observable state change from the RN hook. */
  connState(s: {
    connected: boolean;
    ready: boolean;
    rawState: string;
    busy?: boolean;
    battery?: number | null;
    hasDefault?: boolean;
    error?: string | null;
  }): void {
    emit("conn", "state", s);
  },
  /** HUD surface repaint (reclaim.ts onReclaim). */
  reclaim(trigger: ReclaimTrigger): void {
    emit("reclaim", "repaint", { trigger });
  },
  lifecycle(state: string): void {
    emit("lifecycle", state);
  },
  error(where: string, err: unknown): void {
    emit("error", where, { message: String((err as Error)?.message ?? err) });
  },
  /** The active session id (so the UI / Rico can correlate). */
  session: () => sessionId,
};

/**
 * Core logger boot — mint a session, open the WSS, wire AppState. NO @mentra SDK
 * subscriptions. Use this from stacks that don't run the mentra pipes (e.g. the
 * ffs-ble P1 test harness), so their logs still ship off-device to the FUT-144
 * collector (tail with the `glasses-logs` CLI) without pulling mentra into the loop.
 * Idempotent. `boot` carries app/runtime version context for the session header.
 */
export function initLoggerCore(boot?: Record<string, unknown>): void {
  if (started) return;
  started = true;
  newSessionId();
  connect();
  emit("lifecycle", "boot", { session: sessionId, ...(boot || {}) });

  // App foreground/background — directly relevant to reconnect-on-wake behaviour.
  const appSub = AppState.addEventListener("change", (next: AppStateStatus) => emit("lifecycle", "appstate", { state: next }));
  subs.push(appSub);
}

/** Tear down (rarely needed; app lifetime = session lifetime). */
export function stopLogger(): void {
  for (const s of subs) {
    try {
      s.remove();
    } catch {
      /* best effort */
    }
  }
  subs = [];
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws?.close();
  } catch {
    /* best effort */
  }
  ws = null;
  started = false;
}
