// Notifications — the source that makes the glasses' `messages` app show a REAL conversation.
//
// ⭐ THE POINT OF THIS FILE IS HOW LITTLE IS IN IT. It is a `DataSource` like `weather` and
//    `headlines`: same 60 lines of shape, same `everyMs`, same "throw to report failure", and the
//    transport, the outbox, the frame, the loader route and the on-glass app change not at all.
//    That is the S-DATA design paying out — a notification feed is just another source, and the
//    thing that makes it different (an Android listener with an allowlist gate) is entirely on the
//    other side of `src/notifications/native.ts`.
//
// ⛔ PRIVACY — the rules this file lives under:
//    • `read()` returns message bodies. They go into `encodeFfsm` and out of scope. They are never
//      logged, never stored in React state, never put in an Error message, never JSON.stringified.
//    • Everything this module reports about itself is a number or a package name.
//    • Fixtures in this repo are INVENTED, always. `ffs_os` is PUBLIC — the same rule that keeps
//      rig photos out of it keeps real messages out of it.
//
// ── WHAT HAPPENS WHEN THINGS GO WRONG (inherited from pump.ts / outbox.ts, not reinvented) ─────
//   a burst of 20 messages    the native store MERGES (it is keyed on timestamp + body, because
//                             messaging apps re-post the whole recent history on every new
//                             message) and is bounded at 8 threads x 12 messages. The outbox is
//                             latest-wins with no queue, so 20 arrivals inside one poll interval
//                             become ONE push carrying the newest state — never 20 pushes and
//                             never a backlog that replays stale screens after a reconnect.
//   the link drops            the value is held, not queued; it goes out on the first tick after
//                             the link returns, and it is the CURRENT inbox, not the one from
//                             four minutes ago.
//   the glasses are asleep    the value still lands (BLE rx is independent of the panel) and is
//                             in the mailbox when the HUD next paints. A push does not WAKE the
//                             display; conflating the two is how "the push did nothing" gets
//                             diagnosed wrong.
//   the app is not running    not a problem: the channel is addressed to an app_id, not to a
//                             running app. The inbox is there the moment `messages` is launched.
//   nothing has arrived yet   this source THROWS. `encodeFfsm` refuses an empty inbox ("an empty
//                             inbox is not a screen") and so do we — pushing an empty blob would
//                             replace whatever the glasses hold with nothing.

import { encodeFfsm, type FfsmThread } from "../../sdk/ffsm";
import type { NotifyThread } from "../../notifications/native";
import type { DataSource } from "../types";

export interface NotificationsOptions {
  /**
   * Injected so every branch below runs on a PC with no phone and no native module.
   * In the app this is `readThreads` from `src/notifications/native.ts`.
   */
  read: () => NotifyThread[];
  /** Which on-glass app renders it. 3 = `messages`, the FFSM reader. */
  appId?: number;
  /** See `quantiseAgeMin` — one minute is the right cadence, and it is self-limiting. */
  everyMs?: number;
  /** Guard: skip entirely when the listener is not granted, so the panel's state is the truth. */
  enabled?: () => boolean;
}

/**
 * ★ QUANTISE THE AGE TO WHAT THE GLASSES ACTUALLY DRAW.
 *
 * `apps/messages.c ms_age()` renders whole minutes below an hour, whole hours below a day, then
 * whole days. `ageMin` is baked into the blob at push time and the glasses never advance it (a
 * clock they cannot verify is a number that quietly goes wrong — `ffsm.ts`), so the phone has to
 * re-push to keep an age honest.
 *
 * Rounding to the displayed bucket makes that cost exactly right: the blob is BYTE-IDENTICAL
 * until the text on the HUD would change, so the pump's `unchanged` check suppresses every push
 * that would show the same screen. A fresh message costs one small push a minute for its first
 * hour and then roughly one an hour — instead of one per poll forever.
 */
export function quantiseAgeMin(min: number): number {
  const m = Math.max(0, Math.floor(min));
  if (m < 60) return m;
  if (m < 1440) return Math.floor(m / 60) * 60;
  return Math.floor(m / 1440) * 1440;
}

/**
 * Map the native store's shape onto FFSM's.
 *
 * ★ ORDER IS LOAD-BEARING AND IT IS NOT COSMETIC. FFSM lists threads NEWEST-ACTIVITY FIRST (the
 *   order the inbox draws them) and messages OLDEST FIRST inside a thread (reading order, and the
 *   order `apps/messages.c` rolls through, opening at the newest). Getting either backwards
 *   renders perfectly and shows the wrong thing — the only kind of bug that survives a camera
 *   check.
 *
 * Threads with no messages are dropped rather than encoded: `ms_valid()` on the glasses REFUSES a
 * whole blob containing one, which would look like "the app won't launch".
 *
 * Throws when there is nothing to show. ⛔ The message says how many, never what.
 */
export function threadsToFfsm(threads: NotifyThread[], now: number): FfsmThread[] {
  const usable = threads.filter((t) => t && Array.isArray(t.messages) && t.messages.length > 0);
  if (usable.length === 0) throw new Error("notifications: nothing held yet");

  return usable
    .slice()
    .sort((a, b) => (b.lastAtMs ?? 0) - (a.lastAtMs ?? 0))
    .map((t) => ({
      name: t.name || t.pkg,
      unread: !!t.unread,
      messages: t.messages
        .slice()
        .sort((a, b) => a.atMs - b.atMs)
        .map((m) => ({
          fromMe: !!m.fromMe,
          ageMin: quantiseAgeMin((now - m.atMs) / 60000),
          body: m.body,
        })),
    }));
}

/**
 * The source. `fetch` is the ONLY place message bodies exist in this process outside the native
 * store, and they exist for the length of one `encodeFfsm` call.
 */
export function notificationsSource(opts: NotificationsOptions): DataSource {
  const { read } = opts;
  const enabled = opts.enabled;
  return {
    // Stable, short, log-safe — it appears in telemetry.
    id: "notifications",
    appId: opts.appId ?? 3,
    everyMs: opts.everyMs ?? 60_000,
    async fetch(now: number): Promise<Uint8Array> {
      if (enabled && !enabled()) throw new Error("notifications: listener not enabled");
      return encodeFfsm(threadsToFfsm(read(), now));
    },
  };
}
