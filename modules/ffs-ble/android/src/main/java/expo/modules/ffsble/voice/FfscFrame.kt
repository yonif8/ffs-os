package expo.modules.ffsble.voice

import java.util.zip.CRC32

/**
 * The phone's encoder for the "FFSC" phone->app data channel, and its FXP1 envelope.
 *
 * ⛔ THE LAYOUT LIVES IN THREE PLACES AND THEY ARE CHECKED AGAINST EACH OTHER, never each
 * against itself: `g2flash/tools/ffsc_ref.py` is the spec + reference encoder,
 * `g2flash/patches/ffs_data.h` is the on-glass parser, and this file is the phone's
 * encoder. `ffsc_ref.py --emit-json` writes the golden vectors this file's test pins to.
 * Change the layout in one commit or not at all.
 *
 * FFSC frame (v1) -- little-endian, byte-packed, carried as an ordinary FXP1 body:
 *
 *     0x00  char[4]  "FFSC"
 *     0x04  u8       ver = 1
 *     0x05  u8       op          0 = PUT, 1 = CLEAR
 *     0x06  u16      appId       1..0xFFFE, the ffs_appload.h slot key
 *     0x08  u16      seq         phone-assigned, wraps; identifies THIS value
 *     0x0a  u16      blobLen     bytes after the header (0 for CLEAR)
 *     0x0c  u32      blobCrc32   CRC-32 (zlib) of those bytes
 *     0x10  blob[blobLen]
 *
 * ⚠️ BUMP `seq` BETWEEN PUSHES. The glasses treat a byte-identical value under the same
 *    seq as a duplicate: nothing copied, nothing repainted. Correct behaviour that looks
 *    exactly like a failure if you did not mean it (`dup=yes` in the ret= decode).
 */
object FfscFrame {

    const val MAX_BLOB = 1024
    const val OP_PUT = 0
    const val OP_CLEAR = 1

    /** The FXP1 service id the page-independent loader gate listens on. */
    const val SID_FXP1 = 0x90

    private val FFSC = byteArrayOf('F'.code.toByte(), 'F'.code.toByte(), 'S'.code.toByte(), 'C'.code.toByte())
    private val FXP1 = byteArrayOf('F'.code.toByte(), 'X'.code.toByte(), 'P'.code.toByte(), '1'.code.toByte())

    private fun crc32(b: ByteArray): Long = CRC32().apply { update(b) }.value

    /**
     * Build one FFSC frame. Refuses locally anything the glasses would refuse, so a mistake
     * is an exception here rather than an `err=` code on a face.
     */
    fun encode(appId: Int, seq: Int, blob: ByteArray = ByteArray(0), op: Int = OP_PUT): ByteArray {
        require(appId in 1..0xFFFE) { "appId $appId outside 1..0xFFFE" }
        val body = when (op) {
            OP_PUT -> {
                require(blob.isNotEmpty()) { "FFSC PUT with an empty blob (the glasses answer G2D_ERR_SIZE)" }
                require(blob.size <= MAX_BLOB) { "blob ${blob.size} B over G2D_MAX_BLOB ($MAX_BLOB)" }
                blob
            }
            OP_CLEAR -> ByteArray(0)
            else -> throw IllegalArgumentException("unknown op $op")
        }
        val out = ByteArray(0x10 + body.size)
        System.arraycopy(FFSC, 0, out, 0, 4)
        out[4] = 1
        out[5] = op.toByte()
        putU16(out, 0x06, appId)
        putU16(out, 0x08, seq)
        putU16(out, 0x0a, body.size)
        putU32(out, 0x0c, crc32(body))
        System.arraycopy(body, 0, out, 0x10, body.size)
        return out
    }

    /** Wrap a body in the loader's FXP1 frame: magic + len + CRC-32 + body. */
    fun fxp1(body: ByteArray): ByteArray {
        val out = ByteArray(12 + body.size)
        System.arraycopy(FXP1, 0, out, 0, 4)
        putU32(out, 4, body.size.toLong())
        putU32(out, 8, crc32(body))
        System.arraycopy(body, 0, out, 12, body.size)
        return out
    }

    /** The whole thing, ready for `G2Central.pushToService(SID_FXP1, ...)`. */
    fun put(appId: Int, seq: Int, blob: ByteArray): ByteArray = fxp1(encode(appId, seq, blob, OP_PUT))

    fun clear(appId: Int, seq: Int): ByteArray = fxp1(encode(appId, seq, ByteArray(0), OP_CLEAR))

    private fun putU16(b: ByteArray, off: Int, v: Int) {
        b[off] = (v and 0xFF).toByte()
        b[off + 1] = ((v shr 8) and 0xFF).toByte()
    }

    private fun putU32(b: ByteArray, off: Int, v: Long) {
        b[off] = (v and 0xFF).toByte()
        b[off + 1] = ((v shr 8) and 0xFF).toByte()
        b[off + 2] = ((v shr 16) and 0xFF).toByte()
        b[off + 3] = ((v shr 24) and 0xFF).toByte()
    }
}
