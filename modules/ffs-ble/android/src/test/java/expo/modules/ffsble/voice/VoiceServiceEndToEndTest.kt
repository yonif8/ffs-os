package expo.modules.ffsble.voice

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * ★ **PACKETS IN, SENTENCE OUT.** The whole S-VOICE phone pipeline in one test.
 *
 * [VoiceService] is the orchestrator: it is the only place where the framer, the decode
 * pipeline, the lossless archive, the clipper, the durable STT queue and the searchable index
 * are wired to one another, and until now it was the one piece with no test of its own. Every
 * part below it is proven separately; NONE of those proofs says the parts are connected the
 * right way round. This file says that.
 *
 * ══ WHAT IS ASSERTED, IN ORDER ══════════════════════════════════════════════════════════════
 *  1. `master.g2a` is byte-identical to the fixture -- 40 packets, ONCE, even though 120 were
 *     submitted (each one on the capture arm twice, plus once on the other arm). The raw master
 *     is the only lossless copy we will ever have of a moment, so "lossless" is checked as
 *     bytes, not as a count.
 *  2. [VoiceService.status] reports the same story in numbers: 40 duplicates dropped by the
 *     framer, 40 packets dropped by the SIDE FILTER, no malformed packets, no overrun anywhere.
 *  3. The clips reached [SttQueue] durably, and draining them wrote segments to the index.
 *  4. A search for words from the MIDDLE of a taught sentence finds it, linked to the session.
 *  5. [VoiceService.deriveWav] re-decodes the archived master into a WAV of exactly the right
 *     length -- which is what makes "keep the packets, decode them better later" a fact rather
 *     than a promise.
 *
 * ══ DETERMINISM, NOT SLEEPS ═════════════════════════════════════════════════════════════════
 * Four threads are in play (binder -> decode -> archive -> upload). Nothing here sleeps for a
 * fixed time. The two async seams are settled by POLLING A CONDITION with a timeout
 * ([waitUntil]), and the upload thread is taken out of the picture entirely: the session runs
 * with `providerKind=none` -- the documented "archive but do not transcribe" steady state, in
 * which clips ACCUMULATE -- and the backlog is then drained by calling [SttQueue.drainOnce]
 * synchronously on this thread. A flaky test is worse than no test.
 *
 * ⚠️ `maxClipSeconds = 1` is set deliberately: the clipper only cuts a clip when it is FULL or
 * when it has seen [VoiceService.SILENCE_PACKETS] consecutive quiet packets, and nothing flushes
 * a partial clip at [VoiceService.stop]. With the stock 20 s ceiling a 2 s fixture would produce
 * no clip at all and there would be nothing to transcribe. At 1 s the 2 s fixture yields exactly
 * two whole clips, so the test asserts a real drain rather than working around one.
 *
 * ⛔ The fixture contains NO human voice and the "sentences" are invented here; see
 * `src/test/resources/voice/README.md`. Nothing in this test touches the network.
 *
 * Run: ./gradlew :ffs-ble:testDebugUnitTest --tests 'expo.modules.ffsble.voice.VoiceServiceEndToEndTest'
 */
@RunWith(RobolectricTestRunner::class)
// ⚠️ Robolectric 4.13 ships android-all jars up to SDK 34 while the app targets 36; without this
// pin the class dies at initializationError before a single assertion runs.
@Config(sdk = [34])
class VoiceServiceEndToEndTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private var service: VoiceService? = null

    /**
     * Point this class's classloader at its OWN copy of the host LC3 library.
     *
     * ⚠️ A JVM refuses to `System.load` the same FILE PATH from two classloaders
     * ("already loaded in another classloader"). Robolectric runs each `@Config` sandbox in its
     * own classloader, so when `VoiceRealDecodeTest` (plain JVM) has already claimed
     * `tools/lc3fixture/out/ffslc3.dll`, the native variant below would skip -- but only when
     * the whole suite runs, and not when this class runs alone. That is the worst kind of skip:
     * invisible, and dependent on what else ran.
     *
     * A byte-identical copy under a different name is a different path, so both classloaders get
     * their own handle. This runs BEFORE anything touches [NativeLc3Decoder] because the load is
     * memoised on first use, and a memoised failure is permanent for the classloader.
     * [NativeLc3Decoder.LIBRARY_PATH_PROPERTY] is a `const val`, so naming it here does not
     * itself load the class.
     */
    @Before
    fun giveThisClassloaderItsOwnCopyOfTheCodec() {
        val orig = System.getProperty(NativeLc3Decoder.LIBRARY_PATH_PROPERTY) ?: return
        val src = File(orig)
        if (!src.isFile) return
        val dst = File(System.getProperty("java.io.tmpdir"), "ffs-robolectric-${src.name}")
        try {
            if (!dst.isFile || dst.length() != src.length()) {
                src.copyTo(dst, overwrite = true)
                dst.deleteOnExit()
            }
        } catch (_: Throwable) {
            return // Fall back to the shared path; the variant will skip loudly if it cannot load.
        }
        System.setProperty(NativeLc3Decoder.LIBRARY_PATH_PROPERTY, dst.absolutePath)
    }

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

    // ── fixtures & helpers ──────────────────────────────────────────────────────────────────

    private fun fixture(): ByteArray? =
        javaClass.getResourceAsStream("/voice/fixture-speech.g2a")?.use { it.readBytes() }

    /**
     * Poll [cond] until it holds or [timeoutMs] elapses. The alternative -- a fixed sleep long
     * enough to "probably" be safe -- is how a suite acquires a test everybody reruns.
     */
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

    // ── the tests ───────────────────────────────────────────────────────────────────────────

    /**
     * The wiring test. [FakeLc3Decoder] on purpose: this file is about whether the parts are
     * connected, and codec QUALITY has its own proof in `VoiceRealDecodeTest`. Using the fake
     * here also keeps the test independent of whether the host `.so` was built.
     */
    @Test
    fun `packets from both lenses become an archive, a transcript and a search hit`() {
        runEndToEnd("fake") { FakeLc3Decoder() }
    }

    /**
     * The same journey with the REAL codec, so that "the orchestrator works" is not quietly
     * conditional on the fake's convenient behaviour. Skips when the host library is absent --
     * see `VoiceRealDecodeTest` for how to build it.
     */
    @Test
    fun `the same journey survives the real LC3 codec`() {
        assumeTrue(
            "REAL LC3 UNAVAILABLE -- this variant did not run " +
                "(${NativeLc3Decoder.unavailableReason}); " +
                "build it with: bash ffs_os/tools/lc3fixture/build-jni-host.sh",
            NativeLc3Decoder.available
        )
        runEndToEnd("native") { NativeLc3Decoder() }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════

    private fun runEndToEnd(label: String, decoderFactory: () -> Lc3Decoder) {
        val raw = fixture()
        assumeTrue("fixture-speech.g2a not present", raw != null)
        val packets = raw!!.size / VoiceFormat.PACKET_BYTES
        assertEquals("the fixture is expected to be 40 whole packets", 40, packets)

        val logLines = java.util.Collections.synchronizedList(ArrayList<String>())
        val svc = VoiceService(
            context = ApplicationProvider.getApplicationContext(),
            log = { logLines.add(it) },
            decoderFactory = decoderFactory
        )
        service = svc

        // ── arrange ────────────────────────────────────────────────────────────────────────
        // `none` is the documented steady state: capture and archive, transcribe nothing, drop
        // nothing. That takes the upload thread out of the timing picture entirely. The 1 s clip
        // ceiling is what makes a 2 s fixture produce whole clips at all (see the class KDoc).
        svc.configStore.save(SttConfig(providerKind = SttConfig.KIND_NONE, maxClipSeconds = 1))

        // ── act ────────────────────────────────────────────────────────────────────────────
        val sessionId = svc.start()
        assertTrue("a session id is minted", sessionId.startsWith("s-"))
        assertTrue(svc.isRunning)

        // Two DIFFERENT lens behaviours, exercised together, once per counter:
        //
        //  * the same L packet TWICE -- a genuine `gap == 0`, which is what the framer's
        //    duplicate rule is for (a retransmit or a re-delivery on the capture arm); and
        //  * the same packet as "R" -- which must never reach the framer at all. ⚠️ The two
        //    arms do NOT carry the same audio: the right arm's encoder ships statistically
        //    pure noise, so VoiceService filters BY SIDE first and counts what it drops. Feeding
        //    R here proves the filter is upstream of both the decode path and the archive.
        assertEquals("the capture arm is the left one", "L", svc.captureSide)
        for (i in 0 until packets) {
            val pkt = raw.copyOfRange(
                i * VoiceFormat.PACKET_BYTES,
                (i + 1) * VoiceFormat.PACKET_BYTES
            )
            svc.submit(pkt, "L")
            svc.submit(pkt.copyOf(), "L") // duplicate on the capture arm
            svc.submit(pkt.copyOf(), "R") // the other arm -- must be dropped before the framer
        }

        // Settle the async seams by condition, never by clock.
        //
        // ⚠️ `status()["packets"]` is not live: VoicePipeline publishes a framer snapshot only
        // every STATS_EVERY (20) processed packets, so waiting on the CLIPS alone can leave the
        // stats one snapshot behind and make this test flaky by exactly 20 or 40 packets. 80 is
        // a multiple of 20, so waiting for the snapshot itself is both deterministic and the
        // strongest available "the decode thread is finished" signal.
        waitUntil(10_000, "the decode thread published its final stats snapshot") {
            svc.status()["packets"] == packets * 2
        }
        waitUntil(10_000, "both clips enqueued") { svc.queue.pendingCount() >= 2 }
        waitUntil(10_000, "40 packets archived") {
            (svc.status()["archivedPackets"] as Long) >= packets.toLong()
        }

        // ⚠️ status() is only meaningful WHILE the session runs: stop() nulls the pipeline and
        // the writer, after which every count it reports reads zero. Snapshot it here.
        val status = svc.status()

        svc.stop()
        assertTrue("stop() must not leave the service running", !svc.isRunning)

        // ── 1. the raw master is lossless, and deduplicated ────────────────────────────────
        val master = File(
            File(File(ApplicationProvider.getApplicationContext<android.content.Context>().filesDir, VoiceService.ROOT_DIR), VoiceArchiveFiles.SESSIONS_DIR),
            "$sessionId/${VoiceArchiveFiles.MASTER_NAME}"
        )
        assertTrue("master.g2a must exist at $master", master.exists())
        assertEquals(
            "120 packets in, 40 on disk -- a duplicate is not more audio, and the other arm is " +
                "not audio at all",
            raw.size.toLong(),
            master.length()
        )
        // Bytes, not just a count: "lossless master" means the wire bytes, unaltered, in order.
        assertTrue(
            "master.g2a must be byte-identical to the fixture",
            master.readBytes().contentEquals(raw)
        )

        // ── 2. the numbers tell the same story ─────────────────────────────────────────────
        assertEquals(true, status["running"])
        assertEquals(sessionId, status["sessionId"])
        // `received` counts every packet OFFERED to the framer, duplicates included. 120 were
        // submitted; 40 were the other arm and never got that far, so 80 reached the framer and
        // 40 of those were duplicates.
        assertEquals("only capture-arm packets reach the framer", packets * 2, status["packets"])
        assertEquals("one duplicate per packet on the capture arm", packets, status["duplicates"])
        assertEquals("L", status["captureSide"])
        assertEquals(
            "every right-arm packet is dropped and counted, never decoded and never archived",
            packets,
            status["otherSidePackets"]
        )
        assertEquals(packets, svc.otherSidePackets)
        assertEquals("no malformed packets", 0, status["malformed"])
        assertEquals("the clean fixture loses nothing", 0, status["lostPackets"])
        assertEquals(0, status["concealedFrames"])
        assertEquals(0, status["resyncs"])
        assertEquals("the decode queue must not have overrun", 0, status["decodeOverruns"])
        assertEquals("the archive queue must not have overrun", 0, svc.archiveOverruns)
        assertEquals(0, status["archiveOverruns"])
        assertEquals(packets.toLong(), status["archivedPackets"])
        assertEquals("with no provider, clips wait -- they are never dropped", 2, status["sttPending"])
        assertEquals("none", status["sttProvider"])

        // ── 3. the backlog drains, deterministically ───────────────────────────────────────
        // Stop the worker FIRST so the only thing draining the queue is this thread. Pending
        // work stays on disk across stop(); that is the durability contract.
        svc.queue.stop()
        val waiting = svc.queue.pendingSnapshot()
        assertEquals("two whole 1 s clips out of a 2 s stream", 2, waiting.size)

        // Teach the mock what each clip "says", keyed off the EXACT bytes the queue durably
        // wrote. Reading them back from disk rather than recomputing them is what makes this
        // independent of the decoder in use -- the same test text lands for fake and native.
        val sentences = listOf(
            "the harbour ferry leaves the eastern pier at quarter past seven every weekday",
            "please bring the spare lens cable and the small screwdriver to the workshop"
        )
        val expectedSamples = VoiceFormat.SAMPLE_RATE // maxClipSeconds = 1
        waiting.sortedBy { it.startMs }.forEachIndexed { i, item ->
            val pcm = readLePcm(File(item.pcmPath))
            assertEquals("clip $i is exactly one second of audio", expectedSamples, pcm.size)
            assertEquals("clip $i belongs to this session", sessionId, item.sessionId)
            svc.providers.mock.teach(pcm, sentences[i])
        }
        assertEquals(2, svc.providers.mock.taughtCount())

        // `override` is the documented test hook on SttProviderFactory; it wins over the config
        // file, which is why the config above can stay at `none` and prove the backlog path.
        svc.providers.override = svc.providers.mock
        assertEquals("both clips transcribe in one pass", 2, svc.queue.drainOnce())
        assertEquals("nothing may be left pending", 0, svc.queue.pendingCount())

        val segments = svc.index.segmentsOf(sessionId)
        assertEquals("one segment per clip", 2, segments.size)
        assertEquals(
            "the taught text is what landed",
            sentences.toSet(),
            segments.map { it.text }.toSet()
        )
        assertTrue(
            "mock output stays labelled `mock` in the archive, forever",
            segments.all { it.provider == MockSttProvider.NAME }
        )

        // ── 4. found by searching for words from the MIDDLE of a sentence ──────────────────
        // Interior words, not a prefix and not the whole string: only an interior phrase proves
        // the text was tokenised and indexed rather than merely stored.
        val hits = svc.search("spare lens cable")
        assertTrue("the taught sentence must be findable", hits.isNotEmpty())
        val hit = hits.first()
        assertEquals(sentences[1], hit.segment.text)
        assertEquals("the hit must link back to this session", sessionId, hit.segment.sessionId)
        assertTrue("the hit carries the session's start time", hit.sessionStartedAtEpochMs > 0)
        assertTrue("a snippet is rendered", hit.snippet.isNotEmpty())

        // A phrase from the OTHER clip must find the other segment -- otherwise "found it" could
        // be satisfied by a single-row table.
        val other = svc.search("eastern pier")
        assertTrue(other.isNotEmpty())
        assertEquals(sentences[0], other.first().segment.text)

        // The session row itself is complete, so a UI can list it.
        val session = svc.sessions().firstOrNull { it.id == sessionId }
        assertNotNull("the session must be listed", session)
        assertEquals(packets, session!!.packets)
        assertEquals(packets.toLong() * VoiceFormat.PACKET_MS, session.durationMs)
        assertNotNull("a stopped session has an end time", session.endedAtEpochMs)

        // ── 5. the archive really can be re-decoded later ──────────────────────────────────
        val wav = tmp.newFile("derived-$label.wav")
        val derived = svc.deriveWav(sessionId, wav)
        assertEquals(packets.toLong(), derived.packetsRead)
        assertEquals(packets.toLong(), derived.chunksWritten)
        assertEquals(packets.toLong() * VoiceFormat.SAMPLES_PER_PACKET, derived.samplesWritten)
        assertEquals(packets.toLong() * VoiceFormat.PACKET_MS, derived.durationMs)
        assertEquals(
            "header + 40 packets x 800 samples x 2 bytes",
            (WavWriter.HEADER_BYTES + packets * VoiceFormat.SAMPLES_PER_PACKET * 2).toLong(),
            wav.length()
        )

        // ⛔ PRIVACY: the service logs counts and milliseconds only. If a transcript, a sample
        // value or a base64 blob ever appears in a log line, it appears here first.
        for (s in sentences) {
            assertTrue("transcript text must never be logged", logLines.none { it.contains(s) })
        }

        println(
            "VOICE E2E [$label]: session=$sessionId submitted=${packets * 3} archived=${master.length()}B " +
                "clips=2 segments=${segments.size} hits=${hits.size} wav=${wav.length()}B"
        )
    }
}
