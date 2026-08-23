package expo.modules.ffsble.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Synthetic mic packets for the whole voice test suite.
 *
 * ⛔ SYNTHETIC ONLY. `ffs_os` is a PUBLIC repository and a mic packet is a recording of the
 * wearer -- no capture, however short, however "just a test", ever becomes a fixture here. The
 * LC3 payload below is a deterministic byte pattern; it is not audio and does not decode to
 * audio, which is fine because every test in this suite is about FRAMING, not sound.
 */
internal object VoiceTestPackets {

    /** A well-formed 205-byte packet with the given counter and metadata. */
    fun packet(counter: Int, ssr: Int = 0, tdoa: Int = 0, seed: Int = counter): ByteArray {
        val p = ByteArray(VoiceFormat.PACKET_BYTES)
        // A payload that differs per packet, so "did the right packet come out?" is decidable.
        for (i in 0 until VoiceFormat.LC3_BYTES) {
            p[i] = ((seed * 31 + i * 7) and 0xFF).toByte()
        }
        le16(p, VoiceFormat.OFF_SSR, ssr)
        le16(p, VoiceFormat.OFF_TDOA, tdoa)
        p[VoiceFormat.OFF_COUNTER] = (counter and 0xFF).toByte()
        return p
    }

    private fun le16(a: ByteArray, off: Int, v: Int) {
        a[off] = (v and 0xFF).toByte()
        a[off + 1] = ((v ushr 8) and 0xFF).toByte()
    }
}

/**
 * The framing rules, pinned.
 *
 * Every assertion here corresponds to a documented way this pipe goes wrong in the field, and
 * none of them are observable without a wearer once the code ships -- a mis-handled wraparound
 * produces a resync every 12.8 seconds forever and the only symptom is a slightly worse
 * transcript. That is exactly the class of bug a unit test has to catch, so the framer was
 * built with no Android, no threads and no decoder in it specifically so this file could exist.
 *
 * Run: ./gradlew :ffs-ble:test --tests 'expo.modules.ffsble.voice.*'
 */
class VoiceFramerTest {

    private val f = VoiceFramer()

    private fun offer(counter: Int, side: String = "R", tMs: Long = 0L): FramerAction {
        val p = f.parse(VoiceTestPackets.packet(counter), side, tMs)!!
        return f.offer(p)
    }

    // -- parse -------------------------------------------------------------------------------

    @Test
    fun `a 205-byte packet parses`() {
        val p = f.parse(VoiceTestPackets.packet(7), "R", 1234L)
        assertNotNull(p)
        assertEquals(7, p!!.counter)
        assertEquals(0, p.lc3Offset)
        assertEquals("R", p.side)
        assertEquals(1234L, p.tMs)
        assertEquals(0, f.stats().malformed)
    }

    @Test
    fun `a short packet is malformed, counted and dropped`() {
        assertNull(f.parse(ByteArray(204), "R", 0L))
        assertEquals(1, f.stats().malformed)
    }

    @Test
    fun `an oversized packet is malformed too -- enc_len is asserted, not assumed`() {
        // The dangerous case: 206 bytes still has "something" at offset 200, so an
        // implementation that trusts the offset instead of the length reads plausible garbage.
        assertNull(f.parse(ByteArray(206), "R", 0L))
        assertEquals(1, f.stats().malformed)
    }

    @Test
    fun `an empty packet is malformed`() {
        assertNull(f.parse(ByteArray(0), "L", 0L))
        assertEquals(1, f.stats().malformed)
    }

    @Test
    fun `parsing inside a pooled buffer honours the offset`() {
        val pool = ByteArray(512)
        val src = VoiceTestPackets.packet(9, ssr = 111, tdoa = -222)
        System.arraycopy(src, 0, pool, 100, src.size)
        val p = f.parse(pool, 100, VoiceFormat.PACKET_BYTES, "R", 0L)!!
        assertEquals(9, p.counter)
        assertEquals(111, p.ssr)
        assertEquals(-222, p.tdoa)
        assertEquals(100, p.lc3Offset)
    }

    @Test
    fun `a slice that runs off the end of its buffer is malformed`() {
        assertNull(f.parse(ByteArray(210), 20, VoiceFormat.PACKET_BYTES, "R", 0L))
        assertEquals(1, f.stats().malformed)
    }

    // -- ssr / tdoa --------------------------------------------------------------------------

    @Test
    fun `ssr and tdoa are little-endian`() {
        val p = f.parse(VoiceTestPackets.packet(0, ssr = 0x1234, tdoa = 0x0102), "R", 0L)!!
        assertEquals(0x1234, p.ssr)
        assertEquals(0x0102, p.tdoa)
    }

    @Test
    fun `ssr and tdoa are SIGNED -- negative tdoa is a real direction, not 65000-something`() {
        val p = f.parse(VoiceTestPackets.packet(0, ssr = -1, tdoa = -8), "R", 0L)!!
        assertEquals(-1, p.ssr)
        assertEquals(-8, p.tdoa)
        // Three fractional bits: -8 eighths is exactly one sample of lag.
        assertEquals(-1.0, p.tdoaSamples, 1e-9)
    }

    @Test
    fun `tdoa extremes survive the round trip`() {
        val lo = f.parse(VoiceTestPackets.packet(0, tdoa = -32768), "R", 0L)!!
        val hi = f.parse(VoiceTestPackets.packet(0, tdoa = 32767), "R", 0L)!!
        assertEquals(-32768, lo.tdoa)
        assertEquals(32767, hi.tdoa)
    }

    // -- sequencing --------------------------------------------------------------------------

    @Test
    fun `the first packet always delivers with no concealment`() {
        assertEquals(FramerAction.Deliver(0), offer(200))
        assertEquals(1, f.stats().received)
    }

    @Test
    fun `consecutive counters deliver cleanly`() {
        offer(10)
        assertEquals(FramerAction.Deliver(0), offer(11))
        assertEquals(FramerAction.Deliver(0), offer(12))
        val s = f.stats()
        assertEquals(3, s.received)
        assertEquals(0, s.lostPackets)
        assertEquals(0, s.concealed)
    }

    @Test
    fun `the counter wraps at 256 without a resync`() {
        offer(254)
        assertEquals(FramerAction.Deliver(0), offer(255))
        assertEquals(FramerAction.Deliver(0), offer(0))
        assertEquals(FramerAction.Deliver(0), offer(1))
        val s = f.stats()
        assertEquals(0, s.resyncs)
        assertEquals(0, s.lostPackets)
    }

    @Test
    fun `a gap ACROSS the wrap conceals, it does not resync`() {
        offer(254)
        // 254 -> 1 is three packets forward: 255, 0 lost.
        assertEquals(FramerAction.Deliver(10), offer(1))
        assertEquals(0, f.stats().resyncs)
        assertEquals(2, f.stats().lostPackets)
    }

    @Test
    fun `a duplicate across the wrap is still a duplicate`() {
        offer(255)
        offer(0)
        assertEquals(FramerAction.Duplicate, offer(255))
        assertEquals(1, f.stats().duplicates)
    }

    // -- duplicates --------------------------------------------------------------------------

    @Test
    fun `the second lens's copy is dropped -- right then left`() {
        assertEquals(FramerAction.Deliver(0), offer(5, side = "R"))
        assertEquals(FramerAction.Duplicate, offer(5, side = "L"))
        assertEquals(FramerAction.Deliver(0), offer(6, side = "R"))
        assertEquals(FramerAction.Duplicate, offer(6, side = "L"))
        val s = f.stats()
        assertEquals(4, s.received)
        assertEquals(2, s.duplicates)
    }

    @Test
    fun `the second lens's copy is dropped -- left then right`() {
        assertEquals(FramerAction.Deliver(0), offer(5, side = "L"))
        assertEquals(FramerAction.Duplicate, offer(5, side = "R"))
        assertEquals(FramerAction.Deliver(0), offer(6, side = "L"))
        assertEquals(FramerAction.Duplicate, offer(6, side = "R"))
        assertEquals(2, f.stats().duplicates)
    }

    @Test
    fun `a lens dropping out entirely does not disturb the stream`() {
        // Both lenses for three packets, then the left one goes away for good.
        for (c in 1..3) {
            assertEquals(FramerAction.Deliver(0), offer(c, side = "R"))
            assertEquals(FramerAction.Duplicate, offer(c, side = "L"))
        }
        for (c in 4..8) {
            assertEquals(FramerAction.Deliver(0), offer(c, side = "R"))
        }
        val s = f.stats()
        assertEquals(3, s.duplicates)
        assertEquals(0, s.resyncs)
        assertEquals(0, s.lostPackets)
    }

    @Test
    fun `a lagging lens reads as a duplicate, never as a 255-packet gap`() {
        offer(20, side = "R")
        offer(21, side = "R")
        // The left lens is two packets behind. Naive mod-256 arithmetic calls this delta=254.
        assertEquals(FramerAction.Duplicate, offer(19, side = "L"))
        assertEquals(FramerAction.Duplicate, offer(20, side = "L"))
        assertEquals(0, f.stats().resyncs)
        // The head did not move backwards: 22 is still the next packet, not a gap.
        assertEquals(FramerAction.Deliver(0), offer(22, side = "R"))
    }

    // -- concealment -------------------------------------------------------------------------

    @Test
    fun `a gap of 3 asks for 10 PLC frames -- two lost packets, five frames each`() {
        offer(1)
        val action = offer(4)
        assertEquals(FramerAction.Deliver(10), action)
        val s = f.stats()
        assertEquals(10, s.concealed)
        assertEquals(2, s.lostPackets)
        assertEquals(0, s.resyncs)
    }

    @Test
    fun `a gap of 2 asks for exactly one packet of PLC`() {
        offer(1)
        assertEquals(FramerAction.Deliver(5), offer(3))
        assertEquals(1, f.stats().lostPackets)
    }

    @Test
    fun `the largest concealable gap still conceals`() {
        offer(1)
        val expected = (VoiceFramer.MAX_CONCEAL_GAP - 1) * VoiceFormat.FRAMES_PER_PACKET
        assertEquals(FramerAction.Deliver(expected), offer(1 + VoiceFramer.MAX_CONCEAL_GAP))
        assertEquals(0, f.stats().resyncs)
    }

    @Test
    fun `one past the largest concealable gap resyncs instead`() {
        offer(1)
        val g = VoiceFramer.MAX_CONCEAL_GAP + 1
        assertEquals(FramerAction.Resync(g - 1), offer(1 + g))
        assertEquals(1, f.stats().resyncs)
        assertEquals(0, f.stats().concealed)
    }

    // -- resync ------------------------------------------------------------------------------

    @Test
    fun `a gap of 20 resyncs and reports 19 lost packets`() {
        offer(100)
        assertEquals(FramerAction.Resync(19), offer(120))
        val s = f.stats()
        assertEquals(1, s.resyncs)
        assertEquals(19, s.lostPackets)
        assertEquals(0, s.concealed)
    }

    @Test
    fun `a resync still delivers -- the next packet is normal again`() {
        offer(100)
        offer(120)
        assertEquals(FramerAction.Deliver(0), offer(121))
    }

    @Test
    fun `a jump far BACKWARDS resyncs with lostPackets 0 rather than inventing a number`() {
        offer(10)
        offer(11)
        // The mic reopened and the counter began again -- far behind the head (delta -11), well
        // past STALE_LOOKBACK, so this is a discontinuity and not the other lens lagging.
        val action = offer(0)
        assertTrue("expected a Resync, got $action", action is FramerAction.Resync)
        assertEquals(
            "we do not know how much was lost, so we must not invent a number",
            0,
            (action as FramerAction.Resync).lostPackets
        )
        assertEquals(0, f.stats().lostPackets)
        assertEquals(1, f.stats().resyncs)
        // The head moved to the new stream, so the restart's second packet is normal again.
        assertEquals(FramerAction.Deliver(0), offer(1))
    }

    @Test
    fun `a restart to zero from a HIGH head reads as a forward gap -- and is honest about it`() {
        // ⚠️ The unavoidable ambiguity of a mod-256 counter with no other framing: head 201 ->
        // counter 3 is 58 forward and 198 backward, and nothing on the wire says which. We take
        // the short way round, so a mic restart at a high head is reported as a 57-packet loss.
        // That over-counts loss rather than hiding it, which is the right way to be wrong here.
        offer(200)
        offer(201)
        assertEquals(FramerAction.Resync(57), offer(3))
        assertEquals(1, f.stats().resyncs)
    }

    // -- stats -------------------------------------------------------------------------------

    @Test
    fun `stats hands out an immutable snapshot`() {
        offer(1)
        val snap = f.stats()
        offer(2)
        assertEquals("the snapshot must not track later packets", 1, snap.received)
        assertEquals(2, f.stats().received)
    }

    @Test
    fun `mutating a snapshot cannot corrupt the framer`() {
        offer(1)
        f.stats().received = 9999
        assertEquals(1, f.stats().received)
    }

    @Test
    fun `reset clears the head and the counters`() {
        offer(1)
        offer(50)
        f.reset()
        val s = f.stats()
        assertEquals(0, s.received)
        assertEquals(0, s.resyncs)
        assertEquals(0, s.lostPackets)
        // Head forgotten: the next packet is a first packet, not a 100-packet gap.
        assertEquals(FramerAction.Deliver(0), offer(150))
    }

    @Test
    fun `a long realistic stream accounts for every packet`() {
        // 300 packets of both lenses, with the firmware dropping every 37th.
        var delivered = 0
        var c = 0
        for (i in 0 until 300) {
            if (i % 37 == 36) { c = (c + 1) and 0xFF; continue }
            val a = offer(c, side = "R")
            val b = offer(c, side = "L")
            if (a !is FramerAction.Duplicate) delivered++
            assertEquals("second lens must always be the duplicate", FramerAction.Duplicate, b)
            c = (c + 1) and 0xFF
        }
        val s = f.stats()
        assertEquals(delivered + s.duplicates, s.received)
        assertEquals(0, s.malformed)
        assertEquals(0, s.resyncs)
        // Every dropped packet was concealed, five frames apiece.
        assertEquals(s.lostPackets * VoiceFormat.FRAMES_PER_PACKET, s.concealed)
    }
}
