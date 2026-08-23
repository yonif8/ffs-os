package expo.modules.ffsble.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The WAV header, pinned byte for byte.
 *
 * WHY BYTE-EXACT AND NOT "it opens in a player"
 * ---------------------------------------------
 * `./gradlew :ffs-ble:test` cannot play a file, and the failure mode of a wrong header is not a
 * crash -- it is a file that opens, reports the wrong duration or the wrong rate, and plays at
 * half speed or as static. The only mechanical check available is the one below: the 44 bytes
 * are a known constant for a known sample count, so they are written out here literally, and any
 * drift (a big-endian slip, a forgotten patch at close, a wrong byte rate) fails immediately.
 *
 * ⛔ All PCM here is synthetic. `ffs_os` is PUBLIC.
 */
class WavWriterTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun out(name: String = "out.wav") = File(tmp.root, name)

    /** The canonical 44 bytes for 16 kHz mono s16le with [dataBytes] of audio, written by hand. */
    private fun expectedHeader(dataBytes: Int): ByteArray {
        val h = ByteArray(44)
        fun ascii(off: Int, s: String) { for (i in s.indices) h[off + i] = s[i].code.toByte() }
        fun le16(off: Int, v: Int) {
            h[off] = (v and 0xFF).toByte(); h[off + 1] = ((v ushr 8) and 0xFF).toByte()
        }
        fun le32(off: Int, v: Int) {
            h[off] = (v and 0xFF).toByte()
            h[off + 1] = ((v ushr 8) and 0xFF).toByte()
            h[off + 2] = ((v ushr 16) and 0xFF).toByte()
            h[off + 3] = ((v ushr 24) and 0xFF).toByte()
        }
        ascii(0, "RIFF"); le32(4, 36 + dataBytes); ascii(8, "WAVE")
        ascii(12, "fmt "); le32(16, 16); le16(20, 1); le16(22, 1)
        le32(24, 16000); le32(28, 32000); le16(32, 2); le16(34, 16)
        ascii(36, "data"); le32(40, dataBytes)
        return h
    }

    @Test
    fun `an empty wav is exactly the 44-byte header with zero lengths`() {
        val f = out()
        WavWriter(f).close()
        assertEquals(44L, f.length())
        assertArrayEquals(expectedHeader(0), f.readBytes())
    }

    @Test
    fun `the header matches the canonical layout byte for byte`() {
        val f = out()
        WavWriter(f).use { it.append(ShortArray(800)) }
        val bytes = f.readBytes()
        assertEquals(44 + 1600, bytes.size)
        assertArrayEquals(expectedHeader(1600), bytes.copyOfRange(0, 44))
    }

    @Test
    fun `header() agrees with what the writer actually emits`() {
        val f = out()
        WavWriter(f).use { it.append(ShortArray(160)) }
        assertArrayEquals(WavWriter.header(320), f.readBytes().copyOfRange(0, 44))
    }

    @Test
    fun `samples are little-endian signed 16-bit`() {
        val f = out()
        WavWriter(f).use { it.append(shortArrayOf(0x0102, -1, -32768, 32767)) }
        val d = f.readBytes().copyOfRange(44, 52)
        assertArrayEquals(
            byteArrayOf(
                0x02, 0x01,                       // 0x0102
                0xFF.toByte(), 0xFF.toByte(),     // -1
                0x00, 0x80.toByte(),              // -32768
                0xFF.toByte(), 0x7F               // 32767
            ),
            d
        )
    }

    @Test
    fun `the RIFF and data sizes are patched at close, across many appends`() {
        val f = out()
        val w = WavWriter(f)
        repeat(50) { w.append(ShortArray(VoiceFormat.SAMPLES_PER_PACKET)) }
        w.close()
        val expected = 50 * VoiceFormat.SAMPLES_PER_PACKET * 2
        assertArrayEquals(expectedHeader(expected), f.readBytes().copyOfRange(0, 44))
        assertEquals((44 + expected).toLong(), f.length())
    }

    @Test
    fun `an offset and length append writes only that slice`() {
        val f = out()
        WavWriter(f).use { it.append(shortArrayOf(9, 9, 0x0102, 9), off = 2, len = 1) }
        assertArrayEquals(byteArrayOf(0x02, 0x01), f.readBytes().copyOfRange(44, 46))
    }

    @Test
    fun `counters track what was written`() {
        val f = out()
        val w = WavWriter(f)
        repeat(20) { w.append(ShortArray(VoiceFormat.SAMPLES_PER_PACKET)) }
        assertEquals(16_000L, w.samplesWritten)
        // 20 packets x 50 ms = one second, and the duration arithmetic must agree.
        assertEquals(1_000L, w.durationMs)
        w.close()
    }

    @Test
    fun `appending a chunk uses its sample count, not its array size`() {
        val f = out()
        val chunk = VoiceAudioChunk(
            pcm = ShortArray(VoiceFormat.SAMPLES_PER_PACKET),
            samples = 160,
            ssr = 0, tdoa = 0, concealed = false, tMs = 0L
        )
        WavWriter(f).use { it.append(chunk) }
        assertEquals(44L + 320L, f.length())
    }

    @Test
    fun `close is idempotent`() {
        val f = out()
        val w = WavWriter(f)
        w.append(ShortArray(160))
        w.close()
        w.close()
        assertEquals(44L + 320L, f.length())
    }

    @Test(expected = IllegalStateException::class)
    fun `appending after close is refused rather than silently lost`() {
        val w = WavWriter(out())
        w.close()
        w.append(ShortArray(16))
    }

    @Test
    fun `a file larger than the write buffer still closes to a correct header`() {
        // 10 seconds of audio is comfortably past the 64 KB BufferedOutputStream, so this
        // exercises the case where the header is long out of the buffer by the time close()
        // reopens the file to patch it -- the reason the patch uses a separate RandomAccessFile.
        val f = out()
        val w = WavWriter(f)
        repeat(200) { w.append(ShortArray(800)) }
        w.close()
        assertArrayEquals(expectedHeader(320_000), f.readBytes().copyOfRange(0, 44))
    }
}
