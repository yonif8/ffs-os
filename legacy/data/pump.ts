// The pump — poll the sources, decide what is worth sending, hand it to the transport.
//
// This is the whole brain-side loop, and it is pure: `now`, `fetch`, `send` and `linkUp` are
// all injected, so every branch below is exercised on a PC with no phone and no glasses.
//
// ── WHAT HAPPENS WHEN THINGS GO WRONG, stated rather than discovered ──────────────────
//
//   the source throws            log `fetch-failed`; the glasses KEEP the value they hold.
//                                The next poll is a normal poll — no backoff ladder, because
//                                the interval is already the backoff and a second timing
//                                rule is a second thing to be wrong.
//   the blob is too big          log `too-big` and never offer it. The glasses would answer
//                                G2D_ERR_SIZE; refusing here makes it a phone-side fact with
//                                a source id attached, instead of an err nibble on a face.
//   nothing changed              log `unchanged` and send nothing. The glasses dedupe too,
//                                but not sending at all is cheaper than sending and being
//                                deduped, and it keeps the radio quiet.
//   the link is down             log `holding`; the value stays in the outbox and goes out
//                                on the next tick after the link returns. Nothing is queued
//                                behind it — see outbox.ts.
//   the send throws              log `send-failed` with the attempt count; the value stays.
//   the app is not running       NOT OUR PROBLEM, and deliberately so. The channel is
//                                addressed to an app_id, not to a running app: the value
//                                sits in the glasses' mailbox and is there the moment the
//                                app is launched. A transport that required the app to be
//                                up would make "launch the app" and "get data" two failures
//                                that look like one.
//   the glasses are asleep       the value still lands (BLE rx is independent of the panel)
//                                and the shell is marked dirty, so it is drawn when the HUD
//                                next paints. ⚠️ A push does not WAKE the display — that is
//                                the wake broadcast's job, and conflating the two is how
//                                "the push did nothing" gets diagnosed wrong.
//
// ⛔ PRIVACY. Nothing here logs a blob, any part of one, or anything derived from one except
//    its byte count and CRC. `ffs_os` is PUBLIC and `src/os/log.ts` ships records off-device.

import { fxp1Frame } from "../sdk/ble/fxp1";
import { crc32 } from "../sdk/ble/crc";
import { FFSC_MAX_BLOB, encodeFfsc } from "../sdk/ffsc";
import { Outbox } from "./outbox";
import type { DataEvent, DataLogger, DataSource, Pending } from "./types";

export interface PumpDeps {
  sources: DataSource[];
  /** Hand the finished FXP1 frame to the transport. Throw to report a failed send. */
  send(frame: Uint8Array, meta: { appId: number; seq: number; sourceId: string }): Promise<void>;
  /** Is the BLE link up right now? */
  linkUp(): boolean;
  now(): number;
  log?: DataLogger;
}

/** Counters a UI or a test can read without reaching into the pump's internals. */
export interface PumpStats {
  polls: number;
  fetchFailures: number;
  unchanged: number;
  superseded: number;
  sends: number;
  sendFailures: number;
  held: number;
  /** breaker trips — a send followed promptly by a link drop (a probable lens crash). */
  breakerTrips: number;
  /** values withheld because their app's breaker was open. */
  breakerBlocked: number;
}

const ERR_MAX = 120;

/**
 * ⛔ THE CIRCUIT-BREAKER WINDOW. A lens that faults on a push watchdog-resets, which DROPS the
 * BLE link within a second or two. So a link-down this soon after a send is read as "the value
 * we just pushed crashed the lens", and that app's channel is tripped: no automatic resend.
 *
 * This exists because on 2026-08-21 a single crashing FFSC push to the messages app became a
 * crash-LOOP — the lens reset, the link came back, the service's reconnect path re-sent the same
 * value, and it crashed again. The app bug that caused it is fixed, but "a crashing push must
 * never auto-retry" has to be true independently of any one app being correct. Manual re-arm
 * (resetBreaker, wired to the panel's "push now") is the only way back out — a deliberate retry,
 * never an automatic one.
 *
 * 12 s is comfortably longer than a crash→reset→reconnect cycle and far shorter than any normal
 * session gap, so an ordinary user-initiated disconnect (seconds to minutes after the last push)
 * does not trip it.
 *
 * ⚠️ ONE crash-correlated drop is NOT enough to trip. A push followed instantly by a drop is
 * genuinely ambiguous — it is exactly what a normal down→up reconnect looks like too, and the
 * pump's whole reconnect-resend behaviour depends on that being allowed once. The thing we must
 * kill is the LOOP: push → crash → reconnect → resend → crash → … So the breaker trips on the
 * SECOND consecutive crash-correlated drop (CRASH_STRIKES), which is a resend that also crashed —
 * unambiguously a loop, and bounded at two crashes instead of infinite. Strikes DECAY: two drops
 * more than SUSPECT_DECAY_MS apart are treated as unrelated coincidences, not a loop.
 */
const CRASH_WINDOW_MS = 12_000;
const CRASH_STRIKES = 2;
const SUSPECT_DECAY_MS = 60_000;

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > ERR_MAX ? `${s.slice(0, ERR_MAX)}…` : s;
}

export class DataPump {
  readonly outbox = new Outbox();
  readonly stats: PumpStats = {
    polls: 0,
    fetchFailures: 0,
    unchanged: 0,
    superseded: 0,
    sends: 0,
    sendFailures: 0,
    held: 0,
    breakerTrips: 0,
    breakerBlocked: 0,
  };

  /** last poll time per source id */
  private readonly polledAt = new Map<string, number>();
  /** CRC-32 of the last blob the GLASSES accepted, per appId — the "did anything change" test */
  private readonly landed = new Map<number, number>();
  /** when we last handed a value to the transport, per appId — the breaker's crash-window base */
  private readonly sentAt = new Map<number, number>();
  /** consecutive crash-correlated drops per appId: {count, at}. Trips at CRASH_STRIKES; decays. */
  private readonly suspect = new Map<number, { count: number; at: number }>();
  /** apps whose channel is tripped: an auto-resend is refused until resetBreaker() */
  private readonly tripped = new Set<number>();

  constructor(private readonly deps: PumpDeps) {}

  /**
   * The link just dropped. If it dropped within CRASH_WINDOW_MS of a send, that send is the
   * prime suspect for having faulted the lens, so trip its app. Call this from whatever observes
   * a real BLE disconnect (promptly — do not wait for the next tick, or the reconnect re-send
   * races ahead of the trip). Tripping the same app twice is harmless.
   */
  noteLinkDown(now: number): void {
    for (const [appId, at] of this.sentAt) {
      const dt = now - at;
      if (dt < 0 || dt >= CRASH_WINDOW_MS || this.tripped.has(appId)) continue;
      // A crash-correlated drop. Count consecutive ones; decay any that are far apart (a loop's
      // drops are seconds apart, coincidences are not). Trip only on the CRASH_STRIKES-th — the
      // resend that also crashed, which is unambiguously a loop rather than one odd disconnect.
      const prev = this.suspect.get(appId);
      const count = (prev && now - prev.at <= SUSPECT_DECAY_MS ? prev.count : 0) + 1;
      this.suspect.set(appId, { count, at: now });
      if (count >= CRASH_STRIKES) {
        this.tripped.add(appId);
        this.suspect.delete(appId);
        this.stats.breakerTrips += 1;
        this.emit({ kind: "breaker-tripped", appId, sinceSendMs: dt });
      }
    }
  }

  /** Is this app's breaker open (auto-sends refused)? */
  isTripped(appId: number): boolean {
    return this.tripped.has(appId);
  }

  /**
   * Manual re-arm — the ONLY way a tripped channel sends again. Wired to the panel's "push now",
   * so retrying a value that crashed the lens is always a deliberate human act. Clears the
   * crash-window base too, so the re-armed send starts a fresh window rather than an aged one.
   */
  resetBreaker(appId?: number): void {
    const clear = (id: number) => {
      if (this.tripped.delete(id)) this.emit({ kind: "breaker-reset", appId: id });
      this.sentAt.delete(id);
      this.suspect.delete(id);
    };
    // When clearing all, cover apps that are tripped OR merely carrying strikes.
    if (appId === undefined) new Set([...this.tripped, ...this.suspect.keys()]).forEach(clear);
    else clear(appId);
  }

  private emit(ev: DataEvent): void {
    this.deps.log?.(ev);
  }

  /** Force the next tick to poll this source (or all of them) regardless of its interval. */
  refresh(sourceId?: string): void {
    if (sourceId === undefined) this.polledAt.clear();
    else this.polledAt.delete(sourceId);
  }

  /**
   * Make the glasses forget what we think they hold, so the next identical value is sent
   * anyway. Call it when the link came back after a reboot: the mailbox is empty over there
   * and `unchanged` would otherwise keep us politely silent forever.
   */
  forgetLanded(appId?: number): void {
    if (appId === undefined) this.landed.clear();
    else this.landed.delete(appId);
  }

  private due(source: DataSource, now: number): boolean {
    const last = this.polledAt.get(source.id);
    return last === undefined || now - last >= source.everyMs;
  }

  /** One round: poll what is due, then try to drain. Never throws. */
  async tick(): Promise<void> {
    await this.poll();
    await this.drain();
  }

  async poll(): Promise<void> {
    const now = this.deps.now();
    for (const source of this.deps.sources) {
      if (!this.due(source, now)) continue;
      this.polledAt.set(source.id, now);
      this.stats.polls += 1;
      let blob: Uint8Array;
      const t0 = this.deps.now();
      try {
        blob = await source.fetch(now);
      } catch (e) {
        this.stats.fetchFailures += 1;
        this.emit({ kind: "fetch-failed", source: source.id, appId: source.appId, error: errText(e) });
        continue;
      }
      this.emit({
        kind: "fetched",
        source: source.id,
        appId: source.appId,
        bytes: blob.length,
        ms: this.deps.now() - t0,
      });

      if (blob.length === 0 || blob.length > FFSC_MAX_BLOB) {
        this.emit({
          kind: "too-big",
          source: source.id,
          appId: source.appId,
          bytes: blob.length,
          cap: FFSC_MAX_BLOB,
        });
        continue;
      }
      if (this.landed.get(source.appId) === crc32(blob)) {
        this.stats.unchanged += 1;
        this.emit({ kind: "unchanged", source: source.id, appId: source.appId });
        continue;
      }

      const { superseded } = this.outbox.offer(source.appId, source.id, blob, this.deps.now());
      if (superseded) {
        this.stats.superseded += 1;
        this.emit({
          kind: "superseded",
          source: source.id,
          appId: source.appId,
          droppedSeq: superseded.seq,
        });
      }
    }
  }

  async drain(): Promise<void> {
    const waiting = this.outbox.pending();
    if (waiting.length === 0) return;
    if (!this.deps.linkUp()) {
      this.stats.held += 1;
      this.emit({ kind: "holding", appId: waiting[0].appId, pending: waiting.length, reason: "link-down" });
      return;
    }
    for (const entry of waiting) await this.sendOne(entry);
  }

  private async sendOne(entry: Pending): Promise<void> {
    // ⛔ Breaker open: this app crashed a lens on its last push and has not been re-armed. Withhold
    // the value — it stays in the outbox, so a manual resetBreaker() + drain still delivers it,
    // but nothing here retries it on its own. This is the line that turns a crash-loop into a
    // single crash.
    if (this.tripped.has(entry.appId)) {
      this.stats.breakerBlocked += 1;
      this.emit({ kind: "breaker-blocked", source: entry.sourceId, appId: entry.appId, seq: entry.seq });
      return;
    }
    const frame = fxp1Frame(encodeFfsc({ appId: entry.appId, seq: entry.seq, blob: entry.blob }));
    // Stamp the crash-window base BEFORE the write: if this very push faults the lens, the link
    // drop that follows must fall inside the window measured from here.
    this.sentAt.set(entry.appId, this.deps.now());
    try {
      await this.deps.send(frame, { appId: entry.appId, seq: entry.seq, sourceId: entry.sourceId });
    } catch (e) {
      const attempts = this.outbox.retry(entry.appId, entry.seq);
      this.stats.sendFailures += 1;
      this.emit({
        kind: "send-failed",
        source: entry.sourceId,
        appId: entry.appId,
        seq: entry.seq,
        attempts,
        error: errText(e),
      });
      return;
    }
    // ⚠️ "sent" is not "landed". The `⟨LOADER … ret=0x64…⟩` line is what says the glasses
    // ACCEPTED it, and only `decodeFfscRet` can read that. We record the digest here anyway
    // because the alternative — re-sending every tick until a readback confirms — is a radio
    // loop for a device we cannot poll cheaply. `forgetLanded()` is the escape hatch for the
    // one case where this assumption is wrong: the glasses rebooted and lost the mailbox.
    this.landed.set(entry.appId, crc32(entry.blob));
    this.outbox.settle(entry.appId, entry.seq);
    this.stats.sends += 1;
    this.emit({
      kind: "sent",
      source: entry.sourceId,
      appId: entry.appId,
      seq: entry.seq,
      bytes: entry.blob.length,
      frameBytes: frame.length,
    });
  }
}
