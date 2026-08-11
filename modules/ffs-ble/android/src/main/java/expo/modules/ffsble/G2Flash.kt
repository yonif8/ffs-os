package expo.modules.ffsble

/**
 * G2Flash.kt -- Android twin of `ios/G2Flash.swift` (FUT-167 / FUT-260).
 *
 * PURE-LOGIC layer: NO android.bluetooth, NO writes. The byte-exact OTA framing + CRC16/CRC32C
 * + EVENOTA container parsing + the MRAM brick-guard, plus the golden-vector self-test. The BLE
 * flash state machine that drives these over the link lives in G2Central; this file is the
 * protocol and the safety guard, deliberately isolated so it can be reasoned about and
 * unit-tested on its own. That isolation matters more here than anywhere else in the codebase:
 * this is the only code in the project that can permanently destroy the hardware.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE GUARD EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * A main-app image whose program end runs past the MRAM ceiling overwrites the region the
 * bootloader needs, and the result is a brick recoverable only over SWD -- i.e. not
 * recoverable, on a wearer's glasses, over BLE. `checkMainAppFitsMram` re-derives the fit from
 * the image bytes before EVERY flash and is never cached. `selfTestGuard` then checks that the
 * guard itself still reproduces a captured golden vector, so a mis-transcribed constant that
 * silently disabled the guard fails loudly instead of passing everything.
 *
 * Both must pass, and a build not in the golden table cannot be flashed at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * SIGNEDNESS -- the whole reason this port is dangerous
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Swift computes these in `UInt32`. Kotlin's `Int` is SIGNED 32-bit and its `Byte` is signed,
 * so a faithful-looking transcription can produce a guard that quietly passes an image it
 * should reject -- the exact failure this file exists to prevent. Every 32-bit quantity here
 * is therefore carried in a `Long` masked to 32 bits (`and M32`), and every byte read is
 * masked with `and 0xFF`. The golden-vector tests are what prove that discipline held.
 */
object G2Flash {

    /** Mask for emulating 32-bit unsigned arithmetic in a Long. */
    private const val M32 = 0xFFFFFFFFL

    // ---- CRC16 (CCITT, init 0xFFFF, poly 0x1021) -- the OTA body trailer, LE bytes ----

    fun crc16(data: ByteArray): ByteArray {
        var c = 0xFFFF
        for (b in data) {
            c = c xor ((b.toInt() and 0xFF) shl 8)
            repeat(8) {
                c = if ((c and 0x8000) != 0) ((c shl 1) xor 0x1021) and 0xFFFF
                else (c shl 1) and 0xFFFF
            }
        }
        return byteArrayOf((c and 0xFF).toByte(), ((c ushr 8) and 0xFF).toByte())
    }

    // ---- CRC32C (Castagnoli, MSB-first, init 0, xorout 0) -- per-component payload CRC ----

    private val crc32cTable: LongArray = LongArray(256).also { t ->
        for (b in 0 until 256) {
            var c = (b.toLong() shl 24) and M32
            repeat(8) {
                c = if ((c and 0x80000000L) != 0L) ((c shl 1) xor 0x1EDC6F41L) and M32
                else (c shl 1) and M32
            }
            t[b] = c
        }
    }

    fun crc32c(buf: ByteArray): Long {
        var crc = 0L
        for (byte in buf) {
            val idx = (((crc ushr 24) xor (byte.toLong() and 0xFF)) and 0xFF).toInt()
            crc = ((crc shl 8) and M32) xor crc32cTable[idx]
        }
        return crc and M32
    }

    /** Little-endian u32 read, returned as an unsigned value in a Long. */
    fun readU32LE(b: ByteArray, o: Int): Long =
        (b[o].toLong() and 0xFF) or
            ((b[o + 1].toLong() and 0xFF) shl 8) or
            ((b[o + 2].toLong() and 0xFF) shl 16) or
            ((b[o + 3].toLong() and 0xFF) shl 24)

    // ---- OTA transport framing (validated byte-for-byte vs g2flash `frames`) ----
    //
    // body = pb + crc16(pb); chunked into 232-byte frames; per frame:
    //   [0xAA, 0x21, seq, len(chunk), tot, serial(1-based), sid, flag] + chunk
    // sid = 0xC0 ctrl, 0xC1 data. A shared `seq` links a marker+block pair.
    //
    // NOTE this is a DIFFERENT framing from the EvenHub transport in G2Protocol.kt -- same
    // 0xAA lead byte, different chunk size (232 vs 236), different CRC (CCITT vs the custom
    // bit-mix), different header semantics. They must not be confused or shared.

    const val CHUNK = 232

    fun frames(sid: Int, pb: ByteArray, flag: Int = 0, seq: Int): List<ByteArray> {
        val body = pb + crc16(pb)
        val tot = maxOf(1, (body.size + CHUNK - 1) / CHUNK)
        val out = ArrayList<ByteArray>(tot)
        var off = 0
        for (i in 0 until tot) {
            val end = minOf(off + CHUNK, body.size)
            val ch = body.copyOfRange(off, end)
            off = end
            val frame = ByteArray(8 + ch.size)
            frame[0] = 0xAA.toByte()
            frame[1] = 0x21
            frame[2] = (seq and 0xFF).toByte()
            frame[3] = (ch.size and 0xFF).toByte()
            frame[4] = (tot and 0xFF).toByte()
            frame[5] = ((i + 1) and 0xFF).toByte()
            frame[6] = (sid and 0xFF).toByte()
            frame[7] = (flag and 0xFF).toByte()
            System.arraycopy(ch, 0, frame, 8, ch.size)
            out.add(frame)
        }
        return out
    }

    fun ctrlFrames(op: Int, data: ByteArray = ByteArray(0), seq: Int): List<ByteArray> =
        frames(sid = 0xC0, pb = byteArrayOf((op and 0xFF).toByte()) + data, seq = seq)

    fun dataFrames(block: ByteArray, seq: Int): List<ByteArray> =
        frames(sid = 0xC1, pb = block, seq = seq)

    /** An unwrapped `aa12` reply envelope. `pb` = [opcode, status, ...]. */
    data class Rx(val sid: Int, val pb: ByteArray) {
        // ByteArray in a data class needs these, or equals/hashCode compare references.
        override fun equals(other: Any?): Boolean =
            this === other || (other is Rx && sid == other.sid && pb.contentEquals(other.pb))

        override fun hashCode(): Int = 31 * sid + pb.contentHashCode()
    }

    /** Unwrap an `aa12` reply envelope -> (sid, pb), or null if it is not one. */
    fun parseRx(frame: ByteArray): Rx? {
        if (frame.size < 10) return null
        if ((frame[0].toInt() and 0xFF) != 0xAA || (frame[1].toInt() and 0xFF) != 0x12) return null
        val ln = frame[3].toInt() and 0xFF
        val sid = frame[6].toInt() and 0xFF
        val n = maxOf(0, ln - 2)
        val end = minOf(8 + n, frame.size)
        if (end < 8) return Rx(sid, ByteArray(0))
        return Rx(sid, frame.copyOfRange(8, end))
    }

    // ---- EVENOTA container parsing ----

    class BadImageException(message: String) : Exception("bad firmware image: $message")

    data class Segment(
        val eid: Long,
        val off: Long,
        val size: Long,
        val crc: Long,
        /** 128-byte subheader. */
        val sub: ByteArray,
        /** payload size */
        val ps: Long,
        /** component name */
        val fn: String
    ) {
        override fun equals(other: Any?): Boolean =
            this === other || (other is Segment && eid == other.eid && off == other.off &&
                size == other.size && crc == other.crc && ps == other.ps && fn == other.fn &&
                sub.contentEquals(other.sub))

        override fun hashCode(): Int {
            var r = eid.hashCode()
            r = 31 * r + off.hashCode(); r = 31 * r + size.hashCode()
            r = 31 * r + crc.hashCode(); r = 31 * r + ps.hashCode()
            r = 31 * r + fn.hashCode(); r = 31 * r + sub.contentHashCode()
            return r
        }
    }

    @Throws(BadImageException::class)
    fun parseSegments(img: ByteArray): List<Segment> {
        if (img.size < 0x40) throw BadImageException("file too small")
        val n = readU32LE(img, 8)
        if (n <= 0 || n > 64) throw BadImageException("implausible component count $n")
        val segs = ArrayList<Segment>(n.toInt())
        for (i in 0 until n.toInt()) {
            val base = 0x40 + i * 16
            if (base + 16 > img.size) throw BadImageException("TOC entry $i past EOF")
            val eid = readU32LE(img, base)
            val off = readU32LE(img, base + 4)
            val size = readU32LE(img, base + 8)
            val crc = readU32LE(img, base + 12)
            val so = off.toInt()
            if (so < 0 || so + 128 > img.size) throw BadImageException("segment $i subheader past EOF")
            val sub = img.copyOfRange(so, so + 128)
            val ps = readU32LE(sub, 8)
            // Name is a NUL-terminated string in sub[48..128). ISO-8859-1 so every byte maps
            // to exactly one char -- UTF-8 would mangle a stray high byte into a replacement
            // char and break the REQUIRED_SEGMENT comparison the whole guard hangs on.
            var nameEnd = 48
            while (nameEnd < 128 && sub[nameEnd].toInt() != 0) nameEnd++
            val fn = String(sub, 48, nameEnd - 48, Charsets.ISO_8859_1)
            segs.add(Segment(eid, off, size, crc, sub, ps, fn))
        }
        return segs
    }

    // ---- MRAM brick-guard (the ONLY thing preventing a hard, SWD-only brick) ----

    const val APP_LOAD_ADDR = 0x00438000L
    const val APP_MAX_END = 0x007F0000L
    const val OTA_FLAG_ADDR = 0x007FE000L
    const val MRAM_END = 0x00800000L
    const val APP_PREAMBLE = 0x20
    const val REQUIRED_SEGMENT = "ota/s200_firmware_ota.bin"

    data class GuardResult(
        val ps: Long,
        val loadAddr: Long,
        val preLen: Long,
        val progEnd: Long,
        val pass: Boolean,
        val reason: String
    )

    /**
     * Re-derives the guard from the image bytes exactly as g2flash's `check_mainapp_fits_mram`.
     * Call before EVERY flash and NEVER cache the result -- a cached pass applied to a
     * different image is precisely how a brick happens.
     */
    fun checkMainAppFitsMram(img: ByteArray, segs: List<Segment>): GuardResult {
        val s = segs.firstOrNull { it.fn == REQUIRED_SEGMENT }
            ?: return GuardResult(
                0, 0, 0, 0, false, "main-app segment $REQUIRED_SEGMENT not found"
            )
        val ps = s.ps
        val po = s.off.toInt() + 128
        if (po + APP_PREAMBLE > img.size) {
            return GuardResult(
                ps, 0, 0, 0, false, "main-app payload smaller than its 32-byte preamble"
            )
        }
        val pre = img.copyOfRange(po, po + APP_PREAMBLE)
        val loadAddr = readU32LE(pre, 0x14)
        val preLen = readU32LE(pre, 0) and 0x00FFFFFFL
        if (loadAddr != APP_LOAD_ADDR) {
            return GuardResult(
                ps, loadAddr, preLen, 0, false,
                String.format("load addr 0x%08x != 0x00438000", loadAddr)
            )
        }
        if (preLen != ps) {
            return GuardResult(
                ps, loadAddr, preLen, 0, false,
                "preamble length $preLen != staged payload size $ps"
            )
        }
        // Swift used &+/&- (wrapping) on UInt32; the mask reproduces that exactly.
        val progEnd = (APP_LOAD_ADDR + ps - APP_PREAMBLE) and M32
        if (progEnd > APP_MAX_END) {
            return GuardResult(
                ps, loadAddr, preLen, progEnd, false,
                String.format("too large: prog_end 0x%08x past ceiling 0x%08x", progEnd, APP_MAX_END)
            )
        }
        return GuardResult(ps, loadAddr, preLen, progEnd, true, "ok")
    }

    // ---- Golden-vector self-test ----
    //
    // Captured from g2flash.py on the exact bundled, SHA-verified images. This Kotlin guard
    // MUST reproduce these; a mis-transcribed constant that silently disabled the guard fails
    // here, and we refuse to flash if it does. A build absent from this table cannot be
    // flashed at all -- that is the point, not an inconvenience.

    data class GoldenVector(
        val sha256: String,
        val ps: Long,
        val progEnd: Long,
        val pass: Boolean,
        /** Human label, so a refusal can say WHICH build it recognised. */
        val label: String
    )

    val goldenCFW = GoldenVector(
        "5c1539fd39c599e6035f6a8ec0779ba687c250d342a24c21a39952fed6c56aa0",
        3539474L, 0x007981F2L, true, "CFW (2.2.6.10 base)"
    )
    val goldenStock = GoldenVector(
        "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa",
        3523396L, 0x00794324L, true, "stock 2.2.6.10"
    )
    /** FUT-246 -- unmodified stock 2.2.7.14: the restore-to-stock escape hatch for this base. */
    val goldenStock27 = GoldenVector(
        "0fced0aebcc6c88db6f76dba34f91b805d842a5fc297bfd7fa6d6a34ec83cecb",
        3557884L, 0x0079C9DCL, true, "stock 2.2.7.14 (RESTORE)"
    )
    /** v3 step 1: the 2.2.7.14 CFW loader + the resident page hook (ffs_page_hook.c). Built
     * locally (patch_compress FFS_LOADER=1), MRAM end 0x007a71f6 = 291 KB under the ceiling.
     * The hook is DORMANT until a payload installs its address into a page node's +0x18, so
     * this image behaves exactly like the loader until then. Restore path = goldenStock27. */
    val goldenV3 = GoldenVector(
        "79f64a8d87ef5f5630fb3d72de562246aef3131c8625ecf97dbfd34f526dc1b8",
        3600918L, 0x007A71F6L, true, "v3 resident hook (2.2.7.14)"
    )
    /** FUT-167 canary: stock 2.2.6.10 with only a length-preserving version-string edit. */
    val goldenCanary = GoldenVector(
        "67759cd67ed7031d7b4c8a613b8b0fe9dc9bd51c11e82260c35f5bc807159b5e",
        3523396L, 0x00794324L, true, "canary 2.2.6.77"
    )
    val goldenFontpeek = GoldenVector(
        "70332b9822806a546e028ffb1b88b49a44593fe88236a3daa70866185acbb4f0",
        3540259L, 0x00798503L, true, "fontpeek (FUT-188)"
    )
    val goldenBidiOnly = GoldenVector(
        "33404e1977aa7d1abaeedfb34a64f1b81e470b6ea818a1d21f61a0187ca5be1c",
        3545731L, 0x00799A63L, true, "bidi-only (FUT-190)"
    )
    val goldenHebrewFull = GoldenVector(
        "45a481fc13b3cb864a9c6b63a4c428c248ab1f3a8ab770715b71965bad09ed5f",
        3567646L, 0x0079EFFEL, true, "hebrew-full (FUT-189/190)"
    )
    val goldenHebrewProbe = GoldenVector(
        "39ea04a2964c443a1434310d929d64cf22c24ef908255f0f8d07a4b01e72cbfd",
        3559323L, 0x0079CF7BL, true, "hebrew v2 + font probe (FUT-191)"
    )
    val goldenFfsui = GoldenVector(
        "3a673c966658216ecbb9397d65682e8131ea4465f8915c941250985f8368d8ce",
        3562746L, 0x0079DCDAL, true, "ffs-ui probe (FUT-197)"
    )
    val goldenRamexec = GoldenVector(
        "913a7f28cc79957ed8a5991c7434d993583070fc3d369b6c6a9e1683fd6f3f86",
        3563490L, 0x0079DFC2L, true, "ram-exec probe (FUT-214)"
    )
    /** FUT-216 resident OTA loader on the 2.2.6.10 base. */
    val goldenLoader = GoldenVector(
        "373bfe9aa3645f1cda5b0204df1db3516e16347f31dcc9a39846442022c43103",
        3566014L, 0x0079E99EL, true, "resident loader (2.2.6.10)"
    )
    /** FUT-246 resident loader REBASED onto 2.2.7.14 -- what the glasses currently run. */
    val goldenLoader27 = GoldenVector(
        "7ecf5f4948e510469cc85cd77c1a291e67bf78800f93a40cb918cf5f326eb9a6",
        3600806L, 0x007A7186L, true, "resident loader (2.2.7.14) [CURRENT]"
    )

    /** Every build this driver will consider flashing. Anything else is refused outright. */
    val allGoldens: List<GoldenVector> = listOf(
        goldenCFW, goldenStock, goldenStock27, goldenCanary,
        goldenFontpeek, goldenBidiOnly, goldenHebrewFull, goldenHebrewProbe,
        goldenFfsui, goldenRamexec, goldenLoader, goldenLoader27, goldenV3
    )

    /** Look up a build by the SHA-256 of its bytes. Null means "not a known build". */
    fun goldenFor(sha256: String): GoldenVector? {
        val want = sha256.lowercase()
        return allGoldens.firstOrNull { it.sha256 == want }
    }

    /**
     * Run parse + guard on [img] and assert it reproduces [gv]. Returns null on success, or a
     * failure description. ANY non-null result MUST block flashing.
     */
    fun selfTestGuard(img: ByteArray, gv: GoldenVector): String? {
        val segs = try {
            parseSegments(img)
        } catch (e: Exception) {
            return "parse failed: ${e.message}"
        }
        val r = checkMainAppFitsMram(img, segs)
        if (r.pass != gv.pass) return "guard pass=${r.pass} != golden ${gv.pass}"
        if (r.ps != gv.ps) return "ps ${r.ps} != golden ${gv.ps}"
        if (r.progEnd != gv.progEnd) {
            return String.format("prog_end 0x%08x != golden 0x%08x", r.progEnd, gv.progEnd)
        }
        return null
    }

    /** Lowercase hex SHA-256 of [data]. */
    fun sha256Hex(data: ByteArray): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        return md.digest(data).joinToString("") { "%02x".format(it.toInt() and 0xFF) }
    }
}
