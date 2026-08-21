// FFS Glasses OS — structured logger (FUT-144 · hardened FUT-253)
//
// WHY: the OS runs on the phone; on-glass/app/ring/link signals are invisible from
// the dev box. The app ships every structured log record over a WebSocket to our
// collector, which runs ON THE DEV BOX — the phone reaches it over the local adb link,
// never the internet:
//   phone  ws://127.0.0.1:8795/glog/ingest
//     └─ adb reverse tcp:8795 tcp:8795 (USB or adb-over-wifi) ─┐
//                            tools/glog-collector/server.js  ──┘ → glasses-logs/<session>.jsonl
// `adb reverse` maps the phone's localhost:8795 straight to the collector on this box,
// so it works cable-free when the glasses are worn (adb-over-wifi) and the logs never
// leave the desk. phone_link.py's `heal` restores the reverse alongside the forwards.
//
// This is pure JS → deployable via OTA (no native rebuild). It is deliberately
// SELF-HARDENED so it can never hurt the very glasses it's debugging:
//   • collector-unreachable = silent, buffered no-op (bounded ring buffer, oldest
//     dropped) — never a hot reconnect loop (exponential backoff, capped at 30s + jitter),
//   • one socket at a time, all sends wrapped, emit() never throws into the app,
//   • high-frequency SDK events (mic/accel) are NOT subscribed — no render-thread flood.
//   • collector is loopback-only (127.0.0.1) — nothing here is exposed off-device.
//
// FUT-253 TRANSPORT HARDENING (this file must survive 10× the record rate):
//   • BATCH: records coalesce into one JSON-array frame per flush (size/interval bound),
//     not one stringify+send per record.
//   • BACKPRESSURE: flush gates on ws.bufferedAmount so a stalled socket backs up into
//     OUR bounded app queue (oldest dropped, counted) — never the native socket buffer.
//   • SAMPLE: high-frequency categories (notify stream, raw ring frames) are decimated
//     keyed by cat:event; a kept record carries `_n` = how many frames it stands for.
//   • O(1)-amortized drain via a head index (no per-record Array.shift()).
//
// SECURITY NOTE: the endpoint is loopback (127.0.0.1) reached over the adb link — it is
// never exposed off-device, so no token/auth is needed. If the reverse isn't up the
// socket simply never connects and the logger buffers then drops silently (below).

import { AppState, type AppStateStatus } from "react-native";

// Minimal local shapes for the optional connection/reclaim convenience wrappers.
// (The @mentra-based shell that produced these lives in the legacy repo; this clean
// OS repo carries only the type surface the logger's helpers need.)
type ConnectionEvent = { health: string; rawState: string; note?: string; at?: number };
type ReclaimTrigger = string;

// Loopback on the dev box, reached via `adb reverse tcp:8795 tcp:8795`. No host, no TLS,
// no token — the collector is not reachable off the desk, so there is nothing to guard.
const ENDPOINT = "ws://127.0.0.1:8795/glog/ingest";

const BUFFER_CAP = 3000;          // pending records held while offline; oldest dropped past this
const MAX_BACKOFF_MS = 30_000;
const BATCH_MAX_RECORDS = 64;     // max records per WS frame
const BATCH_MAX_BYTES = 48 * 1024; // soft cap on a single frame's serialized size
const BATCH_INTERVAL_MS = 250;    // periodic flush cadence (coalesces bursts)
const BACKPRESSURE_BYTES = 1_000_000; // if native socket buffer exceeds this, stop draining
const DRAIN_STEPS_MAX = 8;        // frames sent per synchronous flush() before yielding
const COMPACT_MIN_HEAD = 512;     // compact the queue once this many records are consumed

// High-frequency categories to decimate at the source, keyed by `cat:event`. Value = keep
// 1-in-N. These sinks aren't all wired yet (notify/ring land in FUT-253 steps 3/4) but the
// governor is in place so the firehose is bounded the moment they turn on.
const HOT_KEYS: Record<string, number> = {
  "ble:notify": 20,
  "drv:notify": 20,
  "ring:raw": 30,
};

type Rec = { t: number; cat: string; event: string; seq: number; dt: number; [k: string]: unknown };

let seq = 0;
let lastT = 0;
let sessionId = "";
let deviceTag = "g2os";
let ws: WebSocket | null = null;
let connecting = false;
let backoff = 2_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Rec[] = [];
let head = 0;                     // index of first unsent record in `queue`
let started = false;
let subs: { remove(): void }[] = [];
const hotSeen: Record<string, number> = {};
let dropped = 0;                  // total records dropped (overflow) since boot
let droppedReported = 0;         // last `dropped` value we self-reported

function pending(): number {
  return queue.length - head;
}

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

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, BATCH_INTERVAL_MS);
}

function connect(): void {
  if (connecting) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // CONNECTING/OPEN
  connecting = true;
  try {
    const url =
      `${ENDPOINT}?session=${encodeURIComponent(sessionId)}` +
      `&device=${encodeURIComponent(deviceTag)}`;
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

/** Reclaim consumed queue space so the array can't grow without bound. */
function compactMaybe(): void {
  if (head >= COMPACT_MIN_HEAD && head * 2 >= queue.length) {
    queue = queue.slice(head);
    head = 0;
  }
}

/** How many bytes the native socket is holding, or 0 if the platform doesn't expose it. */
function bufferedBytes(): number {
  const b = (ws as unknown as { bufferedAmount?: number })?.bufferedAmount;
  return typeof b === "number" ? b : 0;
}

/** Send one bounded batch frame. Returns true if it sent and more may remain. */
function drainOnce(): boolean {
  if (!ws || ws.readyState !== 1) return false;
  if (bufferedBytes() > BACKPRESSURE_BYTES) return false; // let the socket catch up
  const avail = pending();
  if (avail <= 0) return false;

  // Grow the batch until a record/byte cap trips (always send at least one).
  let n = 0;
  let bytes = 2; // "[" + "]"
  while (n < avail && n < BATCH_MAX_RECORDS) {
    const s = safeStringify(queue[head + n]);
    const add = s.length + 1; // + comma
    if (n > 0 && bytes + add > BATCH_MAX_BYTES) break;
    bytes += add;
    n++;
  }
  const batch = queue.slice(head, head + n);
  let payload: string;
  try {
    payload = JSON.stringify(batch);
  } catch {
    head += n; // poison batch — drop rather than wedge the pipe
    compactMaybe();
    return true;
  }
  try {
    ws.send(payload);
    head += n;
    compactMaybe();
    return true;
  } catch {
    return false; // socket went bad mid-send; leave queued for next flush/reconnect
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return "null";
  }
}

function flush(): void {
  if (!ws || ws.readyState !== 1) {
    if (pending() > 0) scheduleFlush();
    return;
  }
  // Emit a self-report if we've dropped records since last flush (bounded: 1/flush).
  if (dropped > droppedReported) {
    const lost = dropped - droppedReported;
    droppedReported = dropped;
    queue.push({ t: Date.now(), cat: "glog", event: "dropped", seq: seq++, dt: 0, lost, total: dropped });
  }
  for (let i = 0; i < DRAIN_STEPS_MAX; i++) {
    if (!drainOnce()) break;
    if (bufferedBytes() > BACKPRESSURE_BYTES) break;
  }
  if (pending() > 0) scheduleFlush(); // socket buffer full or more than one flush of work
}

/** Core: record a structured event. Cheap, non-throwing, safe from any context. */
export function emit(cat: string, event: string, data?: Record<string, unknown>): void {
  try {
    // Source-side decimation for high-frequency keys: keep 1-in-N, annotate the survivor.
    const nth = HOT_KEYS[`${cat}:${event}`];
    let payload = data;
    if (nth) {
      const c = (hotSeen[`${cat}:${event}`] = (hotSeen[`${cat}:${event}`] || 0) + 1);
      if (c % nth !== 0) return; // dropped by sampling — cheap, no queue growth
      payload = { ...(data || {}), _n: nth };
    }

    const t = Date.now();
    const rec: Rec = { t, cat, event, seq: seq++, dt: lastT ? t - lastT : 0, ...(payload || {}) };
    lastT = t;
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log(`[glog ${cat}] ${event}`, data ?? "");
    }
    queue.push(rec);

    // Bounded ring: if we're past cap, drop the OLDEST unsent by advancing head.
    const over = pending() - BUFFER_CAP;
    if (over > 0) {
      head += over;
      dropped += over;
      compactMaybe();
    }

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
  /** The active session id (so the UI / collector can correlate). */
  session: () => sessionId,
};

/**
 * Core logger boot — mint a session, open the WSS, wire AppState. NO @mentra SDK
 * subscriptions. Use this from stacks that don't run the mentra pipes (e.g. the
 * ffs-ble P1 test harness), so their logs still reach the on-desk collector over the
 * adb link without pulling mentra into the loop.
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
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    ws?.close();
  } catch {
    /* best effort */
  }
  ws = null;
  started = false;
}
