// The screen stack — menu -> submenu -> back, and the restore path.
//
// THE LOAD-BEARING IDEA: popping a child and recovering from a reconnect are THE SAME FUNCTION.
//
// The firmware has no page stack; it holds exactly one page. So returning from a submenu means
// re-declaring the parent — which is byte-for-byte what a reconnect has to do after the glasses
// come back with nothing on screen. Implementing them once means the least-testable path in the
// SDK (reconnect recovery, which needs a dropped link to exercise) becomes the MOST-exercised
// one: if restore is broken, the settings app breaks in the first minute of ordinary use, on a
// perfectly healthy link. That is a much cheaper way to find the bug.

import { ListScreen, PageSlot, newStats, type Transport, type ListScreenOptions } from "./screen";
import type { Row, ScreenEvent, Selection, SessionStats } from "./types";

export type RestoreCause = "pop" | "reconnect" | "eviction-return";

export interface SessionOptions {
  transport: Transport;
  /**
   * Whether the firmware ALREADY holds a page when this session starts (ask the driver via
   * `takeoverPage()`). Seeds the page slot: if something already rendered on this link, the
   * first declare must REBUILD, because a second CREATE is silently ignored and the HUD would
   * simply never change.
   */
  pageAlreadyCreated?: boolean;
  /** Magic/nonce source. Injected so tests are deterministic — the SDK never calls Math.random. */
  magic?: () => number;
  onRestore?: (cause: RestoreCause, depth: number) => void;
}

export class Session {
  readonly stats: SessionStats = newStats();
  /**
   * The link's single firmware page slot, shared by every screen in the stack. One per Session
   * because there is one per link — see PageSlot for why per-screen is a silent-failure bug.
   */
  readonly pageSlot = new PageSlot();
  private readonly stack: ListScreen<any>[] = [];
  private readonly tx: Transport;
  private readonly magic: () => number;
  private readonly onRestore?: (cause: RestoreCause, depth: number) => void;
  private magicCounter = 100;

  constructor(opts: SessionOptions) {
    this.tx = opts.transport;
    if (opts.pageAlreadyCreated) this.pageSlot.markCreated();
    this.onRestore =
      opts.onRestore;
    this.magic =
      opts.magic ??
      (() => {
        // 100..255, matching the driver's own nonce range. Deterministic, not random: a random
        // nonce would make encoded pages unpinnable in tests for no benefit.
        this.magicCounter = this.magicCounter >= 255 ? 100 : this.magicCounter + 1;
        return this.magicCounter;
      });
  }

  get depth(): number { return this.stack.length; }
  get top(): ListScreen<any> | undefined { return this.stack[this.stack.length - 1]; }

  /**
   * Push a new list screen and declare it.
   *
   * If the declare FAILS the push unwinds completely: the half-born screen is removed and the
   * parent is resumed. Without that, a failed push leaves the parent suspended forever and a
   * dead screen on the stack — the glasses keep rendering the parent while every tap goes
   * nowhere, which is indistinguishable from a frozen list and nearly impossible to trace back
   * to the push that failed. A declare can fail for entirely ordinary reasons (the link drops
   * mid-write, the firmware rejects the page), so this is not a theoretical path.
   */
  async push<V = string>(opts: ListScreenOptions): Promise<ListScreen<V>> {
    const parent = this.top;
    // The screen being covered is no longer on the glasses, so it must stop hearing events —
    // otherwise it queues the CHILD's taps and replays them on the way back out.
    parent?.suspend();
    const s = new ListScreen<V>(this.tx, this.stats, opts, this.magic, this.pageSlot);
    this.stack.push(s);
    try {
      await s.declare();
    } catch (e) {
      const i = this.stack.indexOf(s);
      if (i >= 0) this.stack.splice(i, 1);
      s.close();
      parent?.resume();
      throw e;
    }
    return s;
  }

  /**
   * Pop the top screen and restore the one beneath it.
   *
   * This calls the SAME declareTop() that reconnect recovery uses — see the file header.
   */
  async pop(): Promise<void> {
    const gone = this.stack.pop();
    gone?.close();
    if (this.stack.length) {
      await this.declareTop("pop");
    }
  }

  /**
   * Re-declare whatever is on top. The single restore path.
   *
   * `cause` is reported, never branched on: if pop and reconnect ever needed different logic,
   * the shared-path guarantee would be a lie.
   */
  async declareTop(cause: RestoreCause): Promise<void> {
    const t = this.top;
    if (!t) return;
    // It is about to be on the glasses again, so it may hear events again.
    t.resume();
    t.forceRedeclare();
    await t.declare("restore");
    if (cause === "pop") this.stats.restores.pop += 1;
    else this.stats.restores.reconnect += 1;
    this.onRestore?.(cause, this.stack.length);
  }

  /**
   * Call when the link DROPS. The firmware kept no page across the drop, so the slot has to be
   * cleared or the restoring declare would go out as a REBUILD of a page that no longer exists.
   * The driver clears its own `pageCreated` on teardown for exactly this reason.
   */
  onDisconnected(): void {
    this.pageSlot.reset();
  }

  /** Call when the link comes back. Identical to a pop-restore, by construction. */
  async onReconnected(): Promise<void> {
    await this.declareTop("reconnect");
  }

  /**
   * Drive a menu to completion: declare, await a selection, run its handler.
   *
   * Returns when the user backs out. Handlers may push further screens; `back` from a child
   * returns here with the parent already restored.
   */
  async menu<V>(
    opts: ListScreenOptions,
    onPick: (sel: Selection<V>) => Promise<void> | void
  ): Promise<void> {
    const screen = await this.push<V>(opts);
    try {
      for (;;) {
        const sel = await screen.nextSelection();
        if (!sel) return;             // back or eviction — a value, not an exception
        await onPick(sel);
        // A handler may have pushed and popped; make sure this screen is on-glass again.
        if (this.top === screen && screen.state !== "closed") {
          await this.declareTop("pop");
        }
      }
    } finally {
      // Unwind to AND INCLUDING this screen, not just the top.
      //
      // A handler that pushed without popping would otherwise leave this menu's screen BURIED:
      // never closed, so its inbound subscription is never released, and permanently suspended,
      // so it is deaf if anything ever surfaces it again. menu() returning means the menu is
      // finished, so nothing it opened should outlive it.
      const i = this.stack.indexOf(screen);
      if (i >= 0) {
        for (const dead of this.stack.splice(i)) dead.close();
        if (this.stack.length) await this.declareTop("pop");
      }
    }
  }

  closeAll(): void {
    while (this.stack.length) this.stack.pop()?.close();
  }
}

export type { Row, ScreenEvent, Selection };
