package expo.modules.ffsnotify

import android.content.Context
import android.os.Build
import android.telephony.SmsManager

/**
 * SmsFallback — direct carrier SMS, the reply path of LAST resort.
 *
 * The primary act-back path is [ReplyRegistry] (the notification's own RemoteInput), which covers
 * RCS and every messenger without a SEND permission. This exists only for a plain SMS thread whose
 * notification exposes no inline reply, and it needs `SEND_SMS` — a permission this module
 * deliberately does NOT declare (that is Yoni's call to make). Without the grant, [send] catches the
 * SecurityException and returns false, so the data layer's fallback branch is real and testable but
 * inert until the permission is added.
 *
 * ⛔ NO LOGGING — `text` is content.
 */
object SmsFallback {

    fun send(ctx: Context, address: String, text: String): Boolean {
        if (address.isBlank() || text.isEmpty()) return false
        return try {
            val mgr = if (Build.VERSION.SDK_INT >= 31) {
                ctx.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            } ?: return false
            val parts = mgr.divideMessage(text)
            if (parts.size <= 1) {
                mgr.sendTextMessage(address, null, text, null, null)
            } else {
                mgr.sendMultipartTextMessage(address, null, parts, null, null)
            }
            true
        } catch (_: Throwable) {
            // SecurityException (no SEND_SMS), or a device with no telephony: a failed fallback.
            false
        }
    }
}
