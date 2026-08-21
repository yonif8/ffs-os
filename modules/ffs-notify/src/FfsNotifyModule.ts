// Typed wrapper around the native FfsNotifyModule — the allowlist-only Android notification
// bridge that lets a REAL message reach the glasses' `messages` app.
//
// ⭐ THE ALLOWLIST IS THE DESIGN. `FfsNotificationListener.onNotificationPosted` tests the package
//    against the allowlist as its FIRST statement, before `sbn.notification` is touched, so a
//    banking alert or a 2FA code is dropped before it is read, encoded, counted or held. See
//    `android/.../FfsNotificationListener.kt`.
//
// ⛔ PRIVACY, restated where a JS author will actually read it:
//    • `getThreads()` is the ONLY call that returns message content, and it is a PULL. Nothing
//      about it is an event, because events fan out and `src/os/log.ts` subscribes to event
//      streams bound for an off-device collector.
//    • `getStats()` / the `onNotifyChange` payload are numbers ONLY. There is a test asserting
//      exactly that (`src/data/__tests__/notifications.test.ts`), so the first string field added
//      to them fails the suite.
//    • Never log, stringify, persist or snapshot a `NotifyThread`. Not "the first 20 characters
//      for debugging". `ffs_os` is PUBLIC.
//
// ANDROID ONLY. iOS gives an app no read access to other apps' notifications, so there is no twin
// and no stub pretending otherwise; `src/notifications/native.ts` degrades gracefully instead.

import { requireNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

/** One message inside a conversation. ⛔ CONTENT — see the header. */
export interface NotifyMessage {
  /** True when the WEARER sent it. MessagingStyle marks "me" by omitting the sender. */
  fromMe: boolean;
  /** Wall-clock ms when the message was sent (not when we saw it). */
  atMs: number;
  body: string;
}

/** One conversation. ⛔ CONTENT — see the header. */
export interface NotifyThread {
  pkg: string;
  name: string;
  unread: boolean;
  lastAtMs: number;
  /** OLDEST first — FFSM reading order, and the order `apps/messages.c` rolls through. */
  messages: NotifyMessage[];
}

/**
 * The loggable surface. EVERY FIELD IS A NUMBER, deliberately, and a test enforces it — the same
 * discipline `MicStats` established for audio (S-INPUT report §4).
 */
export interface NotifyStats {
  /** Bumps on every real change; the cheap "is there anything new" check. */
  revision: number;
  /** Allowlisted notifications that reached the parser. */
  posted: number;
  /** Notifications refused BEFORE they were read. The only trace a non-allowlisted one leaves. */
  dropped: number;
  /** Messages actually merged into the store. */
  messages: number;
  /** Re-posts that added nothing (messaging apps re-post constantly). */
  duplicates: number;
  /** Threads/messages pushed out by the bounds. */
  evicted: number;
  /** Allowlisted, read, but carried no usable text. */
  empty: number;
  threads: number;
  /** Total messages currently resident. */
  held: number;
  /** 1 while the OS has the listener service bound, else 0. */
  listenerUp: number;
  /** Wall-clock ms of the newest message held, or 0. */
  lastAtMs: number;
}

interface FfsNotifyNativeModule {
  /** Has the user granted the listener in Android settings? Only they can. */
  isListenerEnabled(): boolean;
  /** Granted AND currently bound. Android unbinds after an app update or force-stop. */
  isListenerConnected(): boolean;
  /** Open the OS settings page for the grant. There is no programmatic request, by design. */
  openListenerSettings(): void;
  /** Nudge Android to re-bind a granted-but-unbound service. */
  requestRebind(): boolean;

  getAllowlist(): string[];
  /** Replace the allowlist. Anything held for a package that just left is forgotten at once. */
  setAllowlist(pkgs: string[]): string[];
  getDefaultAllowlist(): string[];

  /** The kill switch. Off also clears everything held. */
  getCaptureEnabled(): boolean;
  setCaptureEnabled(on: boolean): boolean;

  /** Which of these packages actually exist on this phone (module manifest `<queries>`). */
  getInstalled(pkgs: string[]): string[];

  getStats(): NotifyStats;
  getRevision(): number;

  /** ⭐ The only content-bearing call. Pull, never an event. */
  getThreads(): NotifyThread[];

  /** Forget everything held in memory. */
  clear(): number;

  addListener(event: "onNotifyChange", listener: (payload: NotifyStats) => void): EventSubscription;
}

const FfsNotifyModule = requireNativeModule<FfsNotifyNativeModule>("FfsNotifyModule");

export default FfsNotifyModule;
export type { FfsNotifyNativeModule };
