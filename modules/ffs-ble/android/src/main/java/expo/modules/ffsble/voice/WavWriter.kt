package expo.modules.ffsble.voice

import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.io.RandomAccessFile

/**
 * A streaming 16-bit PCM RIFF/WAVE writer -- the DERIVED, disposable side of the archive.
 *
 * WHY A HAND-ROLLED WRITER
 * ------------------------
 * Android has no WAV encoder in the platform (`MediaMuxer` does MP4/WebM, not RIFF), and the
 * format needed here is the simplest one that exists: canonical 44-byte header, no LIST chunk,
 * no fact chunk, mono, s16le, 16 kHz. Pulling a dependency in to emit 44 constant-ish bytes
 * would be the strange choice, and a hand-rolled header can be pinned byte-for-byte by a unit
 * test -- which is exactly what `WavWriterTest` does, because "the file plays" is not something
 * `./gradlew :ffs-ble:test` can check and "the header is these 44 bytes" is.
 *
 * WHY STREAMING, AND WHY THE SIZES ARE PATCHED AT CLOSE
 * -----------------------------------------------------
 * RIFF puts two lengths in the header (`RIFF` chunk size at offset 4, `data` chunk size at
 * offset 40) that cannot be known until the last sample is written. Buffering an entire session
 * in RAM to learn them is not an option -- an hour of 16 kHz mono s16 is 115 MB. So: write a
 * placeholder header, stream the samples, then reopen and patch the two 32-bit fields.
 *
 * ⚠️ **A WAV THAT WAS NEVER [close]D HAS ZERO LENGTHS IN ITS HEADER** and most players will
 * treat it as empty even though every sample is on disk. That is survivable here ONLY because
 * WAVs are derived: the lossless master is the `.g2a` (see [VoiceArchiveFiles]) and any WAV can
 * be regenerated from it. Never make a WAV the only copy of anything.
 *
 * ⛔ PRIVACY: this class writes audio to disk, which is its job -- the caller decides WHERE, and
 * the archive keeps it in app-private storage. It logs nothing at all.
 */
class WavWriter(
    private val file: File,
    private val sampleRate: Int = VoiceFormat.SAMPLE_RATE,
    private val channels: Int = 1
) : Closeable {

    companion object {
        /** Canonical RIFF/WAVE PCM header size. Not a guess -- the layout is fixed below. */
        const val HEADER_BYTES = 44

        /** Bytes per sample, per channel. This writer is s16le only. */
        const val BYTES_PER_SAMPLE = 2

        /** `WAVE_FORMAT_PCM`. Anything else means a `fact` chunk is required; we emit neither. */
        private const val FORMAT_PCM = 1

        /**
         * Build the 44-byte canonical header for a completed file.
         *
         * ```
         *   0  "RIFF"                 4  36 + dataBytes      8  "WAVE"
         *   12 "fmt "                16  16 (PCM fmt size)  20  audioFormat = 1
         *   22 channels              24  sampleRate         28  byteRate
         *   32 blockAlign            34  bitsPerSample = 16 36  "data"
         *   40 dataBytes
         * ```
         *
         * `36` at offset 4 is not a magic number: it is everything after the 8-byte `RIFF`
         * header and before the audio -- 4 ("WAVE") + 8 + 16 (fmt) + 8 (data header) = 36.
         *
         * Every multi-byte field is LITTLE-endian. RIFF is little-endian by definition (RIFX is
         * the big-endian variant and nothing here emits it), so the shifts below are hand-rolled
         * rather than routed through `ByteBuffer` -- one fewer place for a stray
         * `order(BIG_ENDIAN)` to produce a file that is silently unreadable.
         */
        fun header(dataBytes: Int, sampleRate: Int = VoiceFormat.SAMPLE_RATE, channels: Int = 1): ByteArray {
            val blockAlign = channels * BYTES_PER_SAMPLE
            val byteRate = sampleRate * blockAlign
            val h = ByteArray(HEADER_BYTES)
            ascii(h, 0, "RIFF")
            le32(h, 4, 36 + dataBytes)
            ascii(h, 8, "WAVE")
            ascii(h, 12, "fmt ")
            le32(h, 16, 16)
            le16(h, 20, FORMAT_PCM)
            le16(h, 22, channels)
            le32(h, 24, sampleRate)
            le32(h, 28, byteRate)
            le16(h, 32, blockAlign)
            le16(h, 34, BYTES_PER_SAMPLE * 8)
            ascii(h, 36, "data")
            le32(h, 40, dataBytes)
            return h
        }

        private fun ascii(a: ByteArray, off: Int, s: String) {
            for (i in s.indices) a[off + i] = s[i].code.toByte()
        }

        private fun le16(a: ByteArray, off: Int, v: Int) {
            a[off] = (v and 0xFF).toByte()
            a[off + 1] = ((v ushr 8) and 0xFF).toByte()
        }

        private fun le32(a: ByteArray, off: Int, v: Int) {
            a[off] = (v and 0xFF).toByte()
            a[off + 1] = ((v ushr 8) and 0xFF).toByte()
            a[off + 2] = ((v ushr 16) and 0xFF).toByte()
            a[off + 3] = ((v ushr 24) and 0xFF).toByte()
        }
    }

    private var out: OutputStream? = FileOutputStream(file).let { BufferedOutputStream(it, 1 shl 16) }

    /** Reused s16le staging buffer, grown on demand. Chunks are a fixed 800 samples in practice. */
    private var scratch = ByteArray(VoiceFormat.SAMPLES_PER_PACKET * BYTES_PER_SAMPLE)

    /** Total FRAMES written (samples per channel). Milliseconds are `* 1000 / sampleRate`. */
    var samplesWritten: Long = 0L
        private set

    init {
        // Placeholder header: correct in every field except the two lengths, which close()
        // patches. Written eagerly so the file on disk is a WAV from byte zero -- a half-written
        // file is then a SHORT wav, not a headerless blob.
        out!!.write(header(0, sampleRate, channels))
    }

    /** Audio written so far, in ms. */
    val durationMs: Long get() = samplesWritten * 1000L / sampleRate

    /** Append PCM. Cheap enough to call per 50 ms chunk -- the underlying stream is buffered. */
    fun append(pcm: ShortArray, off: Int = 0, len: Int = pcm.size) {
        val o = out ?: throw IllegalStateException("WavWriter is closed")
        if (len <= 0) return
        val need = len * BYTES_PER_SAMPLE
        if (scratch.size < need) scratch = ByteArray(need)
        var w = 0
        for (i in 0 until len) {
            val s = pcm[off + i].toInt()
            scratch[w++] = (s and 0xFF).toByte()
            scratch[w++] = ((s shr 8) and 0xFF).toByte()
        }
        o.write(scratch, 0, need)
        samplesWritten += len
    }

    /** Convenience for the common case. */
    fun append(chunk: VoiceAudioChunk) = append(chunk.pcm, 0, chunk.samples)

    /**
     * Flush, close, then PATCH the two RIFF lengths. Idempotent.
     *
     * The patch is a separate [RandomAccessFile] rather than a seek on the write stream because
     * the write path is a `BufferedOutputStream` -- seeking under a buffer is how you get a
     * header written into the middle of the audio.
     */
    override fun close() {
        val o = out ?: return
        out = null
        o.flush()
        o.close()
        val dataBytes = (samplesWritten * channels * BYTES_PER_SAMPLE).toInt()
        RandomAccessFile(file, "rw").use { raf ->
            raf.seek(4)
            raf.write(intLe(36 + dataBytes))
            raf.seek(40)
            raf.write(intLe(dataBytes))
        }
    }

    private fun intLe(v: Int) = byteArrayOf(
        (v and 0xFF).toByte(),
        ((v ushr 8) and 0xFF).toByte(),
        ((v ushr 16) and 0xFF).toByte(),
        ((v ushr 24) and 0xFF).toByte()
    )
}
