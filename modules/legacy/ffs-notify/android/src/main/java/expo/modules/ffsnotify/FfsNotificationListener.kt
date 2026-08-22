package expo.modules.ffsnotify

import android.app.Notification
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.lang.ref.WeakReference

/**
 * THE LISTENER. It is handed every notification on the phone and keeps almost none of them.
 *
 * ★ READ [onNotificationPosted] TOP TO BOTTOM AND THE PRIVACY DESIGN IS THE CONTROL FLOW.
 *   The allowlist test is the first statement after the package name is read; `sbn.notification`
 *   is not touched until it passes. A 2FA code, a bank alert, a calendar reminder, an email — the
 *   service is told about all of them and returns without reading any of them. That is a
 *   structural claim, not a promise: there is no code path in this file that reaches
 *   `notification.extras` from a package that is not on the list.
 *
 * ⛔ There is not one Log call in this file, and there must never be one that names a package, a
 *    sender or a body. Our own tooling greps logcat continuously and `src/os/log.ts` ships records
 *    off-device; a debug line here is a message on a PC in another room. Everything diagnosable is
 *    a counter in [NotifyStore.stats].
 */
class FfsNotificationListener : NotificationListenerService() {

    companion object {
        // The live listener, so NavScanner can enumerate active notifications through the same
        // grant. A WeakReference: the service is owned by the OS, not by us, and outlives the UI.
        private var live: WeakReference<FfsNotificationListener>? = null

        /** The bound listener instance, or null when the service is not currently connected. */
        fun instance(): FfsNotificationListener? = live?.get()
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        live = WeakReference(this)
        NotifyStore.noteListener(true)
        FfsNotifyModule.emitChange()
        // ⚠️ Deliberately NOT replaying getActiveNotifications() here. A fresh grant would
        // otherwise pull in every banner currently on the phone — including allowlisted threads
        // the wearer has already read on the handset — and the glasses would light up with old
        // news the first time the service binds. The wire carries what arrives from now on.
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        live = null
        NotifyStore.noteListener(false)
        FfsNotifyModule.emitChange()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val pkg = sbn?.packageName ?: return

        // ── THE GATE. Nothing below this line runs for a package that is not on the list. ──
        val ctx = applicationContext
        if (!Allowlist.captureEnabled(ctx) || !Rules.allows(Allowlist.get(ctx), pkg)) {
            NotifyStore.noteDropped()
            return
        }

        val n = sbn.notification
        if (n == null) {
            NotifyStore.noteDropped()
            return
        }
        // Structural drops, still before any text is read. A group summary is a FLATTENED copy of
        // messages we are already reading properly, and an ongoing/foreground notification is a
        // "call in progress" or "syncing" chip, not a conversation.
        val flags = n.flags
        if (flags and Notification.FLAG_GROUP_SUMMARY != 0 ||
            flags and Notification.FLAG_ONGOING_EVENT != 0
        ) {
            NotifyStore.noteDropped()
            return
        }

        val extras: Bundle = n.extras ?: run { NotifyStore.noteEmpty(); return }
        val salt = Allowlist.salt(ctx)

        val convoTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val name = (convoTitle ?: title ?: pkg).trim()
        val key = sbn.tag ?: title ?: sbn.id.toString()

        val msgs = readMessagingStyle(extras, salt) ?: readFlatFallback(extras, sbn.postTime, salt)
        if (msgs.isEmpty()) {
            NotifyStore.noteEmpty()
            return
        }

        // ACT-BACK: remember this thread's own inline-reply action (RemoteInput), keyed exactly as
        // NotifyStore keys the conversation, so a reply from the glasses lands on the shown thread
        // and leaves over the source app's transport. Only reached for an allowlisted messaging
        // notification — the gate above is still the first thing that runs. No content is stored.
        ReplyRegistry.remember("$pkg|$key", pkg, n)

        if (NotifyStore.ingest(pkg, key, name, unread = true, incoming = msgs)) {
            FfsNotifyModule.emitChange()
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        val pkg = sbn?.packageName ?: return
        val ctx = applicationContext
        if (!Rules.allows(Allowlist.get(ctx), pkg)) return
        // Dismissed on the handset = read. Keep the text (the wearer may still want to look) but
        // stop shouting about it, so the on-glass unread pip tells the truth.
        val title = sbn.notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        NotifyStore.markRead(pkg, sbn.tag ?: title ?: sbn.id.toString())
        FfsNotifyModule.emitChange()
    }

    /**
     * MessagingStyle — the good path, and the only one that gives real per-message senders,
     * timestamps and DIRECTION. `EXTRA_MESSAGES` is an array of Bundles written by
     * `Notification.MessagingStyle.Message.toBundle()`; the keys below are that method's, read
     * directly rather than through androidx so this module carries no dependency.
     *
     * ★ A message whose sender is absent is the WEARER'S OWN — that is how MessagingStyle marks
     *   "me", and it is the only reason a sent/received distinction is available at all. Getting
     *   it backwards renders perfectly and shows every reply on the wrong side of the screen.
     *
     * Returns null (not empty) when this is not a MessagingStyle notification, so the caller can
     * tell "no messages" apart from "different shape entirely".
     */
    @Suppress("DEPRECATION") // the typed getParcelable* overloads are API 33+; minSdk here is 24
    private fun readMessagingStyle(extras: Bundle, salt: ByteArray): List<NotifyStore.Msg>? {
        val arr: Array<Parcelable>? = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (arr == null || arr.isEmpty()) return null
        val out = ArrayList<NotifyStore.Msg>(arr.size)
        for (p in arr) {
            val b = p as? Bundle ?: continue
            val text = b.getCharSequence("text")?.toString()?.trim()
            if (text.isNullOrEmpty()) continue
            val time = b.getLong("time", 0L)
            // ⚠️ `sender_person` is API 28+. Referencing android.app.Person unguarded would load
            //    the class on a 24..27 device the first time this line runs — a crash inside a
            //    system-bound service, which is about the worst place to find out.
            val sender = b.getCharSequence("sender")?.toString()
                ?: if (Build.VERSION.SDK_INT >= 28) {
                    (b.getParcelable<Parcelable>("sender_person") as? android.app.Person)?.name?.toString()
                } else null
            out.add(
                NotifyStore.Msg(
                    fromMe = sender.isNullOrEmpty(),
                    atMs = if (time > 0L) time else System.currentTimeMillis(),
                    body = text,
                    senderHash = Rules.senderHash(salt, sender)
                )
            )
        }
        return out
    }

    /**
     * The fallback: one flattened line (`EXTRA_TEXT`) with the post time. Apps that do not use
     * MessagingStyle — plain SMS clients, some bots — only ever offer this. It is worse (no real
     * timestamps, no direction, no history) but it is a real message, and the alternative is
     * silently ignoring an app the wearer explicitly allowlisted.
     */
    private fun readFlatFallback(extras: Bundle, postTime: Long, salt: ByteArray): List<NotifyStore.Msg> {
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        if (text.isNullOrEmpty()) return emptyList()
        val sender = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        return listOf(
            NotifyStore.Msg(
                fromMe = false,
                atMs = if (postTime > 0L) postTime else System.currentTimeMillis(),
                body = text,
                senderHash = Rules.senderHash(salt, sender)
            )
        )
    }
}
