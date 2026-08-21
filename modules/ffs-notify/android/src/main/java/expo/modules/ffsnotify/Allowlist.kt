package expo.modules.ffsnotify

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * THE ALLOWLIST — the design, not a filter bolted on.
 *
 * A NotificationListenerService sees every notification on the phone. The allowlist is what makes
 * that acceptable: [Rules.allows] is the FIRST thing [FfsNotificationListener.onNotificationPosted]
 * calls, before `sbn.notification` is touched, so a banking alert or a 2FA code is dropped BEFORE
 * it is read, encoded, counted in anything but a tally, or held in memory. A bug in the parsing
 * code below cannot mishandle a message it never received.
 *
 * Two things are persisted by this module and only these two:
 *   • the allowlist itself (package names — no content)
 *   • a random per-install salt used to hash sender names for telemetry (§[Rules.senderHash])
 * Message text is NEVER persisted. It lives in [NotifyStore]'s bounded in-memory ring and dies
 * with the process.
 *
 * ⚠️ [Rules] is deliberately Context-free so `./gradlew :ffs-notify:test` can exercise the gate
 *    itself with no device and no Robolectric — see NotifyStoreTest.kt.
 */
object Rules {

    /**
     * The default allowlist: messaging apps only.
     *
     * ⚠️ MUST MATCH `DEFAULT_ALLOW` in `src/notifications/allowlist.ts`. There is a unit test
     *    (`src/data/__tests__/notifications.test.ts`) that reads THIS FILE and fails if the two
     *    lists drift, because a phone-side default that disagrees with what the settings screen
     *    shows is a privacy claim that is quietly false.
     *
     * Packages that are not installed cost nothing — they simply never fire. The settings screen
     * marks which of these actually exist on the phone (see `FfsNotifyModule.getInstalled`).
     */
    val DEFAULT_ALLOW: List<String> = listOf(
        "com.google.android.apps.messaging",  // Google Messages (SMS/RCS) — on the test phone
        "com.samsung.android.messaging",      // Samsung Messages
        "com.android.messaging",              // AOSP Messaging
        "org.thoughtcrime.securesms",         // Signal
        "com.whatsapp",                       // WhatsApp
        "org.telegram.messenger"              // Telegram
    )

    /** Parse the stored CSV. Unknown/blank entries are dropped rather than trusted. */
    fun parse(csv: String?): List<String> =
        (csv ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    fun format(pkgs: List<String>): String =
        pkgs.map { it.trim() }.filter { it.isNotEmpty() }.distinct().joinToString(",")

    /**
     * THE GATE. Exact package match only — no prefixes, no wildcards, no "startsWith(com.whats)".
     * A wildcard here is how an allowlist stops being one.
     */
    fun allows(allow: Collection<String>, pkg: String?): Boolean =
        pkg != null && pkg.isNotEmpty() && allow.contains(pkg)

    /**
     * A stable, non-reversible tag for a sender, for the ONE place a sender may appear in
     * metadata: `NotifyStats`/telemetry. Salted per install so two devices (or a reinstall) do
     * not produce linkable tags, and truncated to 8 hex characters because it exists to answer
     * "is this the same person as the last one", never "who is this".
     *
     * ⛔ This is the only sender-derived value allowed to leave the module as metadata. The plain
     *    name goes into the FFSM blob and over BLE to the glasses, and nowhere else.
     */
    fun senderHash(salt: ByteArray, sender: String?): String {
        if (sender.isNullOrEmpty()) return "00000000"
        val md = MessageDigest.getInstance("SHA-256")
        md.update(salt)
        md.update(sender.toByteArray(Charsets.UTF_8))
        val d = md.digest()
        val sb = StringBuilder(8)
        for (i in 0 until 4) sb.append(String.format("%02x", d[i]))
        return sb.toString()
    }
}

/** The persisted half: prefs-backed, cached so the hot path never touches disk. */
object Allowlist {
    const val PREFS = "ffs_notify"
    private const val KEY_ALLOW = "allow"
    private const val KEY_SALT = "salt"
    private const val KEY_CAPTURE = "capture"

    @Volatile private var cache: Set<String>? = null
    @Volatile private var captureCache: Boolean? = null
    @Volatile private var saltCache: ByteArray? = null

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun get(ctx: Context): List<String> {
        cache?.let { return it.toList() }
        val p = prefs(ctx)
        val list = if (p.contains(KEY_ALLOW)) Rules.parse(p.getString(KEY_ALLOW, "")) else Rules.DEFAULT_ALLOW
        cache = list.toSet()
        return list
    }

    fun set(ctx: Context, pkgs: List<String>) {
        val list = Rules.parse(Rules.format(pkgs))
        prefs(ctx).edit().putString(KEY_ALLOW, Rules.format(list)).apply()
        cache = list.toSet()
        // Anything we already hold for a package that just left the allowlist must go NOW.
        // "It stops at the next notification" would leave content in memory that the wearer has
        // just said we may not have.
        NotifyStore.retainOnly(list.toSet())
    }

    /**
     * The kill switch. Default ON: the Android grant is already a deliberate, explicit act, and a
     * second silent gate that makes a granted listener do nothing is a footgun that costs an hour
     * of "why is nothing arriving". It is one toggle in the settings screen, and turning it off
     * clears the store as well as stopping the intake.
     */
    fun captureEnabled(ctx: Context): Boolean {
        captureCache?.let { return it }
        val v = prefs(ctx).getBoolean(KEY_CAPTURE, true)
        captureCache = v
        return v
    }

    fun setCaptureEnabled(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_CAPTURE, on).apply()
        captureCache = on
        if (!on) NotifyStore.clear()
    }

    fun salt(ctx: Context): ByteArray {
        saltCache?.let { return it }
        val p = prefs(ctx)
        var hex = p.getString(KEY_SALT, null)
        if (hex == null) {
            val b = ByteArray(8)
            SecureRandom().nextBytes(b)
            hex = b.joinToString("") { String.format("%02x", it) }
            p.edit().putString(KEY_SALT, hex).apply()
        }
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) out[i] = ((hex[i * 2].digitToInt(16) shl 4) or hex[i * 2 + 1].digitToInt(16)).toByte()
        saltCache = out
        return out
    }

    /** For tests / a settings screen that wants the defaults back. */
    fun reset(ctx: Context) = set(ctx, Rules.DEFAULT_ALLOW)
}
