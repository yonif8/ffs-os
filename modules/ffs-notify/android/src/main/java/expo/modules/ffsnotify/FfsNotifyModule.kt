package expo.modules.ffsnotify

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * FfsNotifyModule — the JS surface of the allowlist-only notification bridge.
 *
 * ANDROID ONLY, and `expo-module.config.json` says so: there is no iOS twin and there cannot be
 * one (iOS gives an app no read access to other apps' notifications at all). That is why this is a
 * SEPARATE module from `ffs-ble` rather than another handful of bindings on it —
 * `scripts/check-native-parity.py` enforces that ffs-ble's Swift and Kotlin surfaces match name for
 * name, and an Android-only capability bolted onto it would either break that guard or need a
 * permanent iOS stub lying about what it does. `src/notifications/native.ts` carries the graceful
 * "not on this platform" fallback instead.
 *
 * ── THE SHAPE OF THE API IS THE PRIVACY DESIGN ────────────────────────────────────────────────
 *   [getStats]     numbers only — safe to log, safe to ship to the telemetry collector
 *   [getThreads]   ⭐ THE ONLY CALL THAT RETURNS CONTENT, and it is a PULL. There is no event
 *                  carrying bodies, because events fan out to every listener and `src/os/log.ts`
 *                  subscribes to event streams; a pull goes to exactly one caller that asked.
 *   onNotifyChange metadata only: a revision counter and the same numeric stats, so the phone can
 *                  push promptly instead of waiting for the next poll.
 */
class FfsNotifyModule : Module() {

    companion object {
        private var live: WeakReference<FfsNotifyModule>? = null

        /**
         * Wake the JS side. ⛔ METADATA ONLY — if a body ever ends up in this payload it lands in
         * the off-device log pipe. `notifications.test.ts` has the assertion that catches it on
         * the TypeScript side; this comment is the one that has to catch it here.
         */
        fun emitChange() {
            val m = live?.get() ?: return
            try {
                m.sendEvent("onNotifyChange", NotifyStore.stats())
            } catch (_: Throwable) {
                // The JS runtime may be gone (the listener outlives the UI). A dropped event is a
                // late repaint, never a lost message: the store already holds it and the next
                // poll picks it up.
            }
        }
    }

    private val ctx: Context
        get() = requireNotNull(appContext.reactContext) { "no react context" }

    private fun component(c: Context) = ComponentName(c, FfsNotificationListener::class.java)

    override fun definition() = ModuleDefinition {
        Name("FfsNotifyModule")

        Events("onNotifyChange")

        OnCreate { live = WeakReference(this@FfsNotifyModule) }
        OnDestroy { live = null }

        /** Is the OS-level grant in place? Only the user can give it, in Settings, by hand. */
        Function("isListenerEnabled") {
            val c = ctx
            val flat = Settings.Secure.getString(c.contentResolver, "enabled_notification_listeners") ?: ""
            flat.split(':').any { entry ->
                ComponentName.unflattenFromString(entry)?.packageName == c.packageName
            }
        }

        /** Is the service actually bound right now (granted, but Android may have unbound it)? */
        Function("isListenerConnected") { (NotifyStore.stats()["listenerUp"] as Long) == 1L }

        /**
         * Open the OS settings page for the grant. There is no programmatic request for this
         * permission and there should not be — it is a big one and it is Yoni's to give.
         */
        Function("openListenerSettings") {
            val c = ctx
            val detail = Intent("android.settings.NOTIFICATION_LISTENER_DETAIL_SETTINGS")
                .putExtra(
                    "android.provider.extra.NOTIFICATION_LISTENER_COMPONENT_NAME",
                    component(c).flattenToString()
                )
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val fallback = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                if (Build.VERSION.SDK_INT >= 30) c.startActivity(detail) else c.startActivity(fallback)
            } catch (_: Throwable) {
                c.startActivity(fallback)
            }
        }

        /** Granted but not bound happens after an update or a force-stop. This is the nudge. */
        Function("requestRebind") {
            try {
                NotificationListenerService.requestRebind(component(ctx)); true
            } catch (_: Throwable) {
                false
            }
        }

        // ── the allowlist ──────────────────────────────────────────────────────────────────
        Function("getAllowlist") { Allowlist.get(ctx) }
        Function("setAllowlist") { pkgs: List<String> -> Allowlist.set(ctx, pkgs); Allowlist.get(ctx) }
        Function("getDefaultAllowlist") { Rules.DEFAULT_ALLOW }

        Function("getCaptureEnabled") { Allowlist.captureEnabled(ctx) }
        Function("setCaptureEnabled") { on: Boolean -> Allowlist.setCaptureEnabled(ctx, on); on }

        /**
         * Which of these packages actually exist on this phone, so the settings screen shows
         * reality instead of a wish-list. The `<queries>` block in the module manifest is what
         * makes this answerable on API 30+ without QUERY_ALL_PACKAGES.
         */
        Function("getInstalled") { pkgs: List<String> ->
            val pm = ctx.packageManager
            pkgs.filter { p ->
                try {
                    pm.getPackageInfo(p, 0); true
                } catch (_: Throwable) {
                    false
                }
            }
        }

        // ── the data ───────────────────────────────────────────────────────────────────────
        Function("getStats") { NotifyStore.stats() }
        Function("getRevision") { NotifyStore.revision() }

        /** ⭐ The one content-bearing call. See the class header. */
        Function("getThreads") { NotifyStore.snapshot() }

        /** Forget everything held in memory. Instant, and it is what the panel's button calls. */
        Function("clear") { NotifyStore.clear(); NotifyStore.revision() }
    }
}
