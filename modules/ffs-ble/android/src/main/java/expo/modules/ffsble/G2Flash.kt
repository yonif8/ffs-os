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
        3600806L, 0x007A7186L, true, "resident loader (2.2.7.14)"
    )
    /** 2026-08-13 — the PERMANENT PAYLOAD ARENA loader. goldenLoader27 above malloc'd a
     * fresh payload buffer on every push while the previous blob was still resident — and it
     * has to stay resident, because FFSP gesture handlers execute out of it. So a push needed
     * two blobs' worth of pool A at once, and once a screen's widgets were up (~32 KB of the
     * ~40 KB free, measured by heap_gauge_probe) the second allocation failed: every
     * interaction push died on rej=1/OOM. This image reserves ONE LDR_MAX_PAYLOAD buffer and
     * memcpys into it forever after, so a push allocates nothing.
     * Built in CI on the clang-18 pin (run 31644244797) — NOT locally; Windows clang emits
     * different bytes. ps/prog_end below are that run's, and selfTestGuard re-derives both
     * from the image, so a mis-transcribed digit here refuses the flash rather than passing
     * it. Restore path = goldenStock27. */
    val goldenArena27 = GoldenVector(
        "e206a0ec5449c865546e8f2885d50c66e118da5c502df97fcce82b4048de4eeb",
        3601454L, 0x007A740EL, true, "arena loader (2.2.7.14)"
    )
    /** 2026-08-13 — the BIG ARENA loader: LDR_MAX_PAYLOAD 9216 -> 16384.
     * goldenArena27 fixed the per-push OOM but left only 768 B of blob headroom, and the INK
     * opcode's rasteriser (ffs_ink.h — ffs_ink_tri alone is 1324 B) needs ~4.2 KB: the
     * interpreter went 8436 -> 12632 B, which the 9216 arena answers with rej=2/CAP. Without
     * it FFSP_OP_IMAGE can only draw an EMPTY BORDERED BOX, because nothing on the wire can
     * reach the L8 surface. Costs pool A 7 KB more of 460800 (1.6%).
     * Built in CI on the clang-18 pin (run 31700889263) — NOT locally; Windows clang emits
     * different bytes. ⚠️ ps/prog_end are CARRIED OVER from goldenArena27 because the change
     * is one immediate operand (0x2400 -> 0x4000, both encodable as a Thumb-2 modified
     * immediate) and the artifact is byte-identical in length (4379285). selfTestGuard
     * re-derives both from the image, so if that reasoning is wrong the flash is REFUSED
     * rather than attempted — which is why it is safe to reason rather than re-measure here.
     * Restore path = goldenStock27. */
    val goldenInk27 = GoldenVector(
        "47a337ef02f83808424c11ca75ac28129f232186d72c8bd99e958d0d8dd0c16b",
        3601454L, 0x007A740EL, true, "big-arena loader (2.2.7.14)"
    )
    /** 2026-08-14 — GIF + LD05 always-on telemetry loader. Same 16384 arena as goldenInk27;
     * the only loader.c delta is the additive LD05 telemetry block (Carrier B — LD04's 68
     * bytes are byte-identical at the same offsets). The GIF opcode (0x28) is NOT in this
     * flashed image — it ships in the PUSHED ffs_prog.c interpreter. Built in CI on the
     * clang-18 pin (run 31837608620) — NOT locally; Windows clang emits different bytes.
     * ps/progEnd are that run's ("ps 3557884 -> 3601866", payload end MRAM 0x007a75aa);
     * selfTestGuard re-derives both from the image, so a mis-transcribed digit refuses the
     * flash rather than passing it. Restore path = goldenStock27. */
    val goldenGif27 = GoldenVector(
        "80d4c1a70bb86cf2db0c2b8bf42b1dec87be6e007a309750eaef58b500bfafa0",
        3601866L, 0x007A75AAL, true, "gif+telemetry loader (2.2.7.14)"
    )
    /** 2026-08-15 — NATIVE GIF STEREO-SYNC loader. Adds the resident master-broadcast poll
     * (ffs_gif_master_poll from the loader tick) + the slave-snap trampoline at the peer-receive
     * bl FUN_00464ffa @0x0045b660, so the two lenses phase-lock a looping GIF with no phone in
     * the loop. Built in CI on the clang-18 pin (run 31849497034). ps/progEnd are that run's
     * ("ps 3557884 -> 3602538", payload end MRAM 0x007a784a); selfTestGuard re-derives both from
     * the image, so a mis-transcribed digit refuses the flash. Restore path = goldenStock27. */
    val goldenSync27 = GoldenVector(
        "8d63a4312f703a6011dda4e68cee62bc1ea2d7fd82343456bb0409fed53d23b3",
        3602538L, 0x007A784AL, true, "gif-sync loader (2.2.7.14)"
    )
    /** 2026-08-15 DIAGNOSTIC — gif-sync loader with FFS_GIF_SYNC_DEBUG (slave forces frame 2 on
     * receipt to isolate the sync-chain break). CI run 31852233186; ps 3557884 -> 3602514,
     * payload end MRAM 0x007a7832. To be replaced once the chain is diagnosed. */
    val goldenSyncDiag27 = GoldenVector(
        "e4befdccbeda6fb17cde5cf55cd3c1bd8b4e73f9e6be5856f1c349b8f7b69b35",
        3602514L, 0x007A7832L, true, "gif-sync DIAG (2.2.7.14)"
    )
    /** 2026-08-18 — OS TAKEOVER: resident base-page dashboard constructor. Patches the base-page
     * module-table constructor ptr (ROM word 0x006aa670, entry 3 / app_id 1) from Even's
     * dashboard_page_lifecycle to our ffs_dash_rt_ctor, so cold boot / wake / return-to-home builds
     * OUR dashboard as the base page and Even's dashboard is never constructed (zero-trace). Built in
     * CI on the clang-18 pin (run 32139161393); ps 3557884 -> 3603710, payload end MRAM 0x007a7cde.
     * selfTestGuard re-derives ps/progEnd from the image, so a mis-typed digit refuses the flash
     * rather than passing it. Restore path = goldenStock27. */
    val goldenTakeover27 = GoldenVector(
        "4521d40cef3bdb7c776fc2395f236671a92ce8b001a4f63b6ad02a341eac9594",
        3603810L, 0x007A7D42L, true, "OS takeover usable dashboard — tap-safe (2.2.7.14)"
    )
    /** 2026-08-18 — OS TAKEOVER + functional navigation. Same base-page ctor swap as
     * goldenTakeover27, now with the Even-like gesture model wired into ffs_dash_rt_ctor:
     * roll moves the app-drawer selection, tap enters (dashboard -> drawer -> app), double-tap
     * is back (app -> drawer -> dashboard). Now with the redraw fix: rt_repaint invalidates the
     * image + base-page root so the HUD actually refreshes (clock ticks, nav is visible). Built
     * in CI on the clang-18 pin (run 32166565461); ps 3557884 -> 3610244, payload end MRAM
     * 0x007a9664. selfTestGuard re-derives ps/progEnd from the image, so a mis-typed digit
     * refuses the flash rather than passing it. */
    val goldenNav27 = GoldenVector(
        "361cdb214ebc4ae85e2a35310d43c79799b6c9439d1cbfa54a33917f384e7aa2",
        3610244L, 0x007A9664L, true, "OS takeover — functional nav + redraw fix (2.2.7.14)"
    )
    /** 2026-08-18 — long-press opens the menu, double-tap hides the dashboard (Even's own fade
     * FUN_004ed540, gated by *0x2007543c=0), and both eyes stay in sync (gestures folded
     * synchronously in the input hook instead of the per-lens timer). Long-press retargets the
     * eventID==3 predicate bl at 0x00442e70 to ffs_dash_longpress. Built CI run 32171189107;
     * ps 3557884 -> 3610970, payload end MRAM 0x007a993a. selfTestGuard re-derives ps/progEnd. */
    val goldenNav27b = GoldenVector(
        "cbeacb985d03fd9bc923c5ac371dd6fa3f656e3227949e04c579ec493acf3a44",
        3610970L, 0x007A993AL, true, "OS takeover — longpress menu + hide + stereo-sync (2.2.7.14)"
    )

    /** 2026-08-20 — S2 app runtime: apps install and launch over BLE with no reflash. Adds the
     * resident app loader (patches/ffs_appload.c) behind the takeover dashboard: an FXP1 body
     * beginning "FFSA" is an app image, copied into its own buffer, launched/killed by the shell.
     * Also makes the loader's permanent arena degrade in halves instead of giving up. Built CI run
     * 32317924211; ps 3557884 -> 3627524, payload end MRAM 0x007AD9E4. selfTestGuard re-derives
     * ps/progEnd, so a mistyped constant here fails closed rather than flashing something else. */
    val goldenApps27 = GoldenVector(
        "7ad48130a6b3616a7cdddb0d268193d902d5e5f03bd639a6793f9fff79b7097e",
        3627524L, 0x007AD9E4L, true, "OS takeover + S2 app runtime (2.2.7.14)"
    )

    /** 2026-08-20 — S2b: 160x64 shell canvas (was 240x96). The surface drops 46,152 -> 20,552 B
     * of P_GLOBAL, which is the same heap the loader arena and the EvenHub image channel's
     * reassembly buffer come from — at 240x96 the pool was too tight to push anything once the
     * dashboard was on screen. Also keeps a running app alive across a page rebuild. CI run
     * 32324934793; ps 3557884 -> 3628388, payload end MRAM 0x007ADD44. */
    val goldenApps27b = GoldenVector(
        "340a078884dba9f0b60b608e8c87a5a8d2ed8adabb63086bd57859fa27224cba",
        3628388L, 0x007ADD44L, true, "OS takeover + S2 app runtime, 160x64 canvas (2.2.7.14)"
    )

    /** 2026-08-20 (S-INT) — the safety gate + the layer-top shell, three streams in one image.
     *
     * R1/S-SAFE: an arena-independent PANIC RESET. Twice on 2026-08-20 the glasses went deaf
     * with `calls=0 rxlen=0` -- alive, answering DEVICE_INFO, but dropping every inbound frame
     * inside EVEN'S receive path, upstream of our loader. `ffs_reset.c` could not help: a reset
     * is itself a push. This image gates BOTH inbound handler ROM words (0x004ce398 AND
     * 0x004ce39c -- which slot a frame takes depends on an undecoded header bit, so gating one
     * would be a coin flip) on a 12-byte marker and writes SYSRESETREQ directly: zero heap, zero
     * display thread. `panicReset()` in G2Central sends it. It also gives Even's two silent
     * inbound MALLOC sites a pre-claimed ballast block.
     *
     * S2-top: the shell leaves Even's base page for our own container on `lv_layer_top`, and its
     * pixels leave P_GLOBAL for P_FT (20,552 -> 10,336 B, ~20.5 KB returned to the heap the
     * loader arena competes for). The ctor now cleans Even's widgets ONLY after our surface
     * exists -- the previous order is what put a live, valid, EMPTY page in front of the wearer
     * with every counter reading healthy. The AP01 readback carries `dash=`/`src=` so that
     * failure can never be silent again.
     *
     * S-INT: G2A_MAX_CODE 2048 -> 6144, plus a 16 KB cap on the running TOTAL of installed code.
     *
     * CI run 32397128110; ps 3557884 -> 3622864, payload end MRAM 0x007AC7B0. selfTestGuard
     * re-derives ps/progEnd, so a mistyped constant here fails closed. */
    val goldenShell27 = GoldenVector(
        "791998750f7db3c4ab7d7b70e51d878f9ebff249167805961d8acac765acb569",
        3622864L, 0x007AC7B0L, true,
        "OS takeover + panic-reset gate + layer-top shell on P_FT (2.2.7.14)"
    )

    /** S-BIG: the shell canvas is the WHOLE HUD — 160x64 -> 576x288, the full panel.
     *
     * The old cap was a P_GLOBAL trade and both its premises were already dead: the pixels
     * moved to P_FT with S2-top, and P_FT was MEASURED on glass rather than assumed
     * (ret=0x72FE5E1B -> 539 KB free; ret=0x73F47518 -> 280 KB peak; 540 KB of headroom
     * above its own high-water mark). Full-screen L8 is 165,984 B and fits with the 192 KB
     * safety margin UNTOUCHED and 186 KB to spare. Contiguity proven separately by a
     * 163 KB claim+release round trip (ret=0x75FF8A3F, `used` returned exactly).
     *
     * CI run 32405122312; ps 3557884 -> 3622844, payload end MRAM 0x007AC79C. selfTestGuard
     * re-derives ps/progEnd, so a mistyped constant here fails closed. */
    val goldenBig27 = GoldenVector(
        "7e8422fac671885ac6a6c7cf1da3713859f0cfe7360087256da2353c3cd83053",
        3622844L, 0x007AC79CL, true,
        "OS takeover + panic gate + FULL-HUD 576x288 shell on P_FT (2.2.7.14)"
    )

    /**
     * 2026-08-21 (S-SHIP). goldenBig27 plus three things that turn the HUD from a display
     * into something that shows LIVE data: the phone->app data channel ("FFSC" route,
     * G2_ABI 2), S-FIX tier 3 (FXP1 consumed at the transport gate), and S-EYES's left-lens
     * readback over the peer channel.
     *
     * NOTE for whoever reads a device-info line on this image: the RAMEXEC and FTFONTS
     * blocks are GONE on purpose — their bytes paid for the new peer= field, and the
     * positive restatement is an `rxok` token in CAPS. Their absence is not a regression.
     */
    val goldenShip27 = GoldenVector(
        "c5dfd200459fe5f0ff0e6721a5197105807e5eb6de7f77732a8edfda8d73eb24",
        3643874L, 0x007B19C2L, true,
        "OS takeover + FFSC data channel + tier-3 gate + left-lens peer readback (2.2.7.14) [CURRENT]"
    )

    /** Every build this driver will consider flashing. Anything else is refused outright. */
    val allGoldens: List<GoldenVector> = listOf(
        goldenCFW, goldenStock, goldenStock27, goldenCanary,
        goldenFontpeek, goldenBidiOnly, goldenHebrewFull, goldenHebrewProbe,
        goldenFfsui, goldenRamexec, goldenLoader, goldenLoader27, goldenV3,
        goldenArena27, goldenInk27, goldenGif27, goldenSync27, goldenSyncDiag27,
        goldenTakeover27, goldenNav27, goldenNav27b, goldenApps27, goldenApps27b,
        goldenShell27, goldenBig27, goldenShip27
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
