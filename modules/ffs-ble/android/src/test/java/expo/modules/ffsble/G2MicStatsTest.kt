package expo.modules.ffsble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mic telemetry is the ONE place in the driver where getting the accounting wrong has already
 * cost us: `[proven]`, 3,281 audio notifications were logged and shipped before the privacy
 * guard existed. [G2MicStats] is what makes the instrument numeric by construction; these tests
 * pin the counting and the burst-edge detection so a future edit cannot quietly regress either.
 *
 * They exercise the SAME object the driver runs -- [G2Central] holds one [G2MicStats] and only
 * ever calls the methods below. A fake clock drives burst detection deterministically without
 * `android.os.SystemClock`, which does not exist on the plain JVM this runs on.
 *
 * Run: ./gradlew :ffs-ble:test
 */
class G2MicStatsTest {

    private val logs = ArrayList<String>()
    private val unexpected = ArrayList<Triple<String, Long, Boolean>>()
    private var nowMs = 1_000L

    private fun stats() = G2MicStats(
        log = { logs.add(it) },
        onUnexpected = { side, gap, req -> unexpected.add(Triple(side, gap, req)) },
        clock = { nowMs }
    )

    @Test
    fun `a good left packet is counted`() {
        val s = stats()
        s.count(205, "L")
        s.logStats()
        assertTrue("pkts=1 must appear", logs.last().contains("pkts=1 (L)"))
    }

    @Test
    fun `a wrong-length packet is bad, not counted`() {
        val s = stats()
        s.count(204, "L")
        s.logStats()
        val line = logs.last()
        assertTrue(line.contains("pkts=0"))
        assertTrue(line.contains("bad=1"))
    }

    @Test
    fun `a right-lens packet counts on the right tally, never the left`() {
        val s = stats()
        s.count(205, "R")
        s.logStats()
        val line = logs.last()
        assertTrue(line.contains("pkts=0 (L)"))
        assertTrue(line.contains("right=1"))
    }

    @Test
    fun `the first packet is a burst and fires onUnexpected with gap -1`() {
        val s = stats()
        s.count(205, "L")
        assertEquals(1, unexpected.size)
        assertEquals(-1L, unexpected[0].second) // no prior packet -> sentinel gap
    }

    @Test
    fun `a burst we did not request is logged and flagged unrequested`() {
        val s = stats()
        s.requestedByUs = false
        s.count(205, "L")
        assertTrue(logs.any { it.contains("MIC-UNEXPECTED") })
        assertFalse(unexpected[0].third) // requestedByUs == false
    }

    @Test
    fun `a burst we requested still fires onUnexpected but is not logged as unexpected`() {
        val s = stats()
        s.requestedByUs = true
        s.count(205, "L")
        assertFalse("our own burst must not shout MIC-UNEXPECTED",
            logs.any { it.contains("MIC-UNEXPECTED") })
        assertEquals(1, unexpected.size)
        assertTrue(unexpected[0].third)
    }

    @Test
    fun `packets within the burst gap do not open a new burst`() {
        val s = stats()
        s.count(205, "L")      // burst 1
        nowMs += 50            // one packet interval, well under the 1.5s gap
        s.count(205, "L")
        assertEquals("still one burst", 1, unexpected.size)
    }

    @Test
    fun `silence past the burst gap opens a new burst`() {
        val s = stats()
        s.count(205, "L")      // burst 1
        nowMs += 2_000         // > 1.5s of silence
        s.count(205, "L")      // burst 2
        assertEquals(2, unexpected.size)
    }

    @Test
    fun `resetCounters zeroes the packet tallies and logs it`() {
        val s = stats()
        s.count(205, "L")
        s.resetCounters()
        assertTrue(logs.any { it == "mic stats reset" })
        s.logStats()
        assertTrue(logs.last().contains("pkts=0 (L)"))
    }

    @Test
    fun `resetSession clears burst tracking so the next packet is a fresh burst`() {
        val s = stats()
        s.count(205, "L")      // burst 1
        s.resetSession()
        unexpected.clear()
        // Without the lastAnyMs reset this same-timestamp packet would NOT be a new burst.
        s.count(205, "L")
        assertEquals("resetSession must re-arm burst detection", 1, unexpected.size)
    }

    @Test
    fun `logStats reports audioMs as 50ms per left packet`() {
        val s = stats()
        repeat(3) { s.count(205, "L") } // same timestamp; all three count
        s.logStats()
        assertTrue(logs.last().contains("audioMs=150"))
    }
}
