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

import { ListScreen, newStats, type Transport, type ListScreenOptions } from "./screen";
import type { Row, ScreenEvent, Selection, SessionStats } from "./types";

export type RestoreCause = "pop" | "reconnect" | "eviction-return";

export interface SessionOptions {
  transport: Transport;
  /** Magic/nonce source. Injected so tests are deterministic — the SDK never calls Math.random. */
  magic?: () => number;
  onRestore?: (cause: RestoreCause, depth: number) => void;
}

export class Session {
  readonly stats: SessionStats = newStats();
  private readonly stack: ListScreen<any>[] = [];
  private readonly tx: Transport;
  private readonly magic: () => number;
  private readonly onRestore?: (cause: RestoreCause, depth: number) => void;
  private magicCounter = 100;

  constructor(opts: SessionOptions) {
    this.tx = opts.transport;
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

  /** Push a new list screen and declare it. */
  async push<V = string>(opts: ListScreenOptions): Promise<ListScreen<V>> {
    const s = new ListScreen<V>(this.tx, this.stats, opts, this.magic);
    this.stack.push(s);
    await s.declare();
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
    t.forceRedeclare();
    await t.declare("restore");
    if (cause === "pop") this.stats.restores.pop += 1;
    else this.stats.restores.reconnect += 1;
    this.onRestore?.(cause, this.stack.length);
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
      if (this.top === screen) {
        this.stack.pop();
        screen.close();
        if (this.stack.length) await this.declareTop("pop");
      }
    }
  }

  closeAll(): void {
    while (this.stack.length) this.stack.pop()?.close();
  }
}

export type { Row, ScreenEvent, Selection };
