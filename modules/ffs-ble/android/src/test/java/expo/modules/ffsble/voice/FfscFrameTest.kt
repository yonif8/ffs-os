package expo.modules.ffsble.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the phone's FFSC encoder to the bytes `g2flash/tools/ffsc_ref.py` produces -- the same
 * bytes the on-glass parser (`g2flash/patches/ffs_data.h`) is tested against. Regenerate the
 * expectations with `python g2flash/tools/ffsc_ref.py`; a diff here means the layout moved in
 * one place and not the others, which is the exact failure this file exists to catch.
 */
class FfscFrameTest {

    private fun hex(s: String) = ByteArray(s.length / 2) {
        ((Character.digit(s[it * 2], 16) shl 4) or Character.digit(s[it * 2 + 1], 16)).toByte()
    }

    @Test fun `put_tiny matches the reference encoder`() {
        assertArrayEquals(
            hex("46465343010003000100050086a6103668656c6c6f"),
            FfscFrame.encode(3, 1, "hello".toByteArray())
        )
    }

    @Test fun `put_again matches the reference encoder`() {
        assertArrayEquals(
            hex("464653430100030002000500366444c148454c4c4f"),
            FfscFrame.encode(3, 2, "HELLO".toByteArray())
        )
    }

    @Test fun `put_other_app matches the reference encoder`() {
        assertArrayEquals(
            hex("4646534301000700010004002438b23f000102ff"),
            FfscFrame.encode(7, 1, byteArrayOf(0x00, 0x01, 0x02, 0xff.toByte()))
        )
    }

    @Test fun `clear matches the reference encoder`() {
        assertArrayEquals(
            hex("46465343010103000400000000000000"),
            FfscFrame.encode(3, 4, ByteArray(0), FfscFrame.OP_CLEAR)
        )
    }

    @Test fun `the FXP1 envelope matches guards frame`() {
        assertArrayEquals(
            hex("46585031150000002026ac5946465343010003000100050086a6103668656c6c6f"),
            FfscFrame.put(3, 1, "hello".toByteArray())
        )
    }

    @Test fun `refuses what the glasses would refuse`() {
        for (bad in listOf(0, 0xFFFF, -1)) {
            try {
                FfscFrame.encode(bad, 1, "x".toByteArray()); throw AssertionError("appId $bad accepted")
            } catch (e: IllegalArgumentException) { /* expected */ }
        }
        try {
            FfscFrame.encode(3, 1, ByteArray(0)); throw AssertionError("empty PUT accepted")
        } catch (e: IllegalArgumentException) { /* expected */ }
        try {
            FfscFrame.encode(3, 1, ByteArray(FfscFrame.MAX_BLOB + 1)); throw AssertionError("oversize accepted")
        } catch (e: IllegalArgumentException) { /* expected */ }
    }

    // -- LiveTextSink ---------------------------------------------------------------------
    //
    // The sink coalesces: a mutation marks state dirty and wakes a pusher thread. These tests
    // drive `flushNow()` directly instead of starting that thread, so they assert the CONTENT
    // of what would go out without depending on wall-clock timing. `pushes coalesce` covers
    // the threaded half.

    private fun blobOf(frame: ByteArray) =
        String(frame, 12 + 0x10, frame.size - 12 - 0x10, Charsets.US_ASCII)

    private fun seqOf(frame: ByteArray) =
        (frame[12 + 8].toInt() and 0xFF) or ((frame[12 + 9].toInt() and 0xFF) shl 8)

    @Test fun `pending text replaces the tail, committed text accumulates`() {
        val sent = ArrayList<ByteArray>()
        val sink = LiveTextSink(appId = 14, send = { sent.add(it) })

        sink.setPending("so I thin"); sink.flushNow()
        sink.setPending("so I think so"); sink.flushNow()
        sink.commit("So I think so."); sink.flushNow()
        sink.setPending("and then"); sink.flushNow()

        assertEquals(listOf("so I thin", "so I think so", "So I think so.", "So I think so. and then"),
            sent.map { blobOf(it) })
    }

    @Test fun `every push carries a fresh seq`() {
        val sent = ArrayList<ByteArray>()
        val sink = LiveTextSink(appId = 14, send = { sent.add(it) })
        sink.setPending("one"); sink.flushNow()
        sink.setPending("two"); sink.flushNow()
        assertEquals(2, sent.size)
        assertTrue("seq must advance", seqOf(sent[1]) != seqOf(sent[0]))
    }

    @Test fun `identical text is never pushed twice`() {
        val sent = ArrayList<ByteArray>()
        val sink = LiveTextSink(appId = 14, send = { sent.add(it) })
        sink.setPending("same"); sink.flushNow()
        sink.setPending("same"); sink.flushNow()
        sink.flushNow()
        assertEquals(1, sent.size)
    }

    @Test fun `the window trims from the OLD end`() {
        val sent = ArrayList<ByteArray>()
        val sink = LiveTextSink(appId = 14, windowChars = 10, send = { sent.add(it) })
        sink.commit("aaaaaaaaaa"); sink.flushNow()
        sink.commit("bbbb"); sink.flushNow()
        val blob = blobOf(sent.last())
        assertEquals(10, blob.length)
        assertTrue("newest text must survive", blob.endsWith("bbbb"))
    }

    @Test fun `text the 5x7 face cannot draw is folded, never boxed`() {
        val sent = ArrayList<ByteArray>()
        val sink = LiveTextSink(appId = 14, send = { sent.add(it) })
        sink.commit("café naïve — it’s   fine  ok"); sink.flushNow()
        val blob = blobOf(sent.last())
        assertEquals("cafe naive - it's fine ok", blob)
        for (b in blob) assertTrue("byte ${b.code} is undrawable", b.code in 0x20..0x7E)
    }

    @Test fun `an empty transcript is not pushed`() {
        val sent = ArrayList<ByteArray>()
        val sink = LiveTextSink(appId = 14, send = { sent.add(it) })
        sink.commit(""); sink.flushNow()
        sink.setPending("   "); sink.flushNow()
        assertEquals(0, sent.size)
    }

    @Test fun `a throwing sender never escapes`() {
        val sink = LiveTextSink(appId = 14, send = { throw RuntimeException("BLE down") })
        sink.commit("still fine")
        sink.flushNow()                      // must not throw
        assertEquals("still fine".length, sink.size())
    }

    @Test fun `a burst of revisions coalesces into far fewer pushes`() {
        val sent = java.util.Collections.synchronizedList(ArrayList<ByteArray>())
        val sink = LiveTextSink(appId = 14, minIntervalMs = 120, send = { sent.add(it) })
        sink.start()
        try {
            // 30 revisions inside roughly two intervals: the radio must not see 30 frames.
            for (i in 1..30) { sink.setPending("word $i"); Thread.sleep(8) }
            Thread.sleep(300)
        } finally {
            sink.stop()
        }
        assertTrue("expected coalescing, got ${sent.size} pushes", sent.size in 1..8)
        // Whatever else was dropped, the LAST state must be what is on the face.
        assertEquals("word 30", blobOf(sent.last()))
    }

    @Test fun `reset clears the face and the window`() {
        val sent = ArrayList<ByteArray>()
        val sink = LiveTextSink(appId = 14, send = { sent.add(it) })
        sink.commit("some words"); sink.flushNow()
        sent.clear()
        sink.reset()
        assertEquals(0, sink.size())
        assertEquals(1, sent.size)
        // A CLEAR is op=1 with no blob: 12 B FXP1 + 16 B FFSC header, nothing after it.
        assertEquals(12 + 0x10, sent[0].size)
        assertEquals(1, sent[0][12 + 5].toInt())
    }
}
