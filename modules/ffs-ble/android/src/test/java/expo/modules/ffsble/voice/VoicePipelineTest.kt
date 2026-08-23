package expo.modules.ffsble.voice

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch

/**
 * The threading half: does the right PCM come out, in the right order, exactly once, off the
 * caller's thread, and does the thing shut down cleanly?
 *
 * WHY THESE TESTS CAN EXIST AT ALL
 * --------------------------------
 * [FakeLc3Decoder] makes decode a PURE function of the frame bytes, so "packet 7's audio came
 * out third" is an exact array comparison rather than a listening exercise, and concealment is
 * a constant that no real frame produces. Every assertion below is therefore about PLUMBING --
 * ordering, dedup, gaps, back-pressure, shutdown -- which is precisely the half that does not
 * need liblc3 and precisely the half where the bugs are.
 *
 * `[proven]` here means proven on the JVM, about the plumbing. Audio QUALITY is not in scope for
 * any test in this file and cannot be: that needs the real decoder and a real recording.
 *
 * Run: ./gradlew :ffs-ble:test --tests 'expo.modules.ffsble.voice.*'
 */
class VoicePipelineTest {

    /** Records chunks and stats; optionally blocks, to manufacture a backed-up decode thread. */
    private class Recorder : VoiceSink {
        val chunks: MutableList<VoiceAudioChunk> = Collections.synchronizedList(ArrayList())
        val stats: MutableList<VoiceFramerStats> = Collections.synchronizedList(ArrayList())
        @Volatile var gate: CountDownLatch? = null
        val arrived = CountDownLatch(1)

        override fun onChunk(chunk: VoiceAudioChunk) {
            gate?.await()
            chunks.add(chunk)
            arrived.countDown()
        }

        override fun onStats(stats: VoiceFramerStats) {
            this.stats.add(stats)
        }
    }

    private val sink = Recorder()
    private var pipeline: VoicePipeline? = null

    private fun pipeline(capacity: Int = 100): VoicePipeline {
        val p = VoicePipeline(
            decoderFactory = { decoder = FakeLc3Decoder(); decoder!! },
            sink = sink,
            capacity = capacity,
            clock = { nowMs }
        )
        pipeline = p
        return p
    }

    @Volatile
    private var decoder: FakeLc3Decoder? = null
    private var nowMs = 10_000L

    @After
    fun tearDown() {
        // Never leave a thread behind, even when an assertion blew up mid-test.
        sink.gate?.countDown()
        pipeline?.stop()
    }

    /** Wait until [n] chunks have arrived, or fail -- no sleeps, no flaky timing. */
    private fun awaitChunks(n: Int, timeoutMs: Long = 5_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (sink.chunks.size < n && System.currentTimeMillis() < deadline) Thread.sleep(2)
        assertEquals("expected $n chunks", n, sink.chunks.size)
    }

    private fun expectedPcm(counter: Int): ShortArray {
        val raw = VoiceTestPackets.packet(counter)
        val out = ShortArray(VoiceFormat.SAMPLES_PER_PACKET)
        for (f in 0 until VoiceFormat.FRAMES_PER_PACKET) {
            FakeLc3Decoder.pcmForFrame(
                raw, f * VoiceFormat.FRAME_BYTES, VoiceFormat.FRAME_BYTES,
                out, f * VoiceFormat.SAMPLES_PER_FRAME
            )
        }
        return out
    }

    // -- the happy path ----------------------------------------------------------------------

    @Test
    fun `packets decode to 800 samples each, in order, exactly once`() {
        val p = pipeline()
        p.start()
        for (c in 1..5) p.submit(VoiceTestPackets.packet(c), "R")
        awaitChunks(5)
        for (i in 0 until 5) {
            val chunk = sink.chunks[i]
            assertEquals(VoiceFormat.SAMPLES_PER_PACKET, chunk.samples)
            assertEquals(VoiceFormat.SAMPLES_PER_PACKET, chunk.pcm.size)
            assertFalse(chunk.concealed)
            assertArrayEquals("chunk $i must be packet ${i + 1}", expectedPcm(i + 1), chunk.pcm)
        }
    }

    @Test
    fun `the FIVE frames go through the decoder separately -- not one 200-byte call`() {
        val p = pipeline()
        p.start()
        p.submit(VoiceTestPackets.packet(1), "R")
        awaitChunks(1)
        p.stop()
        // Five decodeFrame calls for one packet. A single 200-byte call would read 1 here, and
        // that mistake produces white noise on a real decoder.
        assertEquals(5, decoder!!.framesDecoded)
    }

    @Test
    fun `metadata rides through -- ssr and tdoa survive, signed`() {
        val p = pipeline()
        p.start()
        p.submit(VoiceTestPackets.packet(1, ssr = 4321, tdoa = -16), "R")
        awaitChunks(1)
        assertEquals(4321, sink.chunks[0].ssr)
        assertEquals(-16, sink.chunks[0].tdoa)
        assertEquals(nowMs, sink.chunks[0].tMs)
    }

    @Test
    fun `both lenses submit and only one copy is decoded`() {
        val p = pipeline()
        p.start()
        for (c in 1..4) {
            p.submit(VoiceTestPackets.packet(c), "R")
            p.submit(VoiceTestPackets.packet(c), "L")
        }
        awaitChunks(4)
        p.stop()
        assertEquals(8, p.submitted)
        assertEquals(4, p.stats().duplicates)
    }

    // -- gaps --------------------------------------------------------------------------------

    @Test
    fun `a gap of 3 emits two concealed chunks BEFORE the packet that revealed it`() {
        val p = pipeline()
        p.start()
        p.submit(VoiceTestPackets.packet(1), "R")
        nowMs += 200
        p.submit(VoiceTestPackets.packet(4), "R")
        awaitChunks(4)

        assertFalse(sink.chunks[0].concealed)
        assertTrue(sink.chunks[1].concealed)
        assertTrue(sink.chunks[2].concealed)
        assertFalse(sink.chunks[3].concealed)

        // Concealed chunks really are PLC output, all 800 samples of each.
        for (i in 1..2) {
            for (f in 0 until VoiceFormat.FRAMES_PER_PACKET) {
                assertTrue(
                    FakeLc3Decoder.isConcealFrame(sink.chunks[i].pcm, f * VoiceFormat.SAMPLES_PER_FRAME)
                )
            }
        }
        assertArrayEquals(expectedPcm(4), sink.chunks[3].pcm)

        // Back-dated so the timeline stays contiguous: the two missing 50 ms slots sit
        // immediately before the packet that arrived.
        assertEquals(nowMs - 100, sink.chunks[1].tMs)
        assertEquals(nowMs - 50, sink.chunks[2].tMs)
        assertEquals(nowMs, sink.chunks[3].tMs)
    }

    @Test
    fun `a gap of 20 resyncs -- no concealment is fabricated`() {
        val p = pipeline()
        p.start()
        p.submit(VoiceTestPackets.packet(100), "R")
        p.submit(VoiceTestPackets.packet(120), "R")
        awaitChunks(2)
        p.stop()
        assertEquals(0, decoder!!.framesConcealed)
        assertFalse(sink.chunks[1].concealed)
        val s = p.stats()
        assertEquals(1, s.resyncs)
        assertEquals(19, s.lostPackets)
    }

    // -- malformed ---------------------------------------------------------------------------

    @Test
    fun `a wrong-length notification is counted and produces no audio`() {
        val p = pipeline()
        p.start()
        p.submit(ByteArray(64), "R")
        p.submit(ByteArray(300), "R")
        p.submit(VoiceTestPackets.packet(1), "R")
        awaitChunks(1)
        p.stop()
        assertEquals(2, p.stats().malformed)
        assertEquals(1, sink.chunks.size)
    }

    // -- back-pressure -----------------------------------------------------------------------

    @Test
    fun `a full queue drops the OLDEST and counts the overrun -- submit never blocks`() {
        val p = pipeline(capacity = 4)
        val gate = CountDownLatch(1)
        sink.gate = gate
        p.start()

        // Packet 1 enters the sink and is held there, so the decode thread is stuck.
        p.submit(VoiceTestPackets.packet(1), "R")
        assertTrue("decode thread must have taken the first packet", sink.arrived.count == 1L)
        // Give the worker a moment to pull packet 1 out of the queue and block in the sink.
        val deadline = System.currentTimeMillis() + 2_000
        while (p.depth > 0 && System.currentTimeMillis() < deadline) Thread.sleep(2)

        // Now overfill: 4 fit, the rest evict. Counters step by 10 so that the survivors are
        // separated by a resync-sized gap -- the point of THIS test is the eviction policy, and
        // concealment chunks in the middle would only obscure which packets survived.
        val t0 = System.currentTimeMillis()
        for (c in 2..12) p.submit(VoiceTestPackets.packet(c * 10), "R")
        val elapsed = System.currentTimeMillis() - t0

        assertTrue("submit blocked for ${elapsed}ms -- it must never block", elapsed < 1_000)
        assertEquals("11 submitted, 4 fit", 7, p.overruns)
        assertEquals(4, p.depth)

        sink.gate = null
        gate.countDown()
        p.stop()

        // The survivors are the NEWEST four, plus the one already in the sink. Dropping the
        // newest instead would leave the transcript permanently lagging.
        assertEquals(5, sink.chunks.size)
        assertArrayEquals(expectedPcm(1), sink.chunks[0].pcm)
        assertArrayEquals(expectedPcm(90), sink.chunks[1].pcm)
        assertArrayEquals(expectedPcm(100), sink.chunks[2].pcm)
        assertArrayEquals(expectedPcm(110), sink.chunks[3].pcm)
        assertArrayEquals(expectedPcm(120), sink.chunks[4].pcm)
    }

    @Test
    fun `submit before start is rejected, not queued`() {
        val p = pipeline()
        p.submit(VoiceTestPackets.packet(1), "R")
        assertEquals(1, p.rejected)
        assertEquals(0, p.submitted)
        assertEquals(0, p.depth)
    }

    @Test
    fun `submit after stop is rejected`() {
        val p = pipeline()
        p.start()
        p.stop()
        p.submit(VoiceTestPackets.packet(1), "R")
        assertEquals(1, p.rejected)
    }

    // -- lifecycle ---------------------------------------------------------------------------

    @Test
    fun `start is idempotent and builds exactly ONE decoder`() {
        val before = FakeLc3Decoder.created.get()
        val p = pipeline()
        p.start()
        p.start()
        p.start()
        p.submit(VoiceTestPackets.packet(1), "R")
        awaitChunks(1)
        p.stop()
        assertEquals("one decoder per stream, always", 1, FakeLc3Decoder.created.get() - before)
    }

    @Test
    fun `stop drains the queue rather than truncating it`() {
        val p = pipeline()
        p.start()
        for (c in 1..30) p.submit(VoiceTestPackets.packet(c), "R")
        p.stop()
        assertEquals("every submitted packet must have been decoded", 30, sink.chunks.size)
    }

    @Test
    fun `stop closes the decoder exactly once and leaves no thread behind`() {
        val p = pipeline()
        p.start()
        p.submit(VoiceTestPackets.packet(1), "R")
        awaitChunks(1)
        p.stop()
        p.stop()
        p.stop()
        assertNotNull(decoder)
        assertTrue(decoder!!.closed)
        assertEquals(1, decoder!!.closes)
        assertFalse(p.isRunning)
        // A joined thread can linger as "alive" for a moment after run() returns, so poll
        // briefly rather than asserting on the instant.
        val deadline = System.currentTimeMillis() + 2_000
        var live = liveDecodeThreads()
        while (live > 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(5)
            live = liveDecodeThreads()
        }
        assertEquals("the decode thread must be gone", 0, live)
    }

    @Test
    fun `stop without start does nothing`() {
        val p = pipeline()
        p.stop()
        assertFalse(p.isRunning)
    }

    @Test
    fun `restarting resets the framer -- the old head does not look like a huge gap`() {
        val p = pipeline()
        p.start()
        p.submit(VoiceTestPackets.packet(1), "R")
        awaitChunks(1)
        p.stop()
        p.start()
        p.submit(VoiceTestPackets.packet(200), "R")
        awaitChunks(2)
        p.stop()
        assertEquals(0, p.stats().resyncs)
    }

    // -- robustness --------------------------------------------------------------------------

    @Test
    fun `a throwing sink is counted, not fatal`() {
        val exploding = object : VoiceSink {
            var n = 0
            override fun onChunk(chunk: VoiceAudioChunk) {
                n++
                throw IllegalStateException("boom")
            }
            override fun onStats(stats: VoiceFramerStats) {}
        }
        val p = VoicePipeline({ FakeLc3Decoder() }, exploding, 16, { nowMs })
        pipeline = p
        p.start()
        for (c in 1..5) p.submit(VoiceTestPackets.packet(c), "R")
        p.stop()
        assertEquals("the stream must keep going after a sink throws", 5, exploding.n)
        assertEquals(5, p.sinkErrors)
    }

    @Test
    fun `stats are published on stop even below the cadence`() {
        val p = pipeline()
        p.start()
        p.submit(VoiceTestPackets.packet(1), "R")
        awaitChunks(1)
        p.stop()
        assertTrue("stop must publish a final snapshot", sink.stats.isNotEmpty())
        assertEquals(1, sink.stats.last().received)
    }

    @Test
    fun `submit copies the caller's array -- a reused BLE buffer cannot corrupt audio`() {
        val p = pipeline()
        val gate = CountDownLatch(1)
        sink.gate = gate
        p.start()
        val reused = VoiceTestPackets.packet(1)
        p.submit(reused, "R")
        // The Bluetooth stack may reuse the value array the instant the callback returns.
        java.util.Arrays.fill(reused, 0.toByte())
        sink.gate = null
        gate.countDown()
        awaitChunks(1)
        p.stop()
        assertArrayEquals(
            "the pipeline must have kept its own copy",
            expectedPcm(1),
            sink.chunks[0].pcm
        )
    }

    private fun liveDecodeThreads(): Int =
        Thread.getAllStackTraces().keys.count { it.name == "ffs-voice-decode" && it.isAlive }

    private fun assertArrayEquals(message: String, expected: ShortArray, actual: ShortArray) =
        org.junit.Assert.assertArrayEquals(message, expected, actual)

    private fun assertArrayEquals(expected: ShortArray, actual: ShortArray) =
        org.junit.Assert.assertArrayEquals(expected, actual)
}
