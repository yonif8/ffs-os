package expo.modules.ffsble.voice

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The real LC3 codec: google/liblc3 reached through `libffslc3.so` (see
// `modules/ffs-ble/android/src/main/cpp/ffs_lc3_jni.c`).
//
// ⛔ PRIVACY: nothing in this file logs audio. The classes here carry PCM and LC3 bytes and
// therefore may only ever emit counts and status codes. See VoiceContracts.kt.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Thrown when the native codec cannot be used at all — the `.so` is missing from the APK, was
 * built for the wrong ABI, or liblc3 refused the requested format.
 *
 * This exists so that a packaging mistake surfaces as an ordinary, catchable exception on the
 * caller's own terms. An [UnsatisfiedLinkError] is an [Error], not an [Exception]; if one escapes
 * into the BLE notification callback it kills that thread and the whole audio pipe silently dies.
 * Every entry point below converts link failures into this instead.
 */
class Lc3UnavailableException(message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)

/**
 * The native LC3 **decoder** — one instance per stream.
 *
 * ### The two ways to produce white noise, both structurally prevented here
 *
 * 1. **Decoding 200 bytes as one frame.** A 205-byte mic packet holds *five* 40-byte frames. This
 *    class decodes ONE frame per [decodeFrame] call and refuses a `len` that is not a plausible
 *    LC3 frame size; the five-per-packet loop lives in the framer, in exactly one place.
 * 2. **A fresh decoder per packet.** The LC3 decoder is *stateful*: MDCT overlap-add history, LTPF
 *    pitch filter state, spectral noise-shaping history and the PLC's own model all carry across
 *    frames. Constructing a decoder per packet throws that history away 20 times a second, which
 *    sounds like a dropout on every packet boundary. Construct ONE and keep it for the life of the
 *    stream; [close] it when the stream ends.
 *
 * ### Return codes — `1` IS NOT AN ERROR
 *
 * liblc3 returns `0` for a clean decode and **`1` when packet-loss concealment ran**. A `1` means
 * the output buffer holds valid, synthesised audio — it is a quality signal, not a failure. Only a
 * **negative** value is a failure:
 *
 * | code | meaning                                                        |
 * |-----:|----------------------------------------------------------------|
 * |    0 | decoded normally                                               |
 * |    1 | PLC operated — valid audio                                      |
 * |  -10 | [E_HANDLE] handle is null, closed, or not a decoder             |
 * |  -11 | [E_ARGS] null array, negative index, implausible frame size     |
 * |  -12 | [E_BOUNDS] the window would run off the end of an array         |
 * |  -14 | [E_CODEC] liblc3 rejected the call                              |
 *
 * The negative codes are returned, never thrown: this runs on the BLE callback thread where an
 * exception per bad packet would be far more damaging than a counter.
 *
 * ### Threading
 *
 * The codec state is **not** thread-safe; drive one instance from one thread (the decode thread).
 * [close] is the exception — it is safe to call from anywhere, any number of times, and frees the
 * native arena exactly once.
 */
class NativeLc3Decoder(
    sampleRate: Int = VoiceFormat.SAMPLE_RATE,
    frameUs: Int = VoiceFormat.FRAME_US
) : Lc3Decoder {

    /** PCM samples one [decodeFrame] / [concealFrame] call writes. */
    val samplesPerFrame: Int

    private val handle = AtomicLong(0L)
    private val closed = AtomicBoolean(false)

    init {
        ensureLoaded()
        val n = nativeFrameSamples(sampleRate, frameUs)
        if (n <= 0) {
            throw Lc3UnavailableException(
                "liblc3 rejects sampleRate=$sampleRate frameUs=$frameUs"
            )
        }
        samplesPerFrame = n
        val h = nativeOpenDecoder(sampleRate, frameUs)
        if (h == 0L) {
            throw Lc3UnavailableException(
                "lc3_setup_decoder failed for sampleRate=$sampleRate frameUs=$frameUs"
            )
        }
        handle.set(h)
    }

    /**
     * Decode ONE LC3 frame. [len] is 40 for the G2 mic; it is passed through rather than assumed
     * because `enc_len` is a firmware variable.
     *
     * Writes [samplesPerFrame] shorts to `out[outOff]`. Returns liblc3's result verbatim — see the
     * table in the class doc, and remember that `1` is good audio.
     */
    override fun decodeFrame(src: ByteArray, off: Int, len: Int, out: ShortArray, outOff: Int): Int {
        val h = handle.get()
        if (h == 0L) return E_HANDLE
        return nativeDecodeFrame(h, src, off, len, out, outOff)
    }

    /**
     * Synthesise one lost frame (`lc3_decode(dec, NULL, 0, …)`), writing [samplesPerFrame] shorts
     * to `out[outOff]`. Normally returns `1`.
     *
     * This is the payoff of the persistent-decoder rule: concealment is extrapolated from the
     * state the frames that *did* arrive left behind, so a fresh decoder would conceal from
     * nothing and emit silence or noise. Conceal a handful of frames, not a second of them —
     * beyond a few frames the framer should resync instead.
     */
    override fun concealFrame(out: ShortArray, outOff: Int): Int {
        val h = handle.get()
        if (h == 0L) return E_HANDLE
        return nativeConceal(h, out, outOff)
    }

    /** Idempotent. Frees the native arena exactly once; later calls are no-ops. */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val h = handle.getAndSet(0L)
        if (h != 0L) nativeCloseDecoder(h)
    }

    companion object {
        // Shim error codes, mirrored from ffs_lc3_jni.c.
        const val E_HANDLE = -10
        const val E_ARGS = -11
        const val E_BOUNDS = -12
        const val E_CODEC = -14

        /** liblc3's "packet-loss concealment ran"; valid audio. */
        const val RC_PLC = 1

        /**
         * System property naming an absolute path to the native library, tried when
         * `System.loadLibrary` finds nothing. This is how the plain-JVM unit tests on a dev box
         * load a host-built `ffslc3.dll` / `libffslc3.so` (see `tools/lc3fixture/build-jni-host.sh`)
         * and exercise the REAL codec instead of a fake. Unused on device.
         */
        const val LIBRARY_PATH_PROPERTY = "ffs.lc3.library"

        private var loadError: Throwable? = null
        private val loaded: Boolean by lazy { tryLoad() }

        private fun tryLoad(): Boolean {
            try {
                System.loadLibrary("ffslc3")
                return true
            } catch (t: Throwable) {
                loadError = t
            }
            val explicit = System.getProperty(LIBRARY_PATH_PROPERTY)
            if (!explicit.isNullOrBlank()) {
                try {
                    System.load(explicit)
                    loadError = null
                    return true
                } catch (t: Throwable) {
                    loadError = t
                }
            }
            return false
        }

        /**
         * True when the native codec is usable in this process. Check it before constructing, or
         * catch [Lc3UnavailableException] — either is fine, but do not let the load failure reach
         * the BLE thread as an [UnsatisfiedLinkError].
         */
        val available: Boolean get() = loaded

        /** Why [available] is false, for a log line. Null when the library loaded. */
        val unavailableReason: String?
            get() = if (loaded) null else (loadError?.toString() ?: "libffslc3 not loaded")

        internal fun ensureLoaded() {
            if (!loaded) {
                throw Lc3UnavailableException(
                    "libffslc3 unavailable: ${unavailableReason}", loadError
                )
            }
        }

        // -- JNI ---------------------------------------------------------------------------
        // Symbols: Java_expo_modules_ffsble_voice_NativeLc3Decoder_*. The encoder entry points
        // live on this class too so there is one JNI surface and one prefix to keep in sync.

        @JvmStatic external fun nativeOpenDecoder(sampleRate: Int, frameUs: Int): Long
        @JvmStatic external fun nativeCloseDecoder(ptr: Long)
        @JvmStatic external fun nativeDecodeFrame(
            ptr: Long, src: ByteArray, off: Int, len: Int, out: ShortArray, outOff: Int
        ): Int
        @JvmStatic external fun nativeConceal(ptr: Long, out: ShortArray, outOff: Int): Int

        @JvmStatic external fun nativeOpenEncoder(sampleRate: Int, frameUs: Int): Long
        @JvmStatic external fun nativeCloseEncoder(ptr: Long)
        @JvmStatic external fun nativeEncodeFrame(
            ptr: Long, pcm: ShortArray, pcmOff: Int, frameBytes: Int, out: ByteArray, outOff: Int
        ): Int

        /** `lc3_frame_samples` — the codec's own opinion of the frame geometry. */
        @JvmStatic external fun nativeFrameSamples(sampleRate: Int, frameUs: Int): Int
    }
}

/**
 * The native LC3 **encoder**. Not part of the receive path — the glasses do the encoding — but the
 * whole reason it is compiled in:
 *
 * - an **on-device self-test** can round-trip synthetic PCM (encode → 40-byte frames → pack five
 *   per packet → decode) and prove the codec works on the phone **without a real recording ever
 *   existing**, which is the only privacy-safe way to test this pipeline on a device; and
 * - the host fixture generator (`tools/lc3fixture/mkfixture.c`) produces its `.g2a` fixtures with
 *   the same liblc3 sources, so device and desk agree by construction.
 *
 * Same rules as the decoder: one instance per stream, stateful, single-threaded, [close] is
 * idempotent. `frameBytes` is the target size of the encoded frame — pass
 * [VoiceFormat.FRAME_BYTES] (40) to match what the glasses emit.
 */
class NativeLc3Encoder(
    sampleRate: Int = VoiceFormat.SAMPLE_RATE,
    frameUs: Int = VoiceFormat.FRAME_US
) : java.io.Closeable {

    /** PCM samples one [encodeFrame] call consumes. */
    val samplesPerFrame: Int

    private val handle = AtomicLong(0L)
    private val closed = AtomicBoolean(false)

    init {
        NativeLc3Decoder.ensureLoaded()
        val n = NativeLc3Decoder.nativeFrameSamples(sampleRate, frameUs)
        if (n <= 0) {
            throw Lc3UnavailableException(
                "liblc3 rejects sampleRate=$sampleRate frameUs=$frameUs"
            )
        }
        samplesPerFrame = n
        val h = NativeLc3Decoder.nativeOpenEncoder(sampleRate, frameUs)
        if (h == 0L) {
            throw Lc3UnavailableException(
                "lc3_setup_encoder failed for sampleRate=$sampleRate frameUs=$frameUs"
            )
        }
        handle.set(h)
    }

    /**
     * Encode [samplesPerFrame] shorts from `pcm[pcmOff]` into [frameBytes] bytes at `out[outOff]`.
     * Returns `0` on success, or one of the negative `NativeLc3Decoder.E_*` codes.
     */
    fun encodeFrame(
        pcm: ShortArray,
        pcmOff: Int,
        frameBytes: Int,
        out: ByteArray,
        outOff: Int
    ): Int {
        val h = handle.get()
        if (h == 0L) return NativeLc3Decoder.E_HANDLE
        return NativeLc3Decoder.nativeEncodeFrame(h, pcm, pcmOff, frameBytes, out, outOff)
    }

    /** Idempotent. */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val h = handle.getAndSet(0L)
        if (h != 0L) NativeLc3Decoder.nativeCloseEncoder(h)
    }
}
