package expo.modules.ffsble.voice

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile

/**
 * Everything [VoiceArchiveFiles] records about a session, as it appears in `meta.json`.
 *
 * Deliberately a flat bag of numbers and one id. There is nothing here that could identify what
 * was SAID -- no transcript, no text, no sample values. `meta.json` is the file you can hand
 * someone to debug a capture without handing them the capture.
 */
data class VoiceSessionMeta(
    val formatVersion: Int,
    val sessionId: String,
    val startedAtEpochMs: Long,
    val endedAtEpochMs: Long?,
    val packets: Long,
    val durationMs: Long,
    val packetBytes: Int,
    val sampleRate: Int,
    val stats: VoiceFramerStats
)

/**
 * The on-disk MASTER archive: raw 205-byte packets, verbatim, forever.
 *
 * ══ WHY THE MASTER IS THE RAW PACKET STREAM AND NOT A WAV ══════════════════════════════════
 * Three reasons, in order of how much they matter:
 *
 * 1. **It is lossless with respect to the wire.** 205 bytes / 50 ms = 32.8 kbps ~ 14 MB/hour.
 *    The same hour as 16 kHz mono s16 WAV is 115 MB. Storing the *decoded* form costs 8x for
 *    strictly less information.
 * 2. **It preserves `ssr` and `tdoa`.** Those two int16s per 50 ms are computed ON-GLASS from
 *    two microphones and CANNOT be recovered from PCM afterwards -- a sibling stream needs them
 *    for own-voice gating. A WAV throws them away.
 * 3. **It lets us re-decode.** Every parameter downstream of the wire is a decision we might
 *    revise: the conceal window, the resync threshold, gain, even the decoder itself. With the
 *    raw stream on disk, revising one is a re-run ([deriveWav]); without it, every past
 *    recording is frozen at whatever we believed on the day it was captured.
 *
 * ⛔ **NOTHING HERE AUTO-DELETES. THERE IS NO RETENTION POLICY, BY EXPLICIT DECISION.** No
 * eviction, no size cap, no age cap, no "clean up old sessions" helper -- deliberately not even
 * a private one, because a private one is a public one in six weeks. 14 MB/hour of ACTUAL
 * recorded listening is affordable, and an archive that silently discards is not an archive.
 * Deletion is the wearer's action, taken through a UI that says what is being deleted.
 *
 * ══ WHY THE ROOT IS INJECTED ═══════════════════════════════════════════════════════════════
 * The caller passes `File(context.filesDir, "voice")`. This class therefore imports no Android
 * at all and a JUnit `TemporaryFolder` is a complete substitute for the phone -- which is what
 * makes the crash-recovery behaviour below testable at all, since "kill the process mid-write"
 * is not a thing you can arrange on a device on demand.
 *
 * ══ LAYOUT ═════════════════════════════════════════════════════════════════════════════════
 * ```
 *   <root>/sessions/<sessionId>/master.g2a   raw 205-byte packets, appended verbatim
 *   <root>/sessions/<sessionId>/meta.json    id, clock, counts, framer stats, format version
 * ```
 * The SQLite transcript index is a DIFFERENT stream's job and lives elsewhere; this class knows
 * about files and nothing else.
 */
class VoiceArchiveFiles(private val root: File) {

    companion object {
        /**
         * Bumped when the meaning of `master.g2a` changes. It is recorded per session rather
         * than globally because the archive keeps everything forever -- a reader five versions
         * from now will be handed files written by all of them.
         */
        const val FORMAT_VERSION = 1

        const val MASTER_NAME = "master.g2a"
        const val META_NAME = "meta.json"
        const val SESSIONS_DIR = "sessions"

        /**
         * Flush cadence. NOT per packet: `fsync`-ish work 20 times a second on a phone burns
         * battery and wears flash for no benefit, since the exposure window a per-packet flush
         * would close is 50 ms of audio.
         *
         * These two together bound the loss from an abrupt kill at ~1 second, which is the
         * deliberate trade.
         */
        const val FLUSH_EVERY_PACKETS = 20
        const val FLUSH_EVERY_MS = 1_000L
    }

    /** `<root>/sessions`, created on demand. */
    fun sessionsDir(): File = File(root, SESSIONS_DIR).also { it.mkdirs() }

    fun sessionDir(sessionId: String): File = File(sessionsDir(), sessionId)

    fun masterFile(sessionId: String): File = File(sessionDir(sessionId), MASTER_NAME)

    fun metaFile(sessionId: String): File = File(sessionDir(sessionId), META_NAME)

    /** Session ids present on disk, newest-id-last (ids are expected to sort chronologically). */
    fun listSessionIds(): List<String> =
        (sessionsDir().listFiles() ?: emptyArray())
            .filter { it.isDirectory }
            .map { it.name }
            .sorted()

    /**
     * Open (or REOPEN) a session's master for appending.
     *
     * Reopening runs [repairMaster] first -- see there for why a reopen is the only moment a
     * truncated tail can be discovered.
     */
    fun open(sessionId: String, startedAtEpochMs: Long): MasterWriter {
        sessionDir(sessionId).mkdirs()
        val master = masterFile(sessionId)
        val repaired = repairMaster(master)
        return MasterWriter(sessionId, startedAtEpochMs, master, repaired)
    }

    /**
     * Detect and repair a TORN TAIL: truncate [master] to a whole number of packets.
     *
     * ══ WHY THIS IS NECESSARY, AND WHY LENGTH IS ENOUGH TO DETECT IT ═══════════════════════
     * The process can die at any instant: the wearer force-stops the app, Android kills it for
     * memory, the battery goes. A buffered write in flight when that happens leaves a PARTIAL
     * final packet on disk. Nothing in the file format announces it -- there is no per-packet
     * header, no length prefix, no CRC.
     *
     * But every packet is EXACTLY [VoiceFormat.PACKET_BYTES] long, and that fixed stride is the
     * whole detector: `length % 205 != 0` means, unambiguously, a torn tail. A partial packet is
     * unrecoverable (LC3 frames are not self-delimiting and the trailing `ssr`/`tdoa`/counter
     * are missing), so the repair is to drop it. At most 50 ms of audio is lost, and what
     * remains is a stream every reader can parse.
     *
     * Doing this on OPEN rather than on read is the important half: if we appended after a torn
     * tail, every packet from then on would be misaligned by a few bytes and the whole rest of
     * the session would decode as noise -- one truncated write would poison an entire recording.
     *
     * @return bytes removed; `0` if the file was already whole or absent.
     */
    fun repairMaster(master: File): Long {
        if (!master.isFile) return 0L
        val len = master.length()
        val extra = len % VoiceFormat.PACKET_BYTES
        if (extra == 0L) return 0L
        RandomAccessFile(master, "rw").use { it.setLength(len - extra) }
        return extra
    }

    /** Whole packets currently in [master]. Cheap -- it is a division, not a scan. */
    fun packetCount(master: File): Long =
        if (master.isFile) master.length() / VoiceFormat.PACKET_BYTES else 0L

    /**
     * Read a master back, one 205-byte packet at a time.
     *
     * A `Sequence` rather than a `List`: an hour of listening is ~72,000 packets and there is no
     * reason to hold them all. A short read at the end (a torn tail that [repairMaster] has not
     * been run over) simply ENDS the sequence rather than throwing -- a reader's job is to
     * salvage what is there, and the repair belongs on the write path.
     *
     * ⚠️ Each element is a FRESH array, not a reused buffer: a `Sequence` invites `toList()`,
     * and a reused buffer would make that silently return N references to the same packet.
     */
    fun readPackets(master: File): Sequence<ByteArray> = sequence {
        if (!master.isFile) return@sequence
        BufferedInputStream(FileInputStream(master), 1 shl 16).use { input ->
            while (true) {
                val packet = ByteArray(VoiceFormat.PACKET_BYTES)
                if (!readFully(input, packet)) break
                yield(packet)
            }
        }
    }

    /** @return true if the whole array was filled; false at a clean or torn end of file. */
    private fun readFully(input: InputStream, into: ByteArray): Boolean {
        var got = 0
        while (got < into.size) {
            val n = input.read(into, got, into.size - got)
            if (n < 0) return false
            got += n
        }
        return true
    }

    /** What [deriveWav] did, in numbers. Safe to log. */
    data class DeriveResult(
        val packetsRead: Long,
        val chunksWritten: Long,
        val samplesWritten: Long,
        val durationMs: Long,
        val stats: VoiceFramerStats
    )

    /**
     * Re-decode a master into a 16 kHz mono WAV -- the derived artefact the STT upload consumes.
     *
     * ⛔ **THE SAME [VoiceFramer] RULES AS THE LIVE PATH, THROUGH ONE DECODER.** This is not a
     * convenience re-implementation: if the offline path concealed differently from the live
     * path, a transcript would disagree with what the wearer heard, and the disagreement would
     * be invisible. So the identical framer decides here too -- gaps still become PLC, oversized
     * gaps still resync, malformed packets are still counted and dropped.
     *
     * The master is expected to hold the DEDUPED stream (what the live framer delivered), so in
     * the normal case every delta here is 1 and no concealment is regenerated. If duplicates
     * were archived anyway, the framer drops them again and the output is still correct.
     *
     * The caller owns [decoder] and must pass a FRESH one -- decoder state from a previous
     * stream would leak into this one's first frames.
     */
    fun deriveWav(master: File, outWav: File, decoder: Lc3Decoder): DeriveResult {
        val framer = VoiceFramer()
        var packetsRead = 0L
        var chunks = 0L
        outWav.parentFile?.mkdirs()
        val writer = WavWriter(outWav)
        val pcm = ShortArray(VoiceFormat.SAMPLES_PER_PACKET)
        writer.use { w ->
            for (raw in readPackets(master)) {
                packetsRead++
                val packet = framer.parse(raw, "A", packetsRead * VoiceFormat.PACKET_MS) ?: continue
                val conceal = when (val action = framer.offer(packet)) {
                    is FramerAction.Duplicate -> continue
                    is FramerAction.Resync -> 0
                    is FramerAction.Deliver -> action.concealBefore
                }
                repeat(conceal / VoiceFormat.FRAMES_PER_PACKET) {
                    for (f in 0 until VoiceFormat.FRAMES_PER_PACKET) {
                        decoder.concealFrame(pcm, f * VoiceFormat.SAMPLES_PER_FRAME)
                    }
                    w.append(pcm, 0, VoiceFormat.SAMPLES_PER_PACKET)
                    chunks++
                }
                for (f in 0 until VoiceFormat.FRAMES_PER_PACKET) {
                    decoder.decodeFrame(
                        packet.lc3,
                        packet.lc3Offset + f * VoiceFormat.FRAME_BYTES,
                        VoiceFormat.FRAME_BYTES,
                        pcm,
                        f * VoiceFormat.SAMPLES_PER_FRAME
                    )
                }
                w.append(pcm, 0, VoiceFormat.SAMPLES_PER_PACKET)
                chunks++
            }
        }
        // The staging buffer above IS reused across chunks, unlike the live path -- safe here
        // only because WavWriter.append copies into the file before we touch it again.
        return DeriveResult(
            packetsRead = packetsRead,
            chunksWritten = chunks,
            samplesWritten = writer.samplesWritten,
            durationMs = writer.durationMs,
            stats = framer.stats()
        )
    }

    // -- meta.json ---------------------------------------------------------------------------

    /**
     * Write `meta.json`.
     *
     * Hand-rolled JSON, on purpose: `org.json` on the desktop JVM is the Android STUB, whose
     * every method throws "not mocked", so using it would drag Robolectric into a test that is
     * otherwise pure file I/O. The document is a flat object of numbers, one string and one
     * null -- the smallest possible thing a hand-rolled writer can get wrong.
     */
    fun writeMeta(meta: VoiceSessionMeta) {
        val dir = sessionDir(meta.sessionId)
        dir.mkdirs()
        val s = meta.stats
        val json = buildString {
            append("{\n")
            append("  \"formatVersion\": ").append(meta.formatVersion).append(",\n")
            append("  \"sessionId\": \"").append(escape(meta.sessionId)).append("\",\n")
            append("  \"startedAtEpochMs\": ").append(meta.startedAtEpochMs).append(",\n")
            append("  \"endedAtEpochMs\": ")
                .append(meta.endedAtEpochMs?.toString() ?: "null").append(",\n")
            append("  \"packets\": ").append(meta.packets).append(",\n")
            append("  \"durationMs\": ").append(meta.durationMs).append(",\n")
            append("  \"packetBytes\": ").append(meta.packetBytes).append(",\n")
            append("  \"sampleRate\": ").append(meta.sampleRate).append(",\n")
            append("  \"received\": ").append(s.received).append(",\n")
            append("  \"duplicates\": ").append(s.duplicates).append(",\n")
            append("  \"malformed\": ").append(s.malformed).append(",\n")
            append("  \"concealed\": ").append(s.concealed).append(",\n")
            append("  \"resyncs\": ").append(s.resyncs).append(",\n")
            append("  \"lostPackets\": ").append(s.lostPackets).append("\n")
            append("}\n")
        }
        // Write-then-rename: meta.json is rewritten on every flush, and a torn meta.json would
        // make a session look corrupt when only its bookkeeping was. The master is append-only
        // and needs no such dance.
        val tmp = File(dir, "$META_NAME.tmp")
        FileOutputStream(tmp).use { it.write(json.toByteArray(Charsets.UTF_8)) }
        val dst = File(dir, META_NAME)
        if (!tmp.renameTo(dst)) {
            dst.delete()
            tmp.renameTo(dst)
        }
    }

    /**
     * Read `meta.json` back. Returns `null` if it is absent or unparseable -- a session whose
     * bookkeeping is gone still has its master, and losing the master to a bad `meta.json` would
     * be the exact opposite of what an archive is for.
     */
    fun readMeta(sessionId: String): VoiceSessionMeta? {
        val f = metaFile(sessionId)
        if (!f.isFile) return null
        val text = try {
            f.readText(Charsets.UTF_8)
        } catch (t: Throwable) {
            return null
        }
        val id = str(text, "sessionId") ?: return null
        return VoiceSessionMeta(
            formatVersion = num(text, "formatVersion")?.toInt() ?: 0,
            sessionId = id,
            startedAtEpochMs = num(text, "startedAtEpochMs") ?: return null,
            endedAtEpochMs = num(text, "endedAtEpochMs"),
            packets = num(text, "packets") ?: 0L,
            durationMs = num(text, "durationMs") ?: 0L,
            packetBytes = num(text, "packetBytes")?.toInt() ?: VoiceFormat.PACKET_BYTES,
            sampleRate = num(text, "sampleRate")?.toInt() ?: VoiceFormat.SAMPLE_RATE,
            stats = VoiceFramerStats(
                received = num(text, "received")?.toInt() ?: 0,
                duplicates = num(text, "duplicates")?.toInt() ?: 0,
                malformed = num(text, "malformed")?.toInt() ?: 0,
                concealed = num(text, "concealed")?.toInt() ?: 0,
                resyncs = num(text, "resyncs")?.toInt() ?: 0,
                lostPackets = num(text, "lostPackets")?.toInt() ?: 0
            )
        )
    }

    /**
     * Bridge to the shared [VoiceSession] contract, for whoever owns the SQLite index. Built
     * from `meta.json` so the files remain the source of truth and the database remains a
     * rebuildable derivative.
     */
    fun toSession(sessionId: String): VoiceSession? {
        val m = readMeta(sessionId) ?: return null
        return VoiceSession(
            id = m.sessionId,
            startedAtEpochMs = m.startedAtEpochMs,
            endedAtEpochMs = m.endedAtEpochMs,
            masterPath = masterFile(sessionId).absolutePath,
            packets = m.packets.toInt(),
            durationMs = m.durationMs
        )
    }

    private fun escape(s: String) = s.replace("\\", "\\\\").replace("\"", "\\\"")

    /** Minimal flat-JSON field readers. They understand exactly what [writeMeta] emits. */
    private fun num(text: String, key: String): Long? {
        val m = Regex("\"" + Regex.escape(key) + "\"\\s*:\\s*(-?\\d+|null)").find(text) ?: return null
        val v = m.groupValues[1]
        return if (v == "null") null else v.toLongOrNull()
    }

    private fun str(text: String, key: String): String? {
        val m = Regex("\"" + Regex.escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(text)
            ?: return null
        return m.groupValues[1].replace("\\\"", "\"").replace("\\\\", "\\")
    }

    // -- writer ------------------------------------------------------------------------------

    /**
     * Appends raw packets to one session's master and keeps its `meta.json` current.
     *
     * NOT thread-safe: it is fed from ONE thread (the [VoicePipeline] decode thread, via a sink)
     * and adding a lock would put contention on the audio path to protect against a caller that
     * does not exist.
     */
    inner class MasterWriter(
        val sessionId: String,
        val startedAtEpochMs: Long,
        val master: File,
        /** Bytes [repairMaster] removed when this writer opened. Non-zero = we survived a kill. */
        val repairedBytes: Long
    ) : Closeable {

        private var out = BufferedOutputStream(FileOutputStream(master, true), 1 shl 16)
        private var sinceFlush = 0
        private var lastFlushMs = System.currentTimeMillis()
        private var closed = false

        /** Whole packets in the file, INCLUDING any that were already there before this open. */
        var packets: Long = packetCount(master)
            private set

        /** Latest framer snapshot, folded into `meta.json` on each flush. */
        var stats: VoiceFramerStats = VoiceFramerStats()

        /** Audio recorded, in ms, at 50 ms per packet. */
        val durationMs: Long get() = packets * VoiceFormat.PACKET_MS

        init {
            // Write meta immediately so a session that dies before its first flush is still
            // identifiable on disk rather than being an anonymous directory of bytes.
            flushMeta(null)
        }

        /**
         * Append ONE packet, verbatim.
         *
         * Wrong-length input is REFUSED rather than written: the fixed 205-byte stride is the
         * only structure this file has, and one short write would misalign everything after it.
         *
         * @return true if written.
         */
        fun append(raw: ByteArray): Boolean {
            check(!closed) { "MasterWriter is closed" }
            if (raw.size != VoiceFormat.PACKET_BYTES) return false
            out.write(raw, 0, VoiceFormat.PACKET_BYTES)
            packets++
            sinceFlush++
            val now = System.currentTimeMillis()
            if (sinceFlush >= FLUSH_EVERY_PACKETS || now - lastFlushMs >= FLUSH_EVERY_MS) {
                flush(now)
            }
            return true
        }

        /** Force the buffered bytes out and refresh `meta.json`. */
        fun flush(nowMs: Long = System.currentTimeMillis()) {
            out.flush()
            sinceFlush = 0
            lastFlushMs = nowMs
            flushMeta(null)
        }

        /**
         * Flush, stamp the end time and close. Idempotent -- [VoicePipeline.stop] and an
         * explicit archive teardown can both reasonably call it.
         */
        fun close(endedAtEpochMs: Long) {
            if (closed) return
            closed = true
            out.flush()
            out.close()
            flushMeta(endedAtEpochMs)
        }

        override fun close() = close(System.currentTimeMillis())

        private fun flushMeta(endedAtEpochMs: Long?) {
            writeMeta(
                VoiceSessionMeta(
                    formatVersion = FORMAT_VERSION,
                    sessionId = sessionId,
                    startedAtEpochMs = startedAtEpochMs,
                    endedAtEpochMs = endedAtEpochMs,
                    packets = packets,
                    durationMs = durationMs,
                    packetBytes = VoiceFormat.PACKET_BYTES,
                    sampleRate = VoiceFormat.SAMPLE_RATE,
                    stats = stats.copy()
                )
            )
        }
    }
}
