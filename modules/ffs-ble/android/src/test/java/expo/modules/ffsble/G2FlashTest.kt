package expo.modules.ffsble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for G2Flash.kt -- the OTA protocol and, far more importantly, the MRAM brick-guard.
 *
 * WHY THIS SUITE IS WEIGHTED THE WAY IT IS
 * ----------------------------------------
 * Most test suites prove code does the right thing. The majority of this one proves the guard
 * REFUSES the wrong thing, because that is the only failure mode that matters: a guard which
 * wrongly passes is indistinguishable from no guard at all, right up until it destroys the one
 * pair of glasses this project owns, irrecoverably, over a link that cannot fix it.
 *
 * The vectors come from an INDEPENDENT Python transcription of g2flash.py's algorithms run
 * against the real bundled image, not from this Kotlin -- so they cross-check the port's
 * signedness handling rather than restate it. Two corroborations worth knowing:
 *
 *   - crc16("123456789") == 0x29B1, the published check value for CRC-16/CCITT-FALSE. The
 *     transcription is confirmed against the standard, not just against g2flash.
 *   - The guard, run over the REAL g2_2.2.7.14.bin, reproduces goldenStock27 exactly
 *     (sha 0fced0ae…, ps 3557884, prog_end 0x0079C9DC). That is asserted structurally below;
 *     the image itself is gitignored (Even IP) so CI cannot open it.
 *
 * Run: ./gradlew :ffs-ble:test
 */
class G2FlashTest {

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    // ---- CRC16 (CCITT-FALSE), emitted little-endian ----

    @Test
    fun `crc16 matches the CCITT-FALSE standard check value`() {
        // 0x29B1 is THE published check value for CRC-16/CCITT-FALSE over "123456789".
        // Emitted LE, so the bytes are B1 29.
        assertEquals("b129", hex(G2Flash.crc16("123456789".toByteArray())))
    }

    @Test
    fun `crc16 golden vectors`() {
        assertEquals("ffff", hex(G2Flash.crc16(ByteArray(0))))
        assertEquals("15b9", hex(G2Flash.crc16("A".toByteArray())))
        // All 256 byte values: catches sign-extension on bytes >= 0x80 specifically.
        assertEquals("bd3f", hex(G2Flash.crc16(ByteArray(256) { it.toByte() })))
    }

    // ---- CRC32C (Castagnoli, MSB-first -- NOT the reflected variant) ----

    @Test
    fun `crc32c golden vectors`() {
        assertEquals(0L, G2Flash.crc32c(ByteArray(0)))
        assertEquals(0xC052A8C8L, G2Flash.crc32c("123456789".toByteArray()))
        assertEquals(0xD7B91914L, G2Flash.crc32c(ByteArray(256) { it.toByte() }))
    }

    /** Kotlin's Int is signed; a Long carrier is the whole reason this port is safe. */
    @Test
    fun `crc32c never returns a negative`() {
        for (n in 0 until 40) {
            val v = G2Flash.crc32c(ByteArray(n) { (it * 7 + 0x80).toByte() })
            assertTrue("crc32c must be an unsigned 32-bit value, got $v", v in 0..0xFFFFFFFFL)
        }
    }

    // ---- OTA framing ----

    @Test
    fun `ctrlFrames golden bytes`() {
        val f = G2Flash.ctrlFrames(0x01, bytes(0x02), seq = 7)
        assertEquals(1, f.size)
        // AA 21 seq len tot serial sid flag | op data | crc16(pb) LE
        assertEquals("aa2107040101c00001027c0e", hex(f[0]))
    }

    /**
     * The chunker splits at 232 bytes -- a DIFFERENT boundary from the EvenHub transport's 236
     * in G2Protocol.kt. Both start with 0xAA and they are easy to confuse; getting this wrong
     * corrupts a firmware write rather than a UI message.
     */
    @Test
    fun `dataFrames chunk at 232 bytes not 236`() {
        val f = G2Flash.dataFrames(ByteArray(300), seq = 9)
        assertEquals(2, f.size)
        assertEquals(8 + 232, f[0].size)
        assertEquals(8 + 70, f[1].size) // 300 + 2 crc = 302; 302 - 232 = 70
        assertArrayEquals(bytes(0xAA, 0x21, 0x09, 0xE8, 0x02, 0x01, 0xC1, 0x00), f[0].copyOfRange(0, 8))
        assertArrayEquals(bytes(0xAA, 0x21, 0x09, 0x46, 0x02, 0x02, 0xC1, 0x00), f[1].copyOfRange(0, 8))
    }

    @Test
    fun `parseRx unwraps an aa12 envelope and rejects anything else`() {
        val ok = bytes(0xAA, 0x12, 0x00, 0x04, 0x01, 0x01, 0xC0, 0x00, 0x03, 0x00, 0xAA, 0xBB)
        val rx = G2Flash.parseRx(ok)
        assertNotNull(rx)
        assertEquals(0xC0, rx!!.sid)
        assertArrayEquals(bytes(0x03, 0x00), rx.pb) // ln=4 -> n=2
        // Not an aa12 reply, or too short.
        assertNull(G2Flash.parseRx(bytes(0xAA, 0x21, 0, 4, 1, 1, 0xC0, 0, 0, 0, 0, 0)))
        assertNull(G2Flash.parseRx(bytes(0xAA, 0x12, 0, 4)))
    }

    // ---- the brick-guard: synthetic EVENOTA images ----
    //
    // Minimal container the parser accepts, with every field the guard reads made settable so
    // each rejection path can be exercised independently.

    private fun buildImage(
        name: String = G2Flash.REQUIRED_SEGMENT,
        ps: Long = 3557884L,
        loadAddr: Long = G2Flash.APP_LOAD_ADDR,
        preLen: Long? = null,          // defaults to ps (the passing case)
        payloadBytes: Int = 0x40
    ): ByteArray {
        val segOff = 0x100
        val img = ByteArray(segOff + 128 + payloadBytes)
        fun putU32(o: Int, v: Long) {
            img[o] = (v and 0xFF).toByte()
            img[o + 1] = ((v ushr 8) and 0xFF).toByte()
            img[o + 2] = ((v ushr 16) and 0xFF).toByte()
            img[o + 3] = ((v ushr 24) and 0xFF).toByte()
        }
        putU32(8, 1L)                       // one component
        putU32(0x40, 1L)                    // TOC: eid
        putU32(0x44, segOff.toLong())       //      off
        putU32(0x48, ps)                    //      size
        putU32(0x4C, 0L)                    //      crc
        putU32(segOff + 8, ps)              // subheader: payload size
        val nm = name.toByteArray(Charsets.ISO_8859_1)
        System.arraycopy(nm, 0, img, segOff + 48, nm.size)
        // payload preamble: [0]=preLen (24-bit), [0x14]=load address
        putU32(segOff + 128, (preLen ?: ps) and 0x00FFFFFFL)
        putU32(segOff + 128 + 0x14, loadAddr)
        return img
    }

    @Test
    fun `guard PASSES a well-formed image and reproduces the real 2_2_7_14 vector`() {
        val img = buildImage()
        val g = G2Flash.checkMainAppFitsMram(img, G2Flash.parseSegments(img))
        assertTrue("expected pass, got: ${g.reason}", g.pass)
        // These are the values the guard produces for the REAL stock 2.2.7.14 image -- verified
        // against it directly with an independent Python implementation.
        assertEquals(3557884L, g.ps)
        assertEquals(0x0079C9DCL, g.progEnd)
        assertEquals(G2Flash.goldenStock27.ps, g.ps)
        assertEquals(G2Flash.goldenStock27.progEnd, g.progEnd)
    }

    // ---- the refusals. These are the tests that matter. ----

    @Test
    fun `guard REFUSES a wrong load address`() {
        val img = buildImage(loadAddr = 0x00400000L)
        val g = G2Flash.checkMainAppFitsMram(img, G2Flash.parseSegments(img))
        assertTrue("must refuse a load addr that is not 0x00438000", !g.pass)
        assertTrue(g.reason, g.reason.contains("load addr"))
    }

    @Test
    fun `guard REFUSES when the preamble length disagrees with the staged size`() {
        // A mismatch means the image is not what its own header says it is.
        val img = buildImage(ps = 3557884L, preLen = 3557000L)
        val g = G2Flash.checkMainAppFitsMram(img, G2Flash.parseSegments(img))
        assertTrue("must refuse preLen != ps", !g.pass)
        assertTrue(g.reason, g.reason.contains("preamble length"))
    }

    /** THE brick case: a program end past the MRAM ceiling overwrites what the bootloader needs. */
    @Test
    fun `guard REFUSES an image that would run past the MRAM ceiling`() {
        // prog_end = 0x438000 + ps - 0x20 must exceed APP_MAX_END (0x7F0000).
        val tooBig = G2Flash.APP_MAX_END - G2Flash.APP_LOAD_ADDR + G2Flash.APP_PREAMBLE + 1
        val img = buildImage(ps = tooBig)
        val g = G2Flash.checkMainAppFitsMram(img, G2Flash.parseSegments(img))
        assertTrue("must refuse prog_end past 0x007F0000", !g.pass)
        assertTrue(g.reason, g.reason.contains("too large"))
        assertTrue(g.progEnd > G2Flash.APP_MAX_END)
    }

    /** Exactly at the ceiling is allowed; one byte over is not. Off-by-one here is a brick. */
    @Test
    fun `guard boundary is inclusive at the ceiling and exclusive one byte past`() {
        val exact = G2Flash.APP_MAX_END - G2Flash.APP_LOAD_ADDR + G2Flash.APP_PREAMBLE
        val atLimit = buildImage(ps = exact)
        val gAt = G2Flash.checkMainAppFitsMram(atLimit, G2Flash.parseSegments(atLimit))
        assertEquals(G2Flash.APP_MAX_END, gAt.progEnd)
        assertTrue("prog_end exactly at the ceiling must pass", gAt.pass)

        val over = buildImage(ps = exact + 1)
        val gOver = G2Flash.checkMainAppFitsMram(over, G2Flash.parseSegments(over))
        assertTrue("one byte past the ceiling must fail", !gOver.pass)
    }

    @Test
    fun `guard REFUSES an image with no main-app segment`() {
        val img = buildImage(name = "ota/something_else.bin")
        val g = G2Flash.checkMainAppFitsMram(img, G2Flash.parseSegments(img))
        assertTrue("must refuse when the main-app segment is absent", !g.pass)
        assertTrue(g.reason, g.reason.contains("not found"))
    }

    // ---- container parsing rejections ----

    @Test
    fun `parseSegments rejects malformed containers instead of reading past the end`() {
        var threw = false
        try { G2Flash.parseSegments(ByteArray(16)) } catch (e: G2Flash.BadImageException) { threw = true }
        assertTrue("a too-small file must be rejected", threw)

        val implausible = ByteArray(0x200)
        implausible[8] = 0xFF.toByte() // component count 255 -> implausible
        threw = false
        try { G2Flash.parseSegments(implausible) } catch (e: G2Flash.BadImageException) { threw = true }
        assertTrue("an implausible component count must be rejected", threw)
    }

    // ---- the golden table: the outer gate ----

    @Test
    fun `only known builds are flashable`() {
        assertNull("an unknown sha must not resolve to a build", G2Flash.goldenFor("deadbeef".repeat(8)))
        val cur = G2Flash.goldenFor("7ecf5f4948e510469cc85cd77c1a291e67bf78800f93a40cb918cf5f326eb9a6")
        assertNotNull("the current resident loader must be recognised", cur)
        assertEquals(0x007A7186L, cur!!.progEnd)
        // Lookup is case-insensitive: a hex digest from another tool may arrive uppercase.
        assertNotNull(G2Flash.goldenFor("7ECF5F4948E510469CC85CD77C1A291E67BF78800F93A40CB918CF5F326EB9A6"))
    }

    @Test
    fun `every golden vector is a distinct well-formed entry`() {
        val shas = G2Flash.allGoldens.map { it.sha256 }
        assertEquals("duplicate sha in the golden table", shas.size, shas.toSet().size)
        for (g in G2Flash.allGoldens) {
            assertEquals("sha must be 64 lowercase hex chars: ${g.label}", 64, g.sha256.length)
            assertEquals(g.sha256, g.sha256.lowercase())
            assertTrue("prog_end must be under the ceiling: ${g.label}", g.progEnd <= G2Flash.APP_MAX_END)
            assertTrue("ps must be plausible: ${g.label}", g.ps in 1_000_000..4_000_000)
        }
    }

    /** selfTestGuard must FAIL when the guard stops reproducing the golden -- that is its job. */
    @Test
    fun `selfTestGuard detects a guard that no longer reproduces its golden`() {
        val img = buildImage()
        assertNull("matching vector must pass", G2Flash.selfTestGuard(img, G2Flash.goldenStock27))

        val wrongPs = G2Flash.GoldenVector(
            G2Flash.goldenStock27.sha256, 999L, G2Flash.goldenStock27.progEnd, true, "tampered"
        )
        assertNotNull("a wrong ps must be caught", G2Flash.selfTestGuard(img, wrongPs))

        val wrongEnd = G2Flash.GoldenVector(
            G2Flash.goldenStock27.sha256, G2Flash.goldenStock27.ps, 0x1234L, true, "tampered"
        )
        assertNotNull("a wrong prog_end must be caught", G2Flash.selfTestGuard(img, wrongEnd))
    }

    @Test
    fun `sha256Hex produces lowercase hex of the right length`() {
        // Known: SHA-256 of the empty input.
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            G2Flash.sha256Hex(ByteArray(0))
        )
    }
}
