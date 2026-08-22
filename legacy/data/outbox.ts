// The outbox — ONE slot per app, latest wins, never a queue.
//
// ★ THE DECISION, because it is the one worth arguing about. The BLE link drops (it dropped
//   twice on 2026-08-20). The obvious reflex is to queue what could not be sent and flush it
//   on reconnect. That is wrong for this wire, and not because of memory:
//
//   A channel value is a STATE, not an EVENT. It is "the inbox as it is now", "the
//   temperature as it is now". When the link comes back after four minutes, delivering the
//   four-minute-old value and then the current one is strictly worse than delivering the
//   current one — the glasses would render a stale screen, then flicker to the real one, and
//   the wearer would have read the wrong thing in between. The newest value is the only
//   correct one, so a superseded value is DROPPED, deliberately, and the drop is LOGGED.
//
//   (An event stream — "a message arrived", "a notification fired" — would need the opposite
//   policy. If one is ever added, it gets its own structure, not a flag on this one. Making
//   this queue-capable "just in case" is how a bounded thing stops being bounded.)
//
// The other half of the same decision: the phone owns the retry, because the phone is the
// one with the RAM. The glasses hold one value per app and nothing else.

import type { Pending } from "./types";

export class Outbox {
  private readonly slots = new Map<number, Pending>();
  private readonly seqOf = new Map<number, number>();

  /**
   * Offer a value for an app. Returns the entry now pending, and whether it displaced one.
   * A displaced value is gone — that is the policy, see the header.
   */
  offer(appId: number, sourceId: string, blob: Uint8Array, now: number): { entry: Pending; superseded: Pending | null } {
    const superseded = this.slots.get(appId) ?? null;
    const seq = ((this.seqOf.get(appId) ?? 0) + 1) & 0xffff;
    this.seqOf.set(appId, seq);
    const entry: Pending = { appId, sourceId, blob, seq, offeredAt: now, attempts: 0 };
    this.slots.set(appId, entry);
    return { entry, superseded };
  }

  /** Everything waiting, oldest offer first — so a value that has been stuck goes out first. */
  pending(): Pending[] {
    return [...this.slots.values()].sort((a, b) => a.offeredAt - b.offeredAt);
  }

  get size(): number {
    return this.slots.size;
  }

  /**
   * A send succeeded. Removes the entry ONLY if it is still the one that was sent — a newer
   * value offered while the send was in flight must not be thrown away by its predecessor's
   * acknowledgement.
   */
  settle(appId: number, seq: number): boolean {
    const cur = this.slots.get(appId);
    if (!cur || cur.seq !== seq) return false;
    this.slots.delete(appId);
    return true;
  }

  /** A send failed. Keep the value (it is still the current one) and count the attempt. */
  retry(appId: number, seq: number): number {
    const cur = this.slots.get(appId);
    if (!cur || cur.seq !== seq) return 0;
    cur.attempts += 1;
    return cur.attempts;
  }

  /** Peek at the seq an app is on, so a caller can talk about "the value we last sent". */
  lastSeq(appId: number): number {
    return this.seqOf.get(appId) ?? 0;
  }

  clear(): void {
    this.slots.clear();
  }
}
