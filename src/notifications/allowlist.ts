// THE ALLOWLIST — the catalogue Yoni edits, and the defaults the native gate starts from.
//
// ⭐ This is the design, not a filter bolted on. The Android listener sees every notification on
//    the phone and tests the package against this list as the FIRST thing it does, before it
//    touches the notification at all (`modules/ffs-notify/android/.../FfsNotificationListener.kt`).
//    A banking alert or a 2FA code is dropped before it is read, encoded, counted or held in
//    memory — so no bug in the parsing code can mishandle what it never received.
//
// ⚠️ DEFAULT_ALLOW MUST MATCH `Rules.DEFAULT_ALLOW` in Allowlist.kt. `notifications.test.ts` reads
//    that Kotlin file and fails if the two drift: a settings screen that shows a different list
//    from the one the gate uses is a privacy claim that is quietly false.
//
// Editing: `src/notifications/NotificationsPanel.tsx` renders every entry below as a toggle,
// marks which are actually installed on this phone, and lets an arbitrary package be typed in.
// Nothing here is buried in a constant that only a rebuild can change — a change takes effect on
// the next notification, and anything already held for a package that was just switched off is
// forgotten immediately.

export interface MessagingApp {
  pkg: string;
  label: string;
  /** One line for the settings row — why this is here, or what to expect from it. */
  note?: string;
}

/**
 * The catalogue offered in the settings screen. Messaging apps ONLY — this list is also mirrored
 * in the module manifest's `<queries>` block, which is what lets `getInstalled()` answer whether
 * an app is really on the phone without asking for QUERY_ALL_PACKAGES.
 *
 * ⛔ Nothing that is not a person-to-person messenger belongs here. Not email, not a bank, not an
 *    authenticator, not a delivery tracker. If a future app wants a notification feed, it gets its
 *    own source and its own decision — not a widened messages allowlist.
 */
export const KNOWN_MESSAGING: MessagingApp[] = [
  { pkg: "com.google.android.apps.messaging", label: "Google Messages", note: "SMS / RCS — installed on the test phone" },
  { pkg: "com.samsung.android.messaging", label: "Samsung Messages", note: "SMS / RCS" },
  { pkg: "com.android.messaging", label: "AOSP Messaging", note: "SMS" },
  { pkg: "org.thoughtcrime.securesms", label: "Signal" },
  { pkg: "com.whatsapp", label: "WhatsApp" },
  { pkg: "com.whatsapp.w4b", label: "WhatsApp Business" },
  { pkg: "org.telegram.messenger", label: "Telegram" },
  { pkg: "org.telegram.messenger.web", label: "Telegram (web build)" },
  { pkg: "com.facebook.orca", label: "Messenger" },
  { pkg: "com.instagram.android", label: "Instagram DMs", note: "also posts non-message notifications" },
  { pkg: "com.google.android.apps.dynamite", label: "Google Chat" },
  { pkg: "com.discord", label: "Discord", note: "chatty — expect bursts" },
  { pkg: "com.Slack", label: "Slack" },
  { pkg: "com.microsoft.teams", label: "Microsoft Teams" },
];

/**
 * What the gate uses until Yoni changes it. The six that are unambiguously person-to-person and
 * unambiguously worth a glance; the rest of the catalogue is one tap away in the panel.
 */
export const DEFAULT_ALLOW: string[] = [
  "com.google.android.apps.messaging",
  "com.samsung.android.messaging",
  "com.android.messaging",
  "org.thoughtcrime.securesms",
  "com.whatsapp",
  "org.telegram.messenger",
];

export function isKnownMessaging(pkg: string): boolean {
  return KNOWN_MESSAGING.some((a) => a.pkg === pkg);
}

export function labelFor(pkg: string): string {
  return KNOWN_MESSAGING.find((a) => a.pkg === pkg)?.label ?? pkg;
}

/**
 * A weak, deliberately non-blocking smell test for a package someone types in by hand. It only
 * drives a warning in the UI — it is NOT a security control and must never be treated as one. The
 * control is the allowlist itself; this is a nudge for the moment a finger slips.
 */
const SENSITIVE_HINTS = [
  "bank", "pay", "wallet", "auth", "otp", "token", "2fa", "crypto", "coinbase",
  "gmail", "mail", "outlook", "health", "medic", "insur", "vault", "password",
];

/**
 * The ones whose package name gives nothing away. Gmail is `com.google.android.gm` — no substring
 * in it says "mail", and an inbox is exactly the thing this feature must not become.
 */
const SENSITIVE_EXACT = new Set([
  "com.google.android.gm",              // Gmail
  "com.google.android.apps.authenticator2",
  "com.azure.authenticator",
  "com.google.android.gms",             // Play services — 2FA prompts arrive here
  "com.android.vending",
  "com.google.android.apps.walletnfcrel",
]);

export function looksSensitive(pkg: string): boolean {
  if (isKnownMessaging(pkg)) return false;
  const p = pkg.toLowerCase();
  return SENSITIVE_EXACT.has(pkg) || SENSITIVE_HINTS.some((h) => p.includes(h));
}

/** Normalise a hand-typed entry the same way the native side does (trim, drop blanks, dedupe). */
export function normaliseAllowlist(pkgs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of pkgs) {
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
