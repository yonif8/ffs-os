package expo.modules.ffsble.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * ★ **THE REAL CODEC, THROUGH OUR OWN KOTLIN.**
 *
 * Every other decode test in this suite runs [FakeLc3Decoder], which proves the FRAMING and the
 * THREADING but says nothing about audio: a fake decoder is equally happy with five 40-byte
 * frames and with one 200-byte blob. The "five frames through ONE persistent decoder" rule --
 * the single most expensive thing to get wrong in this feature -- had been demonstrated only by
 * a host C harness and by a throwaway script. Neither is checked in, so neither can regress
 * loudly. THIS file is the checked-in version: real liblc3, driven through the real
 * [VoicePipeline], measured against the pre-encode reference PCM.
 *
 * ══ WHAT IS ACTUALLY BEING MEASURED ═════════════════════════════════════════════════════════
 * `fixture-speech.ref.wav` is the signal that went INTO the encoder. A correct decode of
 * `fixture-speech.g2a` must come back out looking like it, delayed by LC3's algorithmic delay
 * (~2.5 ms = 40 samples at 16 kHz). "Looking like it" is normalised cross-correlation, searched
 * over lags 0..160 samples -- a scale-free, offset-free similarity that is 1.0 for a perfect
 * match and hovers around 0 for unrelated signals. Lossy-codec output will never be
 * bit-identical, so a byte comparison is the wrong instrument; correlation is the right one.
 *
 * ══ WHY THE FAILING CASE IS HALF THE EVIDENCE ═══════════════════════════════════════════════
 * A single "0.97, therefore good" number proves nothing unless you know what BAD looks like on
 * the same scale. The `wrong way` test below deliberately commits the documented mistake and
 * pins the result near zero. The PAIR of numbers is the evidence: the contract is what
 * separates 0.98 from 0.04, and it is not a coincidence of tolerances.
 *
 * ══ SKIPPING IS NOT PASSING ═════════════════════════════════════════════════════════════════
 * The real codec is reached through a HOST build of the JNI shim
 * (`bash tools/lc3fixture/build-jni-host.sh` -> `tools/lc3fixture/out/ffslc3.dll`, gitignored),
 * handed to the JVM as the `ffs.lc3.library` system property by `build.gradle`. A fresh clone
 * has no such file, so this class ASSUMES it away rather than failing -- but every skip prints
 * a banner naming the missing library and the command that builds it, and every run prints the
 * measured numbers. A silent green is not one of the outcomes.
 *
 * ⛔ The fixtures contain NO human voice; see `src/test/resources/voice/README.md`.
 *
 * Run: ./gradlew :ffs-ble:testDebugUnitTest --tests 'expo.modules.ffsble.voice.VoiceRealDecodeTest'
 */
class VoiceRealDecodeTest {

    companion object {
        /**
         * Reference numbers from the host C harness on this exact fixture pair, kept here so
         * drift is legible rather than mysterious: correct 0.9786, wrong 0.0415, gaps 0.7489.
         * The assertions below sit well inside those, because the point of a threshold is to
         * catch the CONTRACT breaking, not to catch liblc3 being recompiled.
         */
        private const val HOST_CORR_CORRECT = 0.9786
        private const val HOST_CORR_WRONG = 0.0415
        private const val HOST_CORR_GAPS = 0.7489

        /** Widest lag searched, in samples. LC3's delay here is 40; 160 is four times the margin. */
        private const val MAX_LAG = 160
    }

    // ── environment ─────────────────────────────────────────────────────────────────────────

    /**
     * Skip-with-a-banner. Called first in every test so that a skipped run is impossible to read
     * as a passing one -- JUnit prints assumption failures quietly, so we print loudly ourselves.
     */
    private fun requireRealCodec() {
        if (!NativeLc3Decoder.available) {
            println(
                "\n" +
                    "  ############################################################\n" +
                    "  ##  VoiceRealDecodeTest SKIPPED -- THE REAL CODEC DID NOT  ##\n" +
                    "  ##  LOAD, SO NOTHING IN THIS FILE WAS PROVEN.              ##\n" +
                    "  ##  reason: " + NativeLc3Decoder.unavailableReason + "\n" +
                    "  ##  fix:    bash ffs_os/tools/lc3fixture/build-jni-host.sh\n" +
                    "  ############################################################\n"
            )
        }
        assumeTrue(
            "REAL LC3 UNAVAILABLE -- THIS TEST DID NOT RUN (" +
                NativeLc3Decoder.unavailableReason +
                "); build it with: bash ffs_os/tools/lc3fixture/build-jni-host.sh",
            NativeLc3Decoder.available
        )
    }

    // ── fixture loading ─────────────────────────────────────────────────────────────────────

    private fun bytes(name: String): ByteArray? =
        javaClass.getResourceAsStream("/voice/$name")?.use { it.readBytes() }

    private fun text(name: String): String? =
        javaClass.getResourceAsStream("/voice/$name")?.use { String(it.readBytes(), Charsets.UTF_8) }

    /** `dropped_indices` from a manifest, as a set. */
    private fun droppedIndices(json: String): Set<Int> {
        val body = Regex("\"dropped_indices\"\\s*:\\s*\\[([^\\]]*)\\]").find(json)
            ?.groupValues?.get(1)?.trim() ?: return emptySet()
        if (body.isEmpty()) return emptySet()
        return body.split(",").map { it.trim().toInt() }.toSet()
    }

    /**
     * The reference PCM. `fixture-speech.ref.wav` is a canonical 44-byte-header s16le mono WAV
     * written by the same generator, so the header is skipped rather than parsed -- and the size
     * is checked against [WavWriter.HEADER_BYTES] so a format change cannot go unnoticed.
     */
    private fun referencePcm(): ShortArray? {
        val wav = bytes("fixture-speech.ref.wav") ?: return null
        assertTrue("ref wav is too short to be a WAV", wav.size > WavWriter.HEADER_BYTES)
        val n = (wav.size - WavWriter.HEADER_BYTES) / 2
        val out = ShortArray(n)
        for (i in 0 until n) {
            val lo = wav[WavWriter.HEADER_BYTES + i * 2].toInt() and 0xFF
            val hi = wav[WavWriter.HEADER_BYTES + i * 2 + 1].toInt() and 0xFF
            out[i] = ((hi shl 8) or lo).toShort()
        }
        return out
    }

    // ── measurement ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalised cross-correlation of [b] against [a] at a fixed [lag], i.e. how well
     * `b[i + lag]` predicts `a[i]`. Scale-free by construction, so a codec gain difference does
     * not register as damage. Hand-rolled deliberately: this suite takes no maths dependency,
     * and a dozen lines of dot product is easier to audit than one.
     */
    private fun ncc(a: ShortArray, b: ShortArray, lag: Int): Double {
        val n = minOf(a.size, b.size - lag)
        if (n <= 0) return 0.0
        var num = 0.0
        var da = 0.0
        var db = 0.0
        for (i in 0 until n) {
            val x = a[i].toDouble()
            val y = b[i + lag].toDouble()
            num += x * y
            da += x * x
            db += y * y
        }
        if (da <= 0.0 || db <= 0.0) return 0.0
        return num / Math.sqrt(da * db)
    }

    /** Best [ncc] over lags `0..`[MAX_LAG], with the lag that produced it. */
    private fun bestNcc(a: ShortArray, b: ShortArray): Pair<Double, Int> {
        var best = -1.0
        var bestLag = 0
        for (lag in 0..MAX_LAG) {
            val c = ncc(a, b, lag)
            if (c > best) {
                best = c
                bestLag = lag
            }
        }
        return best to bestLag
    }

    private fun concat(chunks: List<VoiceAudioChunk>): ShortArray {
        val out = ShortArray(chunks.sumOf { it.samples })
        var o = 0
        for (c in chunks) {
            System.arraycopy(c.pcm, 0, out, o, c.samples)
            o += c.samples
        }
        return out
    }

    // ── the pipeline under test ─────────────────────────────────────────────────────────────

    /** What one full run through [VoicePipeline] produced. */
    private class Run(
        val chunks: List<VoiceAudioChunk>,
        val pcm: ShortArray,
        val stats: VoiceFramerStats,
        val overruns: Int,
        val decodersConstructed: Int
    )

    /**
     * Push every packet of [raw] through a REAL [VoicePipeline] with a REAL [NativeLc3Decoder],
     * counting how many decoders the pipeline decides it needs.
     *
     * ⛔ The count is an assertion target, not a diagnostic. One decoder for the whole stream is
     * the contract; a fresh decoder per packet throws away MDCT overlap, LTPF and PLC history
     * twenty times a second and sounds like a dropout on every packet boundary.
     */
    private fun runPipeline(raw: ByteArray): Run {
        val chunks = ArrayList<VoiceAudioChunk>()
        val constructed = AtomicInteger(0)
        val sink = object : VoiceSink {
            override fun onChunk(chunk: VoiceAudioChunk) {
                chunks.add(chunk)
            }

            override fun onStats(stats: VoiceFramerStats) {}
        }
        val p = VoicePipeline(
            decoderFactory = {
                constructed.incrementAndGet()
                NativeLc3Decoder()
            },
            sink = sink,
            capacity = 4096
        )
        p.start()
        var off = 0
        while (off + VoiceFormat.PACKET_BYTES <= raw.size) {
            p.submit(raw.copyOfRange(off, off + VoiceFormat.PACKET_BYTES), "R")
            off += VoiceFormat.PACKET_BYTES
        }
        p.stop()
        return Run(chunks, concat(chunks), p.stats(), p.overruns, constructed.get())
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════
    // ★ THE HEADLINE: the contract, measured
    // ═════════════════════════════════════════════════════════════════════════════════════════

    @Test
    fun `the right way -- five 40-byte frames through one persistent decoder -- reproduces the reference`() {
        requireRealCodec()
        val raw = bytes("fixture-speech.g2a")
        val ref = referencePcm()
        assumeTrue("fixture-speech.{g2a,ref.wav} not present", raw != null && ref != null)

        val packets = raw!!.size / VoiceFormat.PACKET_BYTES
        val run = runPipeline(raw)

        // Geometry first: 40 packets x 5 frames x 160 samples = 32000 samples of 16 kHz mono.
        assertEquals("one chunk per packet", packets, run.chunks.size)
        assertEquals(
            "40 packets x 800 samples",
            packets * VoiceFormat.SAMPLES_PER_PACKET,
            run.pcm.size
        )
        assertEquals("the reference is the same length", ref!!.size, run.pcm.size)
        assertEquals(0, run.stats.malformed)
        assertEquals(0, run.stats.lostPackets)
        assertEquals(0, run.overruns)

        // ⛔ ONE decoder for the whole stream. Not one per packet, not one per frame.
        assertEquals("exactly one decoder for the stream", 1, run.decodersConstructed)

        val (corr, lag) = bestNcc(ref, run.pcm)
        println(
            "REAL-LC3 correct path: samples=" + run.pcm.size +
                " corr=" + "%.4f".format(corr) + " at lag=" + lag +
                " (host harness: " + "%.4f".format(HOST_CORR_CORRECT) + " at 40)"
        )

        // The host harness measured 0.9786 at lag 40. 0.90 is safely below that and
        // astronomically above the ~0.04 the wrong path yields, so this catches the contract
        // breaking without being a tripwire for a codec rebuild.
        assertTrue(
            "decoded audio must reproduce the pre-encode reference (corr=$corr at lag=$lag, want > 0.90)",
            corr > 0.90
        )
        // The delay is LC3's, and it is small: a best lag out at the edge of the search window
        // would mean we are correlating with something other than alignment.
        assertTrue("best lag $lag should be near LC3's ~40-sample delay", lag in 0..80)
    }

    @Test
    fun `the wrong way -- 200 bytes handed to the decoder as ONE frame -- produces noise`() {
        requireRealCodec()
        val raw = bytes("fixture-speech.g2a")
        val ref = referencePcm()
        assumeTrue("fixture-speech.{g2a,ref.wav} not present", raw != null && ref != null)

        // This deliberately bypasses VoicePipeline, because the pipeline CANNOT make this
        // mistake -- the five-frame loop lives in exactly one place and that is the point. What
        // is reproduced here is the mistake every other implementation of this pipe has made:
        // treat the 200-byte LC3 region as a single frame. liblc3 accepts it (200 is a legal
        // frame size at other bitrates), returns success, and emits ONE 160-sample frame of
        // garbage per packet.
        val packets = raw!!.size / VoiceFormat.PACKET_BYTES
        val decoder = NativeLc3Decoder()
        val out: ShortArray
        val perPacket: Int
        try {
            perPacket = decoder.samplesPerFrame
            val frame = ShortArray(perPacket)
            val acc = ShortArray(packets * perPacket)
            for (i in 0 until packets) {
                val rc = decoder.decodeFrame(
                    raw,
                    i * VoiceFormat.PACKET_BYTES,
                    VoiceFormat.LC3_BYTES, // ⛔ 200, not 40. THE bug, on purpose.
                    frame,
                    0
                )
                assertTrue(
                    "the wrong call must be ACCEPTED by liblc3 -- that is exactly why it is " +
                        "dangerous, it never errors (rc=$rc)",
                    rc >= 0
                )
                System.arraycopy(frame, 0, acc, i * perPacket, perPacket)
            }
            out = acc
        } finally {
            decoder.close()
        }

        val (corr, lag) = bestNcc(ref!!, out)
        println(
            "REAL-LC3 WRONG path (200 B as one frame): samples=" + out.size +
                " corr=" + "%.4f".format(corr) + " at lag=" + lag +
                " (host harness: " + "%.4f".format(HOST_CORR_WRONG) + ")"
        )

        // A fifth of the audio, because one frame came out where five should have.
        assertEquals("one frame per packet instead of five", packets * perPacket, out.size)
        assertEquals("exactly one fifth of the correct sample count", ref.size / 5, out.size)

        // ★ The contrast IS the evidence. Same fixture, same codec, same reference -- only the
        // framing differs, and the similarity collapses from ~0.98 to ~0.04.
        assertTrue(
            "decoding 200 bytes as one frame must NOT resemble the reference (corr=$corr, want < 0.3)",
            corr < 0.3
        )
    }

    @Test
    fun `a lossy stream still recovers its timeline, with real PLC in the small holes`() {
        requireRealCodec()
        val raw = bytes("fixture-gaps.g2a")
        val manifest = text("fixture-gaps.json")
        val ref = referencePcm()
        assumeTrue("fixture-gaps.{g2a,json} not present", raw != null && manifest != null)
        assertNotNull("fixture-speech.ref.wav is the reference for the gaps fixture too", ref)

        val dropped = droppedIndices(manifest!!)
        assumeTrue("the gaps manifest lists no drops", dropped.isNotEmpty())

        val run = runPipeline(raw!!)
        val delivered = raw.size / VoiceFormat.PACKET_BYTES

        // The manifest's loss count, recovered from byte 204 alone -- the only loss signal the
        // real link gives us.
        assertEquals(
            "framer must recover the manifest's loss count",
            dropped.size,
            run.stats.lostPackets
        )
        assertTrue("PLC frames must have been emitted", run.stats.concealed > 0)
        val concealChunks = run.stats.concealed / VoiceFormat.FRAMES_PER_PACKET
        assertEquals(
            "one chunk per real packet plus one per concealed packet",
            delivered + concealChunks,
            run.chunks.size
        )
        assertEquals(concealChunks, run.chunks.count { it.concealed })
        assertEquals("exactly one decoder for the stream", 1, run.decodersConstructed)

        // Work out from the manifest which runs of drops get concealed and which resync, then
        // splice the reference the same way: the pipeline deliberately does NOT fabricate audio
        // across an oversized hole (VoiceFramer.MAX_CONCEAL_GAP), so the reference must have
        // that hole cut out of it too before the two can be compared at all.
        val runs = ArrayList<IntRange>()
        var start = -1
        for (i in 0..(dropped.max() + 1)) {
            if (i in dropped) {
                if (start < 0) start = i
            } else if (start >= 0) {
                runs.add(start until i)
                start = -1
            }
        }
        val oversized = runs.filter { it.count() + 1 > VoiceFramer.MAX_CONCEAL_GAP }
        assertEquals("one oversized hole is expected in this fixture", 1, oversized.size)
        val resyncedAway = oversized.flatMap { it.toList() }.toSet()

        val totalPackets = ref!!.size / VoiceFormat.SAMPLES_PER_PACKET
        val spliced = ShortArray((totalPackets - resyncedAway.size) * VoiceFormat.SAMPLES_PER_PACKET)
        var o = 0
        for (i in 0 until totalPackets) {
            if (i in resyncedAway) continue
            System.arraycopy(
                ref, i * VoiceFormat.SAMPLES_PER_PACKET,
                spliced, o, VoiceFormat.SAMPLES_PER_PACKET
            )
            o += VoiceFormat.SAMPLES_PER_PACKET
        }
        assertEquals(
            "the spliced reference must match what the pipeline emitted",
            spliced.size,
            run.pcm.size
        )

        val (corr, lag) = bestNcc(spliced, run.pcm)
        println(
            "REAL-LC3 gaps path: lost=" + run.stats.lostPackets + "/" + totalPackets +
                " concealed=" + run.stats.concealed + "fr resyncs=" + run.stats.resyncs +
                " samples=" + run.pcm.size +
                " corr=" + "%.4f".format(corr) + " at lag=" + lag +
                " (host harness: " + "%.4f".format(HOST_CORR_GAPS) + ")"
        )

        // The host harness measured 0.7489 with 14 of 40 packets missing. 0.50 is a conservative
        // floor: a decoder concealing from nothing (the fresh-decoder-per-packet bug) collapses
        // far below it, while ordinary PLC drift does not.
        assertTrue(
            "a stream with ${dropped.size}/$totalPackets packets lost must still track the " +
                "reference (corr=$corr at lag=$lag, want > 0.50)",
            corr > 0.50
        )
    }
}
