package expo.modules.ffsnotify

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Bundle

/**
 * ReplyRegistry — the ACT-BACK path. Replies to a messaging notification by firing its OWN
 * `RemoteInput` reply action, so the reply leaves over the source app's transport — WhatsApp as
 * WhatsApp, an RCS thread as RCS — with no messenger reimplemented and no SEND permission held.
 * GOAL Plane 2, condition 8.
 *
 * ── PROVENANCE ────────────────────────────────────────────────────────────────────────────────
 * The RemoteInput reply-back technique was observed in **appsbridge** (UNLICENSED); no code is
 * taken. This is a clean-room implementation against the framework `RemoteInput` / `PendingIntent`
 * APIs directly.
 *
 * ── WHAT IT HOLDS ─────────────────────────────────────────────────────────────────────────────
 * For each allowlisted messaging thread that exposes a reply action, the listener registers the
 * action's `PendingIntent` + `RemoteInput`s here, keyed by the SAME "$pkg|$key" identity
 * `NotifyStore` uses. ⛔ It holds NO message text — only the plumbing to answer. A reply's text
 * arrives at [reply] and is written straight into the RemoteInput bundle; it is never stored,
 * never logged.
 *
 * Bounded so a chatty phone cannot grow it without limit; a stale PendingIntent simply fails to
 * send (→ false) and is harmless.
 */
object ReplyRegistry {

    private const val MAX = 32

    private class Entry(
        val key: String,
        val pkg: String,
        val pending: PendingIntent,
        val allInputs: Array<RemoteInput>,
        val resultKey: String
    )

    private val lock = Any()
    private val entries = LinkedHashMap<String, Entry>()

    /**
     * Record a thread's reply action, if it has one. Called by the listener AFTER the allowlist
     * gate, so only messaging notifications the wearer allowlisted are ever replyable. Returns true
     * when a usable RemoteInput reply action was found and stored.
     */
    fun remember(key: String, pkg: String, n: Notification): Boolean {
        val actions = n.actions ?: return false
        for (a in actions) {
            val remoteInputs = a.remoteInputs ?: continue
            val textInput = remoteInputs.firstOrNull { it.allowFreeFormInput } ?: continue
            val pending = a.actionIntent ?: continue
            synchronized(lock) {
                entries.remove(key)
                entries[key] = Entry(key, pkg, pending, remoteInputs, textInput.resultKey)
                while (entries.size > MAX) {
                    val oldest = entries.keys.firstOrNull() ?: break
                    entries.remove(oldest)
                }
            }
            return true
        }
        return false
    }

    /** Which held threads can be replied to via RemoteInput. Keys only — the caller matches by pkg. */
    fun replyable(): List<Map<String, Any?>> = synchronized(lock) {
        entries.values.map { mapOf("key" to it.key, "pkg" to it.pkg, "canRemoteInput" to true) }
    }

    fun canReply(key: String): Boolean = synchronized(lock) { entries.containsKey(key) }

    /**
     * Fire the reply. Writes `text` into the action's RemoteInput bundle and sends its
     * PendingIntent — the source app receives it as a normal inline reply. Returns true if the
     * intent was sent. ⛔ `text` is content: written to the bundle, never retained or logged.
     */
    fun reply(ctx: Context, key: String, text: String): Boolean {
        val e = synchronized(lock) { entries[key] } ?: return false
        return try {
            val fill = Intent()
            val results = Bundle().apply { putCharSequence(e.resultKey, text) }
            RemoteInput.addResultsToIntent(e.allInputs, fill, results)
            // Best-effort hint that this is a reply source action (some apps read it).
            RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT)
            e.pending.send(ctx, 0, fill)
            true
        } catch (_: Throwable) {
            // A canceled/expired PendingIntent, or the app tearing down: a failed reply, not a crash.
            false
        }
    }
}
