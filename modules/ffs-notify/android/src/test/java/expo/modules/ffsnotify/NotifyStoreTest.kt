package expo.modules.ffsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Plain JVM tests — no device, no emulator, no Robolectric. [Rules] and [NotifyStore] are pure
 * data structures precisely so the privacy claims about them are machine-checked rather than
 * asserted in a comment.
 *
 *     ./gradlew :ffs-notify:test
 */
class NotifyStoreTest {

    private val salt = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)

    @Before
    fun setUp() = NotifyStore.resetForTest()

    private fun msg(t: Long, body: String, fromMe: Boolean = false) =
        NotifyStore.Msg(fromMe, t, body, Rules.senderHash(salt, "Sarah"))

    // ── the gate ───────────────────────────────────────────────────────────────────────────

    @Test
    fun `the allowlist is exact-match only`() {
        val allow = setOf("com.whatsapp")
        assertTrue(Rules.allows(allow, "com.whatsapp"))
        // The three shapes a sloppy implementation would let through:
        assertFalse(Rules.allows(allow, "com.whatsapp.evil"))   // prefix
        assertFalse(Rules.allows(allow, "evil.com.whatsapp"))   // suffix
        assertFalse(Rules.allows(allow, "COM.WHATSAPP"))        // case
        assertFalse(Rules.allows(allow, ""))
        assertFalse(Rules.allows(allow, null))
        assertFalse(Rules.allows(emptySet(), "com.whatsapp"))
    }

    @Test
    fun `the default allowlist is messaging apps and nothing else`() {
        // A bank, a mailer or an authenticator appearing here is the failure this test exists for.
        for (p in Rules.DEFAULT_ALLOW) {
            assertTrue(
                "$p does not look like a messaging package",
                p.contains("messag") || p.contains("securesms") || p.contains("whatsapp") || p.contains("telegram")
            )
        }
        assertEquals(Rules.DEFAULT_ALLOW.size, Rules.DEFAULT_ALLOW.distinct().size)
    }

    @Test
    fun `parse and format round-trip and reject junk`() {
        assertEquals(listOf("a.b", "c.d"), Rules.parse(" a.b , c.d , , a.b "))
        assertEquals("a.b,c.d", Rules.format(listOf("a.b", "c.d", "a.b", "  ")))
        assertEquals(emptyList<String>(), Rules.parse(null))
    }

    @Test
    fun `senderHash is stable, salted and not the name`() {
        val a = Rules.senderHash(salt, "Sarah")
        assertEquals(a, Rules.senderHash(salt, "Sarah"))
        assertNotEquals(a, Rules.senderHash(salt, "Sarah "))
        assertNotEquals(a, Rules.senderHash(byteArrayOf(9, 9, 9, 9, 9, 9, 9, 9), "Sarah"))
        assertEquals(8, a.length)
        assertFalse(a.contains("Sarah", ignoreCase = true))
        assertEquals("00000000", Rules.senderHash(salt, null))
    }

    // ── the store ──────────────────────────────────────────────────────────────────────────

    @Test
    fun `stats are numbers only — the whole loggable surface`() {
        NotifyStore.ingest("com.whatsapp", "k", "Sarah", true, listOf(msg(1000, "hello")))
        for ((k, v) in NotifyStore.stats()) {
            assertTrue("$k is not a number: ${v?.javaClass}", v is Number)
        }
    }

    @Test
    fun `a re-posted notification adds nothing — messaging apps repost constantly`() {
        val burst = listOf(msg(1000, "one"), msg(2000, "two"))
        assertTrue(NotifyStore.ingest("com.whatsapp", "k", "Sarah", true, burst))
        assertFalse(NotifyStore.ingest("com.whatsapp", "k", "Sarah", true, burst))
        assertFalse(NotifyStore.ingest("com.whatsapp", "k", "Sarah", true, burst))
        assertEquals(1, NotifyStore.snapshot().size)
        assertEquals(2, (NotifyStore.snapshot()[0]["messages"] as List<*>).size)
        assertEquals(4L, NotifyStore.stats()["duplicates"])
    }

    @Test
    fun `a burst of twenty converges on the newest twelve, oldest first`() {
        // The real burst shape: each new message re-posts the whole recent history.
        for (i in 1..20) {
            val history = (maxOf(1, i - 6)..i).map { msg(it * 1000L, "m$it") }
            NotifyStore.ingest("com.whatsapp", "k", "Sarah", true, history)
        }
        val msgs = NotifyStore.snapshot()[0]["messages"] as List<*>
        assertEquals(NotifyStore.MAX_MSGS, msgs.size)
        @Suppress("UNCHECKED_CAST")
        val bodies = msgs.map { (it as Map<String, Any?>)["body"] as String }
        assertEquals("m9", bodies.first())   // oldest kept
        assertEquals("m20", bodies.last())   // newest last — FFSM reading order
    }

    @Test
    fun `the thread count is bounded and evicts the least recently ACTIVE`() {
        for (i in 1..NotifyStore.MAX_THREADS) {
            NotifyStore.ingest("com.whatsapp", "k$i", "T$i", true, listOf(msg(i * 1000L, "x")))
        }
        // Touch the oldest thread so it is no longer the least recently active...
        NotifyStore.ingest("com.whatsapp", "k1", "T1", true, listOf(msg(99_000L, "fresh")))
        // ...then overflow. k2 (now the stalest) must go, and k1 must survive.
        NotifyStore.ingest("com.whatsapp", "k99", "New", true, listOf(msg(100_000L, "y")))
        val keys = NotifyStore.snapshot().map { it["name"] as String }
        assertEquals(NotifyStore.MAX_THREADS, keys.size)
        assertTrue(keys.contains("T1"))
        assertFalse(keys.contains("T2"))
    }

    @Test
    fun `bodies and names are clipped on the way IN, not on the way out`() {
        val essay = "z".repeat(5000)
        NotifyStore.ingest("com.whatsapp", "k", "a-very-long-group-name", true, listOf(msg(1000, essay)))
        val t = NotifyStore.snapshot()[0]
        assertEquals(NotifyStore.MAX_NAME, (t["name"] as String).length)
        @Suppress("UNCHECKED_CAST")
        val body = ((t["messages"] as List<*>)[0] as Map<String, Any?>)["body"] as String
        assertEquals(NotifyStore.MAX_BODY, body.length)
    }

    @Test
    fun `dropping a package from the allowlist forgets it immediately`() {
        NotifyStore.ingest("com.whatsapp", "k", "Sarah", true, listOf(msg(1000, "hi")))
        NotifyStore.ingest("org.telegram.messenger", "k", "Dan", true, listOf(msg(2000, "yo")))
        assertEquals(2, NotifyStore.snapshot().size)
        NotifyStore.retainOnly(setOf("com.whatsapp"))
        assertEquals(1, NotifyStore.snapshot().size)
        assertEquals("com.whatsapp", NotifyStore.snapshot()[0]["pkg"])
    }

    @Test
    fun `a dropped notification leaves only a counter`() {
        NotifyStore.noteDropped()
        NotifyStore.noteDropped()
        assertEquals(2L, NotifyStore.stats()["dropped"])
        assertEquals(0, NotifyStore.snapshot().size)
        assertEquals(0L, NotifyStore.stats()["revision"])   // not even a repaint
    }

    @Test
    fun `threads come back newest-activity first`() {
        NotifyStore.ingest("com.whatsapp", "a", "Old", true, listOf(msg(1_000, "x")))
        NotifyStore.ingest("com.whatsapp", "b", "New", true, listOf(msg(9_000, "y")))
        NotifyStore.ingest("com.whatsapp", "c", "Mid", true, listOf(msg(5_000, "z")))
        assertEquals(listOf("New", "Mid", "Old"), NotifyStore.snapshot().map { it["name"] })
    }
}
