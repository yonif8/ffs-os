package expo.modules.ffsble.voice

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * ★ **THE TAIL OF A SHORT SESSION MUST STILL BE TRANSCRIBED.**
 *
 * The regression this file exists for: [VoiceService.Clipper] used to cut a clip only when the
 * buffer was FULL ([VoiceService.DEFAULT_CLIP_SECONDS], 20 s) or when it had seen
 * [VoiceService.SILENCE_PACKETS] consecutive quiet packets -- and nothing flushed the remainder
 * at [VoiceService.stop]. So a session shorter than the ceiling, which is MOST real sessions
 * (somebody says a sentence and stops), was archived as perfectly good audio and produced **no
 * transcript at all**, silently. So was the tail of every long session.
 *
 * That failure is nasty out of proportion to its size: the audio file is right there and plays
 * back fine, so it reads as a flaky STT provider rather than as a clipping bug, and it costs
 * whoever debugs it a day pointed at the wrong component.
 *
 * ══ WHAT IS ASSERTED ════════════════════════════════════════════════════════════════════════
 *  1. Nothing is clipped DURING a 2 s session at the stock 20 s ceiling -- i.e. the test really
 *     is exercising the tail path and not accidentally passing through the full-buffer path.
 *  2. [VoiceService.stop] flushes the remainder, exactly once, as a whole clip.
 *  3. The flushed clip carries THIS session's id, so a transcript made from it is findable.
 *  4. It transcribes and is searchable -- the wearer's actual requirement is words, not files.
 *  5. [VoiceService.status] still reports the session's numbers AFTER stop (they used to read
 *     zero the moment the pipeline was torn down -- unreadable at the one moment they matter).
 *
 * ⛔ The fixture contains NO human voice; see `src/test/resources/voice/README.md`. Its `ssr`
 * never goes quiet for more than 5 consecutive packets, well under [VoiceService.SILENCE_PACKETS],
 * which is what makes assertion 1 deterministic rather than lucky.
 *
 * Run: ./gradlew :ffs-ble:testDebugUnitTest --tests 'expo.modules.ffsble.voice.VoiceTailClipTest'
 */
@RunWith(RobolectricTestRunner::class)
// ⚠️ Robolectric 4.13 ships android-all jars only up to SDK 34 while the app targets 36.
@Config(sdk = [34])
class VoiceTailClipTest {

    private var service: VoiceService? = null

    @After
    fun tearDown() {
        service?.let {
            try {
                it.shutdown()
            } finally {
                it.index.close()
            }
        }
        service = null
    }

    private fun waitUntil(timeoutMs: Long, what: String, cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (cond()) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out after ${timeoutMs}ms waiting for: $what")
    }

    private fun readLePcm(f: File): ShortArray {
        val b = f.readBytes()
        val out = ShortArray(b.size / 2)
        for (i in out.indices) {
            val lo = b[i * 2].toInt() and 0xFF
            val hi = b[i * 2 + 1].toInt() and 0xFF
            out[i] = ((hi shl 8) or lo).toShort()
        }
        return out
    }

    @Test
    fun `a session shorter than the clip ceiling still produces a transcript`() {
        val raw = javaClass.getResourceAsStream("/voice/fixture-speech.g2a")?.use { it.readBytes() }
        assumeTrue("fixture-speech.g2a not present", raw != null)
        val packets = raw!!.size / VoiceFormat.PACKET_BYTES
        assertEquals("the fixture is 40 packets = 2 s, far under the 20 s ceiling", 40, packets)

        val logLines = java.util.Collections.synchronizedList(ArrayList<String>())
        val svc = VoiceService(
            context = ApplicationProvider.getApplicationContext(),
            log = { logLines.add(it) },
            // FakeLc3Decoder on purpose: this is a CLIPPING test. Codec quality is proven in
            // VoiceRealDecodeTest, and depending on the host `.so` here would make a regression
            // in the tail path skippable.
            decoderFactory = { FakeLc3Decoder() }
        )
        service = svc

        // ⚠️ NO `maxClipSeconds` override. The stock ceiling is the whole point: the bug only
        // appears when the session ends before the buffer fills.
        svc.configStore.save(SttConfig(providerKind = SttConfig.KIND_NONE))

        val sessionId = svc.start()
        for (i in 0 until packets) {
            svc.submit(
                raw.copyOfRange(i * VoiceFormat.PACKET_BYTES, (i + 1) * VoiceFormat.PACKET_BYTES),
                "L"
            )
        }

        // Settle on the stats snapshot -- with the drain-idle publish in VoicePipeline this is
        // exact once the decode thread has nothing left to do, not merely within 20 packets.
        waitUntil(10_000, "the decode thread caught up") { svc.status()["packets"] == packets }

        // ── 1. nothing was clipped DURING the session ──────────────────────────────────────
        assertEquals(
            "2 s at a 20 s ceiling must not fill a clip -- otherwise this test is not " +
                "exercising the tail path at all",
            0,
            svc.queue.pendingCount()
        )

        // ── 2. stop() flushes the tail ─────────────────────────────────────────────────────
        svc.stop()
        assertEquals(
            "the remainder of a short session must reach the STT queue at stop()",
            1,
            svc.queue.pendingCount()
        )

        // ── 3. the flushed clip is whole, and belongs to this session ──────────────────────
        svc.queue.stop()
        val waiting = svc.queue.pendingSnapshot()
        assertEquals(1, waiting.size)
        val item = waiting.first()
        assertEquals("a tail clip must still be linked to its session", sessionId, item.sessionId)
        val pcm = readLePcm(File(item.pcmPath))
        assertEquals(
            "the tail must carry the WHOLE session, not a truncated buffer",
            packets * VoiceFormat.SAMPLES_PER_PACKET,
            pcm.size
        )
        assertEquals(0L, item.startMs)
        assertEquals(packets.toLong() * VoiceFormat.PACKET_MS, item.endMs)

        // ── 4. it transcribes, and the words are findable ──────────────────────────────────
        val sentence = "the short reply about the ferry timetable was recorded and kept"
        svc.providers.mock.teach(pcm, sentence)
        svc.providers.override = svc.providers.mock
        assertEquals("the tail clip transcribes in one pass", 1, svc.queue.drainOnce())
        assertEquals("nothing may be left pending", 0, svc.queue.pendingCount())

        val segments = svc.index.segmentsOf(sessionId)
        assertEquals("one segment for the one tail clip", 1, segments.size)
        assertEquals(sentence, segments.first().text)

        val hits = svc.search("ferry timetable")
        assertTrue("a 2 s session must be findable by its words", hits.isNotEmpty())
        assertEquals(sessionId, hits.first().segment.sessionId)

        // ── 5. the session's numbers survive the teardown ──────────────────────────────────
        val after = svc.status()
        assertEquals("status() must still report the session after stop()", sessionId, after["sessionId"])
        assertEquals(packets, after["packets"])
        assertEquals(packets.toLong(), after["archivedPackets"])
        assertEquals(false, after["running"])

        // ⛔ PRIVACY: counts and milliseconds only, never transcript text.
        assertTrue(
            "transcript text must never be logged",
            logLines.none { it.contains(sentence) }
        )
    }

    /**
     * ★ **THE PULL STEP.** `exportSession` is the last link in the only chain that answers the
     * feature's open question ("is there intelligible speech on the left arm?"), and it is the
     * one link a unit test can still reach: everything after it is `adb pull`.
     *
     * What is asserted is exactly what the runbook in `docs/S-VOICE-PIPELINE.md` §7 promises:
     * the raw master lands in the app's EXTERNAL files dir under `voice-export/<id>.g2a`,
     * byte-identical to what was archived, and a decoded `<id>.wav` lands beside it.
     *
     * ⛔ Exported files are recordings. They must never be committed -- `.gitignore` denies the
     * types outright, excepting only the synthetic fixtures this test is built from.
     */
    @Test
    fun `export puts the raw master and a wav where adb pull can reach them`() {
        val raw = javaClass.getResourceAsStream("/voice/fixture-speech.g2a")?.use { it.readBytes() }
        assumeTrue("fixture-speech.g2a not present", raw != null)
        val packets = raw!!.size / VoiceFormat.PACKET_BYTES

        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val svc = VoiceService(context = ctx, decoderFactory = { FakeLc3Decoder() })
        service = svc
        svc.configStore.save(SttConfig(providerKind = SttConfig.KIND_NONE))

        val sessionId = svc.start()
        for (i in 0 until packets) {
            svc.submit(
                raw.copyOfRange(i * VoiceFormat.PACKET_BYTES, (i + 1) * VoiceFormat.PACKET_BYTES),
                "L"
            )
        }
        waitUntil(10_000, "the decode thread caught up") { svc.status()["packets"] == packets }
        svc.stop()

        // `export` with no explicit session picks the newest on disk -- the adb path passes no id.
        assertEquals("the latest session is the one just recorded", sessionId, svc.latestSessionId())

        val written = svc.exportSession(sessionId)
        assertEquals("a .g2a and a .wav", 2, written.size)

        val outDir = File(ctx.getExternalFilesDir(null), VoiceService.EXPORT_DIR)
        val g2a = File(outDir, "$sessionId.g2a")
        val wav = File(outDir, "$sessionId.wav")
        assertTrue("the raw master must be exported to $g2a", g2a.isFile)
        assertTrue(
            "the exported master must be byte-identical to what arrived",
            g2a.readBytes().contentEquals(raw)
        )
        assertTrue("a decoded wav must be exported to $wav", wav.isFile)
        assertEquals(
            "header + 40 packets x 800 samples x 2 bytes",
            (WavWriter.HEADER_BYTES + packets * VoiceFormat.SAMPLES_PER_PACKET * 2).toLong(),
            wav.length()
        )
    }
}
