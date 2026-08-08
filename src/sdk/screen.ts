// Screen sessions — the heart of the SDK.
//
// A screen is a RESOURCE WITH A LIFETIME, not a projection of state. `show()` acquires an
// on-glass screen, `next()` parks until the firmware reports something, `close()` releases it.
//
// There is deliberately NO RECONCILER. A declare-once model and a reconciler are in tension:
// any diffing layer can accidentally reintroduce the per-scroll re-render this SDK exists to
// eliminate. Measured on hardware: a native list scrolled row 0 -> row 1 with ZERO wire traffic;
// the phone heard nothing until the user tapped. Preserving that is the whole design.

import { CONTAINER_IDS, encodeListPage, encodeUpdateText } from "./wire";
import { normalizeEvent, EventType, type GlassesEvent } from "./events";
import {
  assertProven,
  LIMITS,
  type AwaitOptions,
  type DeclareReport,
  type Row,
  type ScreenEvent,
  type ScreenState,
  type Selection,
  type SessionStats,
} from "./types";

/** The transport the SDK needs. Implemented over the native module; faked in tests. */
export interface Transport {
  /** Send one EvenHub payload to the glasses. */
  sendEvenHub(bytes: Uint8Array): Promise<void>;
  /** Subscribe to raw inbound EvenHub payloads. Returns an unsubscribe function. */
  onInbound(handler: (payload: Uint8Array) => void): () => void;
}

export interface ListScreenOptions {
  rows: readonly Row<any>[];
  containerName?: string;
  /**
   * Optional title drawn above the list. Costs one text container and no interaction budget —
   * a page can carry both, proven on-glass.
   */
  header?: string;
  /** Bypass the provenance gate — only for the experiment that PROVES a capability. */
  allowUnproven?: boolean;
}

/**
 * Whether the firmware currently holds a page — CONNECTION-scoped state, deliberately not
 * screen-scoped.
 *
 * The firmware has exactly one page slot, and a second CREATE on it is SILENTLY IGNORED
 * (FUT-153). So "is this a CREATE or a REBUILD?" is a question about the LINK, not about the
 * screen asking. Deciding it per-screen looks natural and is wrong: every pushed submenu would
 * start life believing it had never declared, send a second CREATE, and be dropped on the floor
 * with no error anywhere — the page simply would not change. A menu tree is precisely the shape
 * that hits this on the very first navigation.
 *
 * The Kotlin driver already models it this way (`G2Central.pageCreated`, cleared on teardown);
 * this type is the SDK agreeing with the driver instead of quietly contradicting it.
 */
export class PageSlot {
  private _created = false;
  /** True once a CREATE has landed, i.e. every later page must REBUILD. */
  get created(): boolean { return this._created; }
  markCreated(): void { this._created = true; }
  /**
   * The firmware no longer holds a page — the link dropped, or the session was torn down.
   * The next declare must CREATE again. Mirrors `pageCreated = false` in the driver.
   */
  reset(): void { this._created = false; }
}

let screenSeq = 0;

export class ListScreen<V = string> {
  readonly id = `screen-${++screenSeq}`;
  private _state: ScreenState = "live";
  private _generation = 0;
  private _rows: readonly Row<V>[];
  private _lastWire: string | null = null;
  private readonly _queue: ScreenEvent<V>[] = [];
  private readonly _waiters: Array<(e: ScreenEvent<V>) => void> = [];
  private _off: (() => void) | null = null;

  constructor(
    private readonly tx: Transport,
    private readonly stats: SessionStats,
    private readonly opts: ListScreenOptions,
    private readonly magic: () => number,
    /**
     * The link's page slot. Defaults to a private one, which is correct ONLY for a screen that
     * is the only thing ever declared on that link (single-screen apps, unit tests). Anything
     * with a stack must pass the Session's shared slot — see PageSlot.
     */
    private readonly slot: PageSlot = new PageSlot()
  ) {
    this._rows = opts.rows as readonly Row<V>[];
  }

  get state(): ScreenState { return this._state; }
  get generation(): number { return this._generation; }
  get rows(): readonly Row<V>[] { return this._rows; }

  /** Declare the screen on the glasses. Idempotent: identical bytes cost nothing. */
  async declare(reason: DeclareReport["reason"] = "declare"): Promise<DeclareReport> {
    if (this._state === "closed") throw new Error(`${this.id} is closed`);
    assertProven("list.declare", this.opts.allowUnproven);
    if (this._rows.length > LIMITS.LIST_ROWS_PROVEN) {
      assertProven("list.rows48", this.opts.allowUnproven);
    }

    const warnings: string[] = [];
    if (this._rows.length > LIMITS.LIST_ROWS_PROVEN) {
      warnings.push(
        `${this._rows.length} rows exceeds the ${LIMITS.LIST_ROWS_PROVEN} proven on hardware`
      );
    }
    const name = this.opts.containerName ?? "ffs-list";
    if (name.length > LIMITS.CONTAINER_NAME_MAX) {
      warnings.push(`container name "${name}" exceeds ${LIMITS.CONTAINER_NAME_MAX} chars`);
    }

    // THE ASSERTION THAT PROTECTS THE ARCHITECTURE: identical CONTENT costs zero bytes.
    //
    // Compare the content, NOT the encoded envelope. The envelope carries a magic number and a
    // CREATE-vs-REBUILD command, both of which legitimately differ between two declarations of
    // the very same page — comparing those would mean an identical page never looked identical
    // and the no-op path could never fire. Content is what the user sees; that is what must be
    // unchanged for a re-declare to be free.
    const fingerprint = JSON.stringify([
      name,
      this.opts.header ?? null,
      this._rows.map((r) => [r.label, r.disabled === true]),
    ]);
    if (fingerprint === this._lastWire) {
      return { generation: this._generation, ops: [{ op: "noop", reason: "identical" }], bytes: 0, reason: "identical", warnings };
    }

    // A page CREATE is only valid once per LINK; every later page must REBUILD, because a
    // second CREATE is silently ignored by the firmware (FUT-153: "stuck on the image").
    // Asking the shared slot rather than this screen's own generation is what makes a pushed
    // submenu render at all — see PageSlot.
    const rebuild = this.slot.created;
    const bytes = encodeListPage({
      items: this._rows.map((r) => r.label),
      rebuild,
      magic: this.magic(),
      containerName: name,
      header: this.opts.header,
    });

    if (this._off === null) {
      this._off = this.tx.onInbound((p) => this._ingest(p));
    }
    await this.tx.sendEvenHub(bytes);
    this.slot.markCreated();
    this._lastWire = fingerprint;
    this._generation += 1;
    this.stats.declareCount += 1;
    this.stats.bytesOut += bytes.length;
    return {
      generation: this._generation,
      ops: [{ op: rebuild ? "pageRebuild" : "pageCreate", containers: 1 }],
      bytes: bytes.length,
      reason,
      warnings,
    };
  }

  /**
   * Change the header text IN PLACE — no page rebuild, and crucially no loss of list focus.
   *
   * A REBUILD re-declares the page and sends the list's selection back to row 0, so anything
   * that ticks (a clock, a timer, a battery readout) cannot use `update()` without yanking the
   * user's selection out from under them mid-scroll. This is the only way to have a live value
   * on a screen the user is also navigating.
   *
   * Does NOT touch the declare fingerprint or the generation: the page structure is unchanged,
   * only the bytes inside one container.
   */
  async setHeaderText(text: string): Promise<void> {
    if (this._state === "closed") throw new Error(`${this.id} is closed`);
    if (this.opts.header === undefined) {
      throw new Error(`${this.id} has no header container to update`);
    }
    const bytes = encodeUpdateText({
      containerId: CONTAINER_IDS.text,
      content: text,
      magic: this.magic(),
    });
    await this.tx.sendEvenHub(bytes);
    this.stats.bytesOut += bytes.length;
    this.stats.textUpdates += 1;
  }

  /**
   * Re-declare with new rows. ONE page rebuild, same screen identity and event queue.
   *
   * Identical rows are a genuine no-op — that is what lets a test scroll 20 rows on-glass and
   * assert `declareCount === 1` with zero bytes out.
   */
  async update(rows: readonly Row<V>[]): Promise<DeclareReport> {
    this._rows = rows;
    return this.declare("redeclare");
  }

  /**
   * Park until the glasses report something about this screen.
   *
   * Back and eviction are VALUES, not exceptions: there is no exception-driven control flow
   * here, so a stray `catch {}` in an app cannot silently swallow the second-most-common user
   * action. Events are QUEUED rather than dropped — a tap landing between one await resolving
   * and the next beginning is delivered to the next call, so a fast double-tap loses nothing.
   */
  next(opts: AwaitOptions = {}): Promise<ScreenEvent<V>> {
    if (this._state === "closed") return Promise.reject(new Error(`${this.id} is closed`));
    const queued = this._queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise<ScreenEvent<V>>((resolve, reject) => {
      let settled = false;
      const done = (e: ScreenEvent<V>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(e);
      };
      this._waiters.push(done);

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            const i = this._waiters.indexOf(done);
            if (i >= 0) this._waiters.splice(i, 1);
            reject(new Error(`await timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : (undefined as unknown as ReturnType<typeof setTimeout>);

      opts.signal?.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const i = this._waiters.indexOf(done);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }

  /** Sugar for the common case: resolve on a row click, null on back/eviction. */
  async nextSelection(opts: AwaitOptions = {}): Promise<Selection<V> | null> {
    for (;;) {
      const e = await this.next(opts);
      if (e.kind === "select") {
        if (e.row.disabled) continue; // absorb and re-arm
        return e;
      }
      if (e.kind === "back" || e.kind === "evicted") return null;
      // resumed / raw -> re-arm
    }
  }

  /**
   * Forget the last-declared fingerprint so the next declare() actually writes.
   *
   * Needed by restore: after a pop or a reconnect the GLASSES no longer hold this page, but the
   * screen object still believes it does — so the identical-content no-op would suppress exactly
   * the write that puts it back. The no-op is an optimisation about the glasses' state, and when
   * that state is externally invalidated it has to be told.
   */
  forceRedeclare(): void {
    this._lastWire = null;
  }

  /**
   * Stop accepting events because another screen is now on the glasses.
   *
   * The firmware shows ONE page, so at most one screen can be the subject of an event. A screen
   * that stays subscribed while a child is on top will queue the CHILD's taps — and replay them
   * the moment it comes back, which reads to the user as backing out of a submenu and instantly
   * re-entering a random screen. Suspension is what makes "only the top screen hears anything"
   * true rather than merely intended.
   *
   * Already-queued events survive: those genuinely happened while this screen WAS on-glass.
   */
  suspend(): void {
    if (this._state === "live") this._state = "suspended";
  }

  /** Back on the glasses; accept events again. */
  resume(): void {
    if (this._state === "suspended") this._state = "live";
  }

  close(): void {
    this._state = "closed";
    this._off?.();
    this._off = null;
  }

  /** Feed a raw inbound payload in. Exposed for tests; the transport calls it in production. */
  _ingest(payload: Uint8Array): void {
    // Only the screen actually ON the glasses can be the subject of an event — see suspend().
    if (this._state !== "live") return;
    const evt = normalizeEvent(payload);
    if (!evt) return;
    this.stats.eventsIn += 1;
    const mapped = this._map(evt);
    if (!mapped) return;
    const w = this._waiters.shift();
    if (w) w(mapped);
    else this._queue.push(mapped); // queue, never drop
  }

  private _map(evt: GlassesEvent): ScreenEvent<V> | null {
    if (evt.kind === "select") {
      const row = this._rows[evt.index];
      if (!row) return { kind: "raw", event: evt };
      return {
        kind: "select",
        index: evt.index,
        row,
        value: row.value,
        generation: this._generation,
      };
    }
    if (evt.kind === "sys") {
      // Double-tap is the firmware's "back": it arrives as a SysEvent, NOT a list event, even
      // with a list on screen. Captured 2026-08-07.
      if (evt.type === EventType.DOUBLE_CLICK) return { kind: "back" };
      if (evt.type === EventType.FOREGROUND_EXIT || evt.type === EventType.ABNORMAL_EXIT) {
        return { kind: "evicted" };
      }
      if (evt.type === EventType.FOREGROUND_ENTER) return { kind: "resumed" };
    }
    return { kind: "raw", event: evt };
  }
}

export function newStats(): SessionStats {
  return {
    declareCount: 0, bytesOut: 0, eventsIn: 0,
    restores: { pop: 0, reconnect: 0 }, scrollRoundTrips: 0, textUpdates: 0,
  };
}
