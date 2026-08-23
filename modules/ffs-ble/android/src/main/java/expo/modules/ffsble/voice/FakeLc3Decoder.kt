package expo.modules.ffsble.voice

import java.util.concurrent.atomic.AtomicInteger

/**
 * A deterministic stand-in for [Lc3Decoder].
 *
 * ⛔⛔ **THIS IS NOT A CODEC.** It does not implement LC3, it does not implement any part of
 * LC3, and its output is not audio. Feeding a real 40-byte LC3 frame in gets a reproducible
 * pseudo-random pattern out, not speech. If this class is ever wired into a shipping path the
 * wearer hears (or an STT provider is sent) noise. It lives in `main` rather than `test` for
 * exactly one reason, stated below -- not because it is a fallback.
 *
 * WHY IT LIVES IN `main`
 * ----------------------
 * The real decoder is liblc3 behind JNI. A JNI decoder cannot load on the desktop JVM that
 * `./gradlew :ffs-ble:test` runs on, and it cannot run in a phone-side self-test either without
 * dragging the native library into whatever is doing the testing. But the interesting bugs in
 * this pipeline are NOT in the codec: they are in ORDERING, GAP HANDLING, DEDUP, THREAD
 * HAND-OFF and SHUTDOWN. Those are provable with any deterministic function of the frame bytes,
 * and provable *on-device* too if [VoicePipeline] is ever asked to self-test. So the fake is a
 * first-class, permanently-shipped test instrument rather than test-source-set-only code.
 *
 * WHAT IT GUARANTEES, and therefore what a test can assert
 * --------------------------------------------------------
 * * `decodeFrame` is a PURE function of the 40 payload bytes -- so a test can compute the
 *   expected 160 samples with [pcmForFrame] and demand byte-exact equality. That is what turns
 *   "the packets came out in order" from a hand-wave into an assertion.
 * * `concealFrame` writes [CONCEAL_SAMPLE] to every sample, a constant no real frame will ever
 *   produce, so "was this stretch concealed?" is decidable by looking at one sample
 *   ([isConcealFrame]). PLC placement is therefore testable to the sample.
 * * [created] counts constructions process-wide, so a test can PROVE the pipeline builds
 *   exactly ONE decoder for the whole stream -- the "fresh instance per packet" mistake is the
 *   second documented way to turn this pipe into white noise, and a counter is the only way to
 *   catch it from the outside.
 * * [closed] flips on `close()`, so clean-shutdown tests can prove the decoder was released and
 *   released once.
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL
 * -----------------------------------
 * Real LC3 carries decoder state ACROSS frames, and concealment is synthesised from the state
 * the arriving frames left behind. This fake is stateless in its OUTPUT on purpose: state would
 * make the expected PCM depend on the entire history, and the assertions would stop being
 * readable. [framesDecoded] / [framesConcealed] are kept only as counters. So: this fake proves
 * plumbing, never audio quality. Audio quality needs the real decoder and a real recording.
 */
class FakeLc3Decoder : Lc3Decoder {

    companion object {
        /**
         * The value every concealed sample gets. Chosen to be loud, alternating-bit
         * (`0x5AA5`) and nowhere near anything [pcmForFrame] emits, so a concealed stretch is
         * unmistakable both to an assertion and to a human staring at a sample dump.
         */
        const val CONCEAL_SAMPLE: Short = 0x5AA5

        /**
         * How many [FakeLc3Decoder]s have been constructed in this process, ever.
         *
         * The pipeline contract is ONE decoder per stream lifetime. Nothing inside the pipeline
         * can assert that about itself; a process-wide counter can. Tests read it before and
         * after and demand a delta of exactly 1.
         */
        val created = AtomicInteger(0)

        /**
         * The exact PCM [decodeFrame] will produce for a frame -- the oracle a test compares
         * against.
         *
         * FNV-1a over the payload bytes seeds a plain LCG. Both are chosen for being trivially
         * re-derivable by hand from this source and having no library dependency; neither is
         * cryptographic and neither needs to be. The only properties that matter are
         * determinism and that two different frames essentially never collide.
         */
        fun pcmForFrame(src: ByteArray, off: Int, len: Int): ShortArray {
            val out = ShortArray(VoiceFormat.SAMPLES_PER_FRAME)
            pcmForFrame(src, off, len, out, 0)
            return out
        }

        /** [pcmForFrame] writing into a caller-owned buffer, which is what the hot path uses. */
        fun pcmForFrame(src: ByteArray, off: Int, len: Int, out: ShortArray, outOff: Int) {
            var h = 0x811C9DC5.toInt()
            for (i in 0 until len) {
                h = (h xor (src[off + i].toInt() and 0xFF)) * 0x01000193
            }
            var state = h
            for (i in 0 until VoiceFormat.SAMPLES_PER_FRAME) {
                state = state * 1664525 + 1013904223
                // Take the high half: the low bits of an LCG are notoriously non-random, and a
                // sample stream that alternates in an obvious pattern would make a collision
                // between two different frames far more likely than the hash suggests.
                out[outOff + i] = ((state ushr 16) and 0xFFFF).toShort()
            }
        }

        /** True if the 160 samples at [off] are a concealed frame this fake produced. */
        fun isConcealFrame(pcm: ShortArray, off: Int): Boolean {
            for (i in 0 until VoiceFormat.SAMPLES_PER_FRAME) {
                if (pcm[off + i] != CONCEAL_SAMPLE) return false
            }
            return true
        }
    }

    /** Frames handed real payload bytes. */
    @Volatile
    var framesDecoded: Int = 0
        private set

    /** Frames synthesised by [concealFrame]. */
    @Volatile
    var framesConcealed: Int = 0
        private set

    /** Set by [close]. A second `close()` is counted in [closes] rather than ignored silently. */
    @Volatile
    var closed: Boolean = false
        private set

    /** How many times [close] was called -- shutdown-idempotence tests read this. */
    @Volatile
    var closes: Int = 0
        private set

    init {
        created.incrementAndGet()
    }

    /**
     * @return `0`, mirroring liblc3's "decoded" result. Returns `-1` for a wrong-length frame,
     *   mirroring liblc3's "bad parameters", so the pipeline's error path is exercisable.
     */
    override fun decodeFrame(src: ByteArray, off: Int, len: Int, out: ShortArray, outOff: Int): Int {
        if (len != VoiceFormat.FRAME_BYTES) return -1
        pcmForFrame(src, off, len, out, outOff)
        framesDecoded++
        return 0
    }

    /**
     * @return `1` -- liblc3's "PLC ran and the output is VALID AUDIO, not an error". Treating
     *   that `1` as a failure is a real trap in the C API and the reason it is restated here.
     */
    override fun concealFrame(out: ShortArray, outOff: Int): Int {
        for (i in 0 until VoiceFormat.SAMPLES_PER_FRAME) out[outOff + i] = CONCEAL_SAMPLE
        framesConcealed++
        return 1
    }

    override fun close() {
        closes++
        closed = true
    }
}
