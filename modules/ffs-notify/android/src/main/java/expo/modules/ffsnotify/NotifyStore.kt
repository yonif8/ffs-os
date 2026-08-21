package expo.modules.ffsnotify

import java.util.concurrent.atomic.AtomicLong

/**
 * THE STORE — a bounded, in-memory, process-lifetime ring of allowlisted conversations.
 *
 * ⛔ NOTHING HERE IS PERSISTED. No database, no file, no SharedPreferences, no cache directory.
 *    The only thing this module writes to disk is the allowlist and a hash salt (Allowlist.kt).
 *    A phone that reboots forgets every message it held, which is correct: the glasses are a
 *    glance at what is happening now, and a message archive is a liability we have no use for.
 *
 * ⛔ NOTHING HERE IS LOGGED. No Log.d of a body, not "the first 20 chars for debugging", not a
 *    toast. `ffs_os` is PUBLIC and `src/os/log.ts` ships records off-device to a Cloudflare
 *    collector, and our own tooling reads logcat constantly — a body in a log is a body on this
 *    PC. [Stats] is the whole loggable surface and every field of it is a number.
 *
 * ── BOUNDS, BY CONSTRUCTION ───────────────────────────────────────────────────────────────
 * [MAX_THREADS] × [MAX_MSGS] are the FFSM caps (`ffsm.ts` FFSM_MAX_THREADS / FFSM_MAX_MSGS), so
 * the store cannot hold more than the encoder can send. Bodies are clipped to [MAX_BODY]
 * (FFSM_MAX_BODY) on the way IN, not on the way out — an essay pasted into WhatsApp should never
 * be resident in the first place.
 *
 * ── WHY MERGING IS IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Messaging apps re-post the SAME notification constantly — on every new message in a thread, on
 * a read-state change, on a summary rebuild — each time carrying the whole recent history in
 * `EXTRA_MESSAGES`. So ingest is a merge keyed on (timestamp, body identity), never an append. A
 * burst of 20 messages therefore converges on one thread holding the newest 12, which is exactly
 * what one FFSM push should carry.
 */
object NotifyStore {

    const val MAX_THREADS = 8
    const val MAX_MSGS = 12
    const val MAX_BODY = 200
    const val MAX_NAME = 15

    data class Msg(
        val fromMe: Boolean,
        val atMs: Long,
        val body: String,
        /** Salted, truncated — the only sender-derived value that may appear in metadata. */
        val senderHash: String
    ) {
        /** Identity for the merge. Timestamp plus body, so an edited resend is a NEW message. */
        fun key(): String = "$atMs/${fromMe.compareTo(false)}/${body.hashCode()}"
    }

    class Convo(
        val key: String,
        val pkg: String,
        var name: String,
        var unread: Boolean,
        var lastAtMs: Long
    ) {
        val msgs = ArrayList<Msg>(MAX_MSGS)
    }

    private val lock = Any()
    private val convos = LinkedHashMap<String, Convo>()

    private val revision = AtomicLong(0)

    // ── stats: NUMBERS ONLY, and that is the privacy contract in a data structure ──────────
    private var nPosted = 0L        // allowlisted notifications that reached the parser
    private var nDropped = 0L       // notifications refused BEFORE they were read
    private var nMessages = 0L      // messages actually merged in
    private var nDuplicates = 0L    // re-posts that added nothing
    private var nEvicted = 0L       // threads/messages pushed out by the bounds
    private var nEmpty = 0L         // allowlisted, read, but carried no usable text
    private var listenerUp = 0L
    private var lastAtMs = 0L

    /** Every field is a number. See NotifyStoreTest / notifications.test.ts. */
    fun stats(): Map<String, Any?> = synchronized(lock) {
        mapOf(
            "revision" to revision.get(),
            "posted" to nPosted,
            "dropped" to nDropped,
            "messages" to nMessages,
            "duplicates" to nDuplicates,
            "evicted" to nEvicted,
            "empty" to nEmpty,
            "threads" to convos.size.toLong(),
            "held" to convos.values.sumOf { it.msgs.size }.toLong(),
            "listenerUp" to listenerUp,
            "lastAtMs" to lastAtMs
        )
    }

    fun revision(): Long = revision.get()

    fun noteListener(up: Boolean) {
        synchronized(lock) { listenerUp = if (up) 1L else 0L }
    }

    /**
     * A notification was refused before it was read. This is the ONLY trace a non-allowlisted
     * notification leaves anywhere: a counter with no package, no time and no content.
     */
    fun noteDropped() {
        synchronized(lock) { nDropped++ }
    }

    fun noteEmpty() {
        synchronized(lock) { nEmpty++ }
    }

    private fun clip(s: String, max: Int): String = if (s.length <= max) s else s.substring(0, max)

    /**
     * Merge one allowlisted conversation. Returns true if anything actually changed, so the
     * caller can skip waking the JS side for the twentieth identical re-post of a thread.
     */
    fun ingest(pkg: String, key: String, name: String, unread: Boolean, incoming: List<Msg>): Boolean {
        synchronized(lock) {
            nPosted++
            if (incoming.isEmpty()) {
                nEmpty++
                return false
            }
            var changed = false
            val id = "$pkg|$key"
            val c = convos[id] ?: Convo(id, pkg, clip(name, MAX_NAME), unread, 0L).also {
                convos[id] = it
                changed = true
            }
            val cleanName = clip(name, MAX_NAME)
            if (c.name != cleanName && cleanName.isNotEmpty()) {
                c.name = cleanName
                changed = true
            }

            val seen = HashSet<String>(c.msgs.size * 2)
            for (m in c.msgs) seen.add(m.key())
            for (raw in incoming) {
                val m = raw.copy(body = clip(raw.body, MAX_BODY))
                if (!seen.add(m.key())) {
                    nDuplicates++
                    continue
                }
                c.msgs.add(m)
                nMessages++
                changed = true
                if (m.atMs > c.lastAtMs) c.lastAtMs = m.atMs
                if (m.atMs > lastAtMs) lastAtMs = m.atMs
            }
            if (!changed) return false

            // oldest first — FFSM reading order, and the order apps/messages.c rolls through.
            c.msgs.sortBy { it.atMs }
            while (c.msgs.size > MAX_MSGS) {
                c.msgs.removeAt(0)
                nEvicted++
            }
            if (unread) c.unread = true

            // Bound the thread count: drop the LEAST RECENTLY ACTIVE conversation, not the
            // least recently seen — a chatty group must not push out the one message that
            // matters, and "most recent activity" is the only ordering the wearer can predict.
            while (convos.size > MAX_THREADS) {
                val victim = convos.values.minByOrNull { it.lastAtMs } ?: break
                convos.remove(victim.key)
                nEvicted++
            }
            revision.incrementAndGet()
            return true
        }
    }

    /** The wearer dismissed the notification: treat the thread as read, keep the text. */
    fun markRead(pkg: String, key: String) {
        synchronized(lock) {
            val c = convos["$pkg|$key"] ?: return
            if (c.unread) {
                c.unread = false
                revision.incrementAndGet()
            }
        }
    }

    /**
     * ⭐ CONTENT LEAVES HERE AND NOWHERE ELSE. One explicit, synchronous pull, called by the
     * FFSM data source at the moment it encodes. There is deliberately no event carrying bodies:
     * events fan out to listeners (and `src/os/log.ts` subscribes to event streams), a pull does
     * not.
     *
     * Newest-activity thread first — the order `apps/messages.c` lists the inbox in.
     */
    fun snapshot(): List<Map<String, Any?>> = synchronized(lock) {
        convos.values
            .sortedByDescending { it.lastAtMs }
            .map { c ->
                mapOf(
                    "pkg" to c.pkg,
                    "name" to c.name,
                    "unread" to c.unread,
                    "lastAtMs" to c.lastAtMs,
                    "messages" to c.msgs.map { m ->
                        mapOf(
                            "fromMe" to m.fromMe,
                            "atMs" to m.atMs,
                            "body" to m.body
                        )
                    }
                )
            }
    }

    /** A package left the allowlist — forget what we hold for it immediately. */
    fun retainOnly(pkgs: Set<String>) {
        synchronized(lock) {
            val gone = convos.values.filter { !pkgs.contains(it.pkg) }.map { it.key }
            if (gone.isEmpty()) return
            for (k in gone) convos.remove(k)
            revision.incrementAndGet()
        }
    }

    fun clear() {
        synchronized(lock) {
            if (convos.isEmpty()) return
            convos.clear()
            revision.incrementAndGet()
        }
    }

    /** Tests only: counters back to zero so each case starts from a known state. */
    fun resetForTest() {
        synchronized(lock) {
            convos.clear()
            revision.set(0)
            nPosted = 0; nDropped = 0; nMessages = 0; nDuplicates = 0
            nEvicted = 0; nEmpty = 0; listenerUp = 0; lastAtMs = 0
        }
    }
}
