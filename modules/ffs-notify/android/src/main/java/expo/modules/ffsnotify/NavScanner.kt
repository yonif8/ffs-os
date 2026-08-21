package expo.modules.ffsnotify

import android.app.Notification
import android.os.Bundle
import android.service.notification.StatusBarNotification

/**
 * NavScanner — reads the live turn-by-turn out of a maps app's ONGOING notification.
 *
 * ── PROVENANCE (technique RE-DERIVED, not copied) ────────────────────────────────────────────
 * The idea that a maps app publishes its navigation as an ongoing notification you can read
 * turn-by-turn from (rather than any routing API) was observed in **appsbridge**
 * (homeauto.cc/appsbridge), which is **UNLICENSED / all rights reserved**. No code from it is
 * used: this scanner and the package set are our own, and all PARSING is done independently in
 * `src/data/sources/navigation.ts`. This file only surfaces the raw title/text so that parser can
 * run and be tested off-device.
 *
 * Uses the live `FfsNotificationListener` (same grant) to enumerate active notifications and picks
 * the first belonging to a nav package. Re-scan-on-demand (~2 s from the source) beats trusting the
 * posted callback, because maps updates its notification in place.
 *
 * ⛔ NO LOGGING. A destination/street name is content.
 */
object NavScanner {

    /** The maps apps whose ongoing notification we read. Mirror of NAV_PACKAGES in navigation.ts. */
    private val NAV_PACKAGES = setOf(
        "com.google.android.apps.maps",
        "com.waze",
        "net.osmand",
        "net.osmand.plus",
        "com.sygic.aura"
    )

    fun isNavPackage(pkg: String?): Boolean = pkg != null && NAV_PACKAGES.contains(pkg)

    /**
     * The current ongoing nav notification's raw fields, or null when none is active. Only nav
     * packages are ever inspected; no other app's notification text is read here.
     */
    fun scan(): Map<String, Any?>? {
        val listener = FfsNotificationListener.instance() ?: return null
        val active: Array<StatusBarNotification> = try {
            listener.activeNotifications ?: return null
        } catch (_: Throwable) {
            return null
        }

        for (sbn in active) {
            val pkg = sbn.packageName
            if (!isNavPackage(pkg)) continue
            val n = sbn.notification ?: continue
            // A maps app's turn-by-turn is an ongoing notification; a non-ongoing one is a promo
            // or a "resume?" chip, not live guidance.
            if (n.flags and Notification.FLAG_ONGOING_EVENT == 0) continue
            val extras: Bundle = n.extras ?: continue

            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim() ?: ""
            val sub = (extras.getCharSequence(Notification.EXTRA_SUB_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT))?.toString()?.trim() ?: ""

            if (title.isEmpty() && text.isEmpty() && sub.isEmpty()) continue

            return mapOf(
                "pkg" to pkg,
                "title" to title,
                "text" to text,
                "sub" to sub
            )
        }
        return null
    }
}
