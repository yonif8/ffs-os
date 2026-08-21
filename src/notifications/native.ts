// The safe edge of the native notification bridge.
//
// Everything in `src/` imports THIS, never `modules/ffs-notify` directly, so that a platform
// without the module (iOS, web, a Jest/bun run with no native runtime) degrades to "not
// available" instead of throwing at import time. `requireNativeModule` throws when the module is
// absent, and an import-time throw in a React tree is a white screen, not an error message.
//
// ⛔ PRIVACY: `readThreads()` is the only function here that returns content. Its result goes to
//    exactly one place — the FFSM encoder in `src/data/sources/notifications.ts` — and from there
//    into bytes on the BLE wire. It is never logged, stringified, persisted or put in React
//    state. Everything else in this file is numbers and package names.

import { Platform } from "react-native";

import type { FfsNotifyNativeModule, NotifyStats, NotifyThread } from "../../modules/ffs-notify";
import { DEFAULT_ALLOW } from "./allowlist";

let native: FfsNotifyNativeModule | null = null;
try {
  if (Platform.OS === "android") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    native = require("../../modules/ffs-notify").default as FfsNotifyNativeModule;
  }
} catch {
  native = null;
}

export const EMPTY_STATS: NotifyStats = {
  revision: 0,
  posted: 0,
  dropped: 0,
  messages: 0,
  duplicates: 0,
  evicted: 0,
  empty: 0,
  threads: 0,
  held: 0,
  listenerUp: 0,
  lastAtMs: 0,
};

/** Is the native bridge present at all (Android build with the module linked)? */
export function notifyAvailable(): boolean {
  return native !== null;
}

/** Has the user granted the listener in Android settings? Only they can. */
export function listenerEnabled(): boolean {
  try {
    return native?.isListenerEnabled() ?? false;
  } catch {
    return false;
  }
}

/** Granted AND bound. Android unbinds after an app update or a force-stop. */
export function listenerConnected(): boolean {
  try {
    return native?.isListenerConnected() ?? false;
  } catch {
    return false;
  }
}

export function openListenerSettings(): void {
  try {
    native?.openListenerSettings();
  } catch {
    /* the settings intent is best-effort; the panel already tells the user where to go */
  }
}

export function requestRebind(): boolean {
  try {
    return native?.requestRebind() ?? false;
  } catch {
    return false;
  }
}

export function getAllowlist(): string[] {
  try {
    return native?.getAllowlist() ?? DEFAULT_ALLOW;
  } catch {
    return DEFAULT_ALLOW;
  }
}

export function setAllowlist(pkgs: string[]): string[] {
  try {
    return native?.setAllowlist(pkgs) ?? pkgs;
  } catch {
    return pkgs;
  }
}

export function getCaptureEnabled(): boolean {
  try {
    return native?.getCaptureEnabled() ?? false;
  } catch {
    return false;
  }
}

export function setCaptureEnabled(on: boolean): boolean {
  try {
    return native?.setCaptureEnabled(on) ?? false;
  } catch {
    return false;
  }
}

/** Which of the catalogue's packages actually exist on this phone. */
export function getInstalled(pkgs: string[]): string[] {
  try {
    return native?.getInstalled(pkgs) ?? [];
  } catch {
    return [];
  }
}

/** Numbers only — safe to render, safe to log, safe to ship to the collector. */
export function getStats(): NotifyStats {
  try {
    return native?.getStats() ?? EMPTY_STATS;
  } catch {
    return EMPTY_STATS;
  }
}

/**
 * ⭐ THE ONE CONTENT-BEARING CALL. A pull, not an event, so the bodies go to the caller that
 * asked and to nobody else. Feed the result straight into `encodeFfsm` and let it go out of scope.
 */
export function readThreads(): NotifyThread[] {
  try {
    return native?.getThreads() ?? [];
  } catch {
    return [];
  }
}

export function clearHeld(): void {
  try {
    native?.clear();
  } catch {
    /* nothing held is a fine outcome for "forget everything" */
  }
}

/**
 * Subscribe to the metadata-only change signal, so a message that arrives can be pushed to the
 * glasses in about a second instead of waiting out the poll interval. Returns an unsubscribe.
 */
export function onNotifyChange(fn: (stats: NotifyStats) => void): () => void {
  if (!native) return () => {};
  try {
    const sub = native.addListener("onNotifyChange", fn);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export type { NotifyStats, NotifyThread };
