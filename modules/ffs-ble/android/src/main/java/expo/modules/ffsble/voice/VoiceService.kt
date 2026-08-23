package expo.modules.ffsble.voice

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * S-VOICE, assembled.
 *
 * The parts of this feature are each proved on their own (`VoiceFramer`, `VoicePipeline`,
 * `VoiceArchiveFiles`, `SttQueue`, `SqliteTranscriptIndex` all have their own tests). This class
 * is the wiring that makes them one pipeline, and it owns exactly three decisions the parts
 * deliberately left open:
 *
 *  1. **Which arm to listen to, and where the raw master is written from.** The side filter is
 *     first and it matters -- see [DEFAULT_CAPTURE_SIDE]; the arms do NOT carry the same audio.
 *     After that, the pipeline hands out PCM while the archive wants the original 205-byte
 *     packets, so this class keeps its OWN [VoiceFramer] purely to answer "have I already got
 *     this counter?", and appends everything else verbatim -- on a thread of its own, because the
 *     BLE binder thread must never touch a file.
 *  2. **Where one clip ends and the next begins.** STT is billed and rate-limited per request, so
 *     the continuous stream has to be cut somewhere. See [Clipper].
 *  3. **What happens when nothing is configured.** Audio is captured and kept; clips pile up in
 *     [SttQueue] and drain the moment a provider appears. ⛔ Never dropped.
 *
 * ══ THREADS ════════════════════════════════════════════════════════════════════════════════
 * ```
 *   binder thread   [G2Central] -> submit()      : two non-blocking offers, nothing else
 *   decode thread   [VoicePipeline]              : LC3 -> PCM -> clip -> SttQueue.enqueue
 *   archive thread  this class                   : dedup + append 205 B to master.g2a
 *   upload thread   [SttQueue]                   : provider call + index write
 * ```
 * Four threads, each with one job, none of them the caller's.
 *
 * ⛔ PRIVACY. Nothing here logs audio, PCM, LC3 bytes, transcript text, or anything derived from
 * sample values. Counts and milliseconds only. The archive is app-private storage; the only
 * bytes that leave the device are the clips an explicitly-configured provider is sent.
 */
class VoiceService(
    private val context: Context,
    /** Counts-only log sink -- the same one the rest of the driver uses. */
    private val log: (String) -> Unit = {},
    /**
     * How a decoder is made. Defaulted to the real liblc3 binding; injectable so a test (or a
     * device whose `.so` failed to load) can substitute one.
     */
    private val decoderFactory: () -> Lc3Decoder = { NativeLc3Decoder() }
) {

    companion object {
        /** `<filesDir>/voice` -- one directory for the master archive, the queue and the config. */
        const val ROOT_DIR = "voice"

        /**
         * ★ **WHICH ARM WE ACTUALLY LISTEN TO. THE DEFAULT IS NOT ARBITRARY.**
         *
         * `[proven 2026-08-23, on hardware]` The RIGHT arm's encoder runs and ships a perfectly
         * healthy ~20 packets/s of **nothing**: speech and silence are statistically identical on
         * it (rms 3274 vs 3260, zero-crossing rate 0.434 vs 0.442, flat spectrum, no pauses). A
         * pipeline fed from the right arm therefore produces a flawless-looking stream that
         * decodes to noise -- which is indistinguishable from a decoder bug, and would send
         * somebody hunting through liblc3 for a week.
         *
         * MentraOS subscribes the LEFT arm and faceclaw drops the right outright
         * (`if (!"L".equals(arm)) return;`); our own 3,281-packet archive was 100% side=L. Three
         * independent implementations, one answer.
         *
         * ⚠️ **The two arms do NOT carry the same content**, so this is a FILTER, not a dedup
         * preference: [VoiceFramer]'s `gap == 0` rule assumes duplicates are copies of the same
         * audio, and if both arms reached it the surviving packet would be whichever lens's
         * notification won the race. Speech and noise would interleave at random. The side filter
         * has to come FIRST, and it does -- see [submit].
         */
        const val DEFAULT_CAPTURE_SIDE = "L"

        /** Where [exportSession] puts files a human can `adb pull`. */
        const val EXPORT_DIR = "voice-export"

        /**
         * Longest clip we will send to a provider, in seconds.
         *
         * `[hypothesis]` A ceiling has to exist because most STT endpoints reject or truncate
         * long uploads, and because a clip is also the unit of retry -- a 10-minute clip that
         * fails costs 10 minutes of re-upload. 20 s is short enough to retry cheaply and long
         * enough that a sentence is rarely cut. [SttConfig.maxClipSeconds] overrides it.
         */
        const val DEFAULT_CLIP_SECONDS = 20

        /**
         * Consecutive low-[VoicePacket.ssr] packets that end a clip early, at 20 packets/s.
         *
         * `[hypothesis]` -- `ssr` is computed on-glass as an energy ratio against a 10-frame
         * running mean, and we have never seen its numeric range on real speech. So this is a
         * HINT, not a gate: a clip that never sees silence still ends at the ceiling above, and
         * getting the threshold wrong costs clip boundaries, never audio. Tune it against a real
         * capture, not by feel.
         */
        const val SILENCE_PACKETS = 20

        /** `ssr` at or below this reads as "no speech". `[hypothesis]` -- see [SILENCE_PACKETS]. */
        const val SILENCE_SSR = 0

        /** Archive hand-off depth, in packets. Same 5 s of slack as the decode queue. */
        private const val ARCHIVE_QUEUE = 100
    }

    // -- the pieces ---------------------------------------------------------------------------

    private val root: File by lazy { File(context.filesDir, ROOT_DIR).also { it.mkdirs() } }
    private val archive: VoiceArchiveFiles by lazy { VoiceArchiveFiles(root) }

    /** The permanent searchable index. Opened lazily so a search does not require a capture. */
    val index: SqliteTranscriptIndex by lazy { SqliteTranscriptIndex(context) }

    val configStore: SttConfigStore by lazy { SttConfigStore(SttConfigStore.defaultFile(context.filesDir), log) }

    val providers: SttProviderFactory by lazy { SttProviderFactory(configStore, log) }

    /**
     * Fired on the [SttQueue] worker thread for each transcript that lands, after it is in
     * the index. Set by the caller to mirror the words somewhere -- in practice onto the
     * glasses via [LiveTextSink]. Volatile because it is assigned from the broadcast thread
     * and read from the worker.
     *
     * ⛔ Nothing here logs the text.
     */
    @Volatile var onTranscript: ((sessionId: String, text: String) -> Unit)? = null

    /**
     * WORD-BY-WORD. Set by the caller to receive the live provider's revisions while somebody
     * is still speaking -- `settled = false` REPLACES the previous tail, `settled = true` ends
     * it. Fired on the websocket thread, so an implementation must not block.
     *
     * Independent of [onTranscript], which is the durable path and fires once per stored clip.
     * When the socket cannot open, this simply never fires and nothing else changes.
     */
    @Volatile var onLiveText: ((text: String, settled: Boolean) -> Unit)? = null

    /** The live socket for the session in flight, if streaming is configured and reachable. */
    @Volatile private var liveStream: LiveSttStream? = null

    /**
     * True when a live streaming endpoint is configured AND its client is on the classpath --
     * i.e. when the face will be fed word by word rather than clip by clip. Callers use it to
     * decide whether the durable path should also paint, so the two never double up.
     */
    val streamingConfigured: Boolean
        get() = providers.config().streamingEnabled && LiveSttStream.available

    val queue: SttQueue by lazy {
        SttQueue(root, providers, index, log = log,
            onTranscript = { sid, text -> onTranscript?.invoke(sid, text) })
    }

    // -- session state ------------------------------------------------------------------------

    private val running = AtomicBoolean(false)

    @Volatile private var sessionId: String? = null
    @Volatile private var sessionStartedAtMs: Long = 0
    @Volatile private var writer: VoiceArchiveFiles.MasterWriter? = null
    @Volatile private var pipeline: VoicePipeline? = null
    @Volatile private var archiveThread: Thread? = null

    /**
     * The live clipper, held so [stop] can flush the tail. ⛔ See [Clipper.flushPending]: without
     * this reference a short session is archived as audio and NEVER transcribed.
     */
    @Volatile private var clipper: Clipper? = null

    /**
     * The last completed session's numbers, frozen at [stop].
     *
     * [stop] nulls `pipeline` and `writer`, which are where every count lives -- so without this
     * the final tally of a session becomes unreadable at exactly the moment somebody wants to
     * read it ("did that capture work? how many packets?"). [status] falls back to this snapshot
     * whenever no capture is running.
     */
    @Volatile private var lastStatus: Map<String, Any>? = null

    private val archiveQueue = ArrayBlockingQueue<ByteArray>(ARCHIVE_QUEUE)

    /** Packets the archive hand-off had to drop because its queue was full. Counts only. */
    @Volatile var archiveOverruns: Int = 0
        private set

    /**
     * The arm we listen to. `"L"` unless something has a very good reason -- read
     * [DEFAULT_CAPTURE_SIDE] before changing it, and expect noise if you set it to `"R"`.
     * Settable so a capture run can prove the right arm is what the hardware run says it is.
     */
    @Volatile var captureSide: String = DEFAULT_CAPTURE_SIDE

    /** Packets dropped because they came from the other arm. Counts only -- see [captureSide]. */
    @Volatile var otherSidePackets: Int = 0
        private set

    /**
     * True while a capture is running. ⚠️ This says the PHONE side is listening, not that the
     * glasses' microphone is open -- opening it is the on-glass stream's job, and the glasses can
     * also open it themselves (see `G2Central.onMicUnexpected`).
     */
    val isRunning: Boolean get() = running.get()

    // -- lifecycle ----------------------------------------------------------------------------

    /**
     * Begin a capture session. Returns the session id, or the current one if already running.
     *
     * Everything is started in dependency order and the archive writer FIRST: if the decode
     * thread produced a packet before the master was open, that packet would exist only as PCM
     * and could never be re-decoded.
     */
    @Synchronized
    fun start(): String {
        sessionId?.let { if (running.get()) return it }

        val id = newSessionId()
        val startedAt = System.currentTimeMillis()
        sessionId = id
        sessionStartedAtMs = startedAt

        writer = archive.open(id, startedAt).also {
            if (it.repairedBytes > 0) {
                log("voice: repaired a torn tail on reopen (${it.repairedBytes} B) session=$id")
            }
        }

        archiveQueue.clear()
        archiveOverruns = 0
        running.set(true)

        archiveThread = Thread({ archiveLoop() }, "ffs-voice-archive").apply {
            isDaemon = true
            priority = Thread.NORM_PRIORITY - 1
            start()
        }

        val clipper = Clipper(id, startedAt).also { this.clipper = it }

        // The live socket is best-effort by construction: if it will not open, `start()` says
        // so and the capture proceeds with the durable path alone. It is fed through [TeeSink]
        // so a failure inside it can never cost the clipper a chunk.
        val live = onLiveText?.let { cb ->
            val cfg = providers.config()
            if (!cfg.streamingEnabled) null else LiveSttStream(
                cfg = cfg,
                onInterim = { text -> cb(text, false) },
                onFinal = { text -> cb(text, true) },
                log = log
            ).takeIf { it.start() }
        }
        liveStream = live

        pipeline = VoicePipeline(
            decoderFactory = decoderFactory,
            sink = if (live == null) clipper else TeeSink(clipper, live, log),
            log = log
        ).also { it.start() }

        queue.start()

        index.upsertSession(
            VoiceSession(
                id = id,
                startedAtEpochMs = startedAt,
                endedAtEpochMs = null,
                masterPath = archive.masterFile(id).absolutePath
            )
        )

        log("voice: session $id started")
        return id
    }

    /**
     * End the capture. The upload queue is deliberately LEFT RUNNING: a session's last clips are
     * still owed a transcript, and stopping capture is not a reason to abandon them.
     */
    @Synchronized
    fun stop() {
        if (!running.getAndSet(false)) return
        val id = sessionId

        // DRAIN FIRST, and do not null `pipeline` yet: `stop()` joins the decode thread, which
        // means every packet still in flight is decoded and every stat published before anything
        // is torn down. Both the tail flush and the status snapshot below depend on that.
        pipeline?.stop()

        archiveThread?.let { t ->
            t.interrupt()
            t.join(2_000)
        }
        archiveThread = null
        drainArchiveQueue()

        // ⛔ THE TAIL. The decode thread is now dead, so nothing else can touch the clip buffer
        // and this is the only safe moment to flush it. Without this a session shorter than
        // `maxClipSeconds` -- which is MOST real sessions, somebody saying a sentence and
        // stopping -- is archived as perfectly good audio and produces NO transcript at all,
        // silently. That failure reads as a flaky STT provider, not as a clipping bug.
        try {
            clipper?.flushPending()
        } catch (e: Exception) {
            log("voice: tail clip flush failed (${e.javaClass.simpleName}) -- transcript lost, audio kept")
        }
        clipper = null

        // AFTER the decode thread is joined, so the socket has been fed every sample that was
        // in flight and the provider gets its close handshake with nothing left owing.
        try {
            liveStream?.stop()
        } catch (e: Exception) {
            log("voice: live stream stop threw (${e.javaClass.simpleName})")
        }
        liveStream = null

        // Freeze the numbers while the parts that hold them are still alive.
        lastStatus = liveStatus()
        pipeline = null

        val endedAt = System.currentTimeMillis()
        writer?.close(endedAt)
        val packets = writer?.packets ?: 0L
        writer = null

        if (id != null) {
            index.upsertSession(
                VoiceSession(
                    id = id,
                    startedAtEpochMs = sessionStartedAtMs,
                    endedAtEpochMs = endedAt,
                    masterPath = archive.masterFile(id).absolutePath,
                    packets = packets.toInt(),
                    durationMs = packets * VoiceFormat.PACKET_MS
                )
            )
        }
        log("voice: session ${id ?: "?"} stopped, $packets packets archived, overruns=$archiveOverruns")
    }

    /** Release everything, including the upload worker and the database. */
    @Synchronized
    fun shutdown() {
        stop()
        queue.stop()
    }

    // -- the BLE seam -------------------------------------------------------------------------

    /**
     * ⚠️ **CALLED ON A BLE BINDER THREAD, ~20 times a second, once per lens.** Everything here
     * is non-blocking by construction: two bounded offers and no allocation beyond one copy.
     *
     * Wire it with `central.onAudioPacket = { raw, side -> voice.submit(raw, side) }`.
     */
    fun submit(raw: ByteArray, side: String) {
        if (!running.get()) return

        // ★ SIDE FILTER FIRST, before the framer ever sees the packet. See DEFAULT_CAPTURE_SIDE:
        // the arms carry DIFFERENT audio, so letting both through would have the counter-based
        // duplicate rule pick a winner at random and interleave speech with the right arm's
        // noise. Counted, not silently swallowed.
        if (!side.equals(captureSide, ignoreCase = true)) {
            otherSidePackets++
            return
        }

        pipeline?.submit(raw, side)

        // The archive gets its own copy: `raw` belongs to the BLE stack and the pipeline pools
        // its own buffers, so neither is safe to hold across threads.
        if (raw.size != VoiceFormat.PACKET_BYTES) return
        if (!archiveQueue.offer(raw.copyOf())) {
            archiveOverruns++
        }
    }

    // -- archive thread -----------------------------------------------------------------------

    /**
     * Dedup and append. This framer exists ONLY to answer "duplicate?"; the decode path has its
     * own instance and the two must not share state -- one is deciding what to write to disk, the
     * other what to decode, and they can legitimately disagree about a resync.
     */
    private fun archiveLoop() {
        val dedup = VoiceFramer()
        while (running.get()) {
            val raw = try {
                archiveQueue.poll(200, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                break
            } ?: continue
            appendOne(dedup, raw)
        }
    }

    private fun drainArchiveQueue() {
        val dedup = VoiceFramer()
        while (true) {
            val raw = archiveQueue.poll() ?: break
            appendOne(dedup, raw)
        }
        writer?.flush()
    }

    private fun appendOne(dedup: VoiceFramer, raw: ByteArray) {
        val pkt = dedup.parse(raw, "?", System.currentTimeMillis()) ?: return
        if (dedup.offer(pkt) is FramerAction.Duplicate) return
        val w = writer ?: return
        try {
            w.append(raw)
            w.stats = pipeline?.stats() ?: w.stats
        } catch (e: Exception) {
            // A failed write is a hole in the only lossless copy we will ever have of this
            // moment. Say so loudly; do not stop the capture, because the rest of it is still
            // worth keeping.
            log("voice: ARCHIVE WRITE FAILED (${e.javaClass.simpleName}) -- audio is being lost")
        }
    }

    // -- fan-out ------------------------------------------------------------------------------

    /**
     * Feeds one decoded chunk to the DURABLE sink first and the disposable one second, and
     * swallows whatever the second one throws.
     *
     * The order is the whole point: [VoicePipeline] calls its sink on the decode thread and
     * counts a throw as a sink error, so a live socket having a bad day must never be able to
     * cost the clipper -- and therefore the archive and the permanent transcript -- a chunk.
     */
    private class TeeSink(
        private val durable: VoiceSink,
        private val live: LiveSttStream,
        private val log: (String) -> Unit
    ) : VoiceSink {
        override fun onChunk(chunk: VoiceAudioChunk) {
            durable.onChunk(chunk)
            try {
                live.feed(chunk.pcm, chunk.samples)
            } catch (t: Throwable) {
                log("voice: live feed threw (${t.javaClass.simpleName}) -- archive unaffected")
            }
        }

        override fun onStats(stats: VoiceFramerStats) = durable.onStats(stats)
    }

    // -- clipping -----------------------------------------------------------------------------

    /**
     * Turns the continuous PCM stream into clips and hands each to [SttQueue].
     *
     * Runs on the decode thread, so it does no network and no database work -- `enqueue` writes
     * one file and returns. The clip buffer is a plain growable array rather than a stream: a
     * clip is at most [DEFAULT_CLIP_SECONDS] seconds = 640 KB of `short`, which is nothing, and
     * having it contiguous is what lets the queue hand a provider one request body.
     */
    private inner class Clipper(
        private val sessionId: String,
        private val sessionStartedAtMs: Long
    ) : VoiceSink {

        private val maxSamples: Int
            get() {
                val cfgSeconds = providers.config().maxClipSeconds.coerceAtLeast(1)
                val seconds = minOf(cfgSeconds, DEFAULT_CLIP_SECONDS)
                return seconds * VoiceFormat.SAMPLE_RATE
            }

        private var buf = ShortArray(DEFAULT_CLIP_SECONDS * VoiceFormat.SAMPLE_RATE)
        private var used = 0
        private var clipStartSample = 0L
        private var sampleCursor = 0L
        private var quietPackets = 0

        override fun onChunk(chunk: VoiceAudioChunk) {
            if (used == 0) clipStartSample = sampleCursor

            val n = minOf(chunk.samples, buf.size - used)
            System.arraycopy(chunk.pcm, 0, buf, used, n)
            used += n
            sampleCursor += chunk.samples

            quietPackets = if (chunk.ssr <= SILENCE_SSR) quietPackets + 1 else 0

            val full = used >= maxSamples || used >= buf.size
            val settled = quietPackets >= SILENCE_PACKETS && used > 0
            if (full || settled) flushClip()
        }

        override fun onStats(stats: VoiceFramerStats) {
            writer?.stats = stats
        }

        /**
         * Flush whatever is in the buffer, however short. Called from [stop] once the decode
         * thread has been joined -- see the comment there for why the tail matters.
         */
        fun flushPending() = flushClip()

        /**
         * Hand the accumulated samples to the queue and start a new clip.
         *
         * ⛔ Failure here must not throw into the decode thread: a queue that cannot write is a
         * lost transcript, but an exception on this thread would be lost AUDIO.
         */
        private fun flushClip() {
            if (used <= 0) return
            val pcm = buf.copyOf(used)
            val startMs = clipStartSample * 1000L / VoiceFormat.SAMPLE_RATE
            val endMs = (clipStartSample + used) * 1000L / VoiceFormat.SAMPLE_RATE
            used = 0
            quietPackets = 0
            try {
                queue.enqueue(sessionId, startMs, endMs, pcm)
            } catch (e: Exception) {
                log("voice: clip enqueue failed (${e.javaClass.simpleName}) -- transcript lost, audio kept")
            }
        }
    }

    // -- read side ----------------------------------------------------------------------------

    /** Full-text search over every transcript ever made. Nothing has been deleted. */
    fun search(query: String, limit: Int = 50): List<VoiceSearchHit> = index.search(query, limit)

    /** Every session, newest first. */
    fun sessions(limit: Int = 100): List<VoiceSession> = index.listSessions(limit)

    /**
     * Re-decode an archived session to a WAV. This is the payoff of keeping the raw packets:
     * a session recorded today can be decoded again with a better decoder tomorrow.
     */
    fun deriveWav(sessionId: String, outWav: File): VoiceArchiveFiles.DeriveResult =
        decoderFactory().use { archive.deriveWav(archive.masterFile(sessionId), outWav, it) }

    /**
     * ⛔ **DEBUG AFFORDANCE. THIS PUTS A RECORDING WHERE `adb pull` CAN REACH IT.**
     *
     * Copies a session's raw master (and, if a decoder is available, a decoded WAV) out of
     * app-private storage into the app's EXTERNAL files directory:
     *
     * ```
     *   /sdcard/Android/data/<pkg>/files/voice-export/<sessionId>.g2a
     *   /sdcard/Android/data/<pkg>/files/voice-export/<sessionId>.wav
     * ```
     *
     * WHY IT EXISTS: the first real question this feature has to answer is "is there
     * intelligible speech on the left arm at all?", and that cannot be answered from counters --
     * somebody has to listen to a WAV. The raw `.g2a` goes too, because it is the lossless master
     * and a wrong decode should be re-runnable without re-recording.
     *
     * WHY IT IS NOT THE DEFAULT PATH: external files are readable by anything with storage
     * access and survive an uninstall prompt; app-private storage is not and does not. So this is
     * an explicit, per-session, human-triggered action, never something the capture does on its
     * own. ⛔ The exported files must never be committed to this PUBLIC repo -- `.gitignore`
     * denies the whole file type, and the exception list covers only synthetic fixtures.
     *
     * @return the absolute paths written, or an empty list if the session has no master.
     */
    fun exportSession(sessionId: String): List<String> {
        val master = archive.masterFile(sessionId)
        if (!master.isFile || master.length() == 0L) {
            log("voice: export skipped -- no master for session $sessionId")
            return emptyList()
        }
        val outDir = File(context.getExternalFilesDir(null) ?: context.filesDir, EXPORT_DIR)
        outDir.mkdirs()

        val written = ArrayList<String>(2)
        val rawOut = File(outDir, "$sessionId.g2a")
        master.copyTo(rawOut, overwrite = true)
        written.add(rawOut.absolutePath)

        val wavOut = File(outDir, "$sessionId.wav")
        try {
            val r = deriveWav(sessionId, wavOut)
            written.add(wavOut.absolutePath)
            log(
                "voice: exported session=$sessionId packets=${master.length() / VoiceFormat.PACKET_BYTES} " +
                    "samples=${r.samplesWritten} durationMs=${r.durationMs} concealed=${r.stats.concealed}"
            )
        } catch (e: Exception) {
            // A missing decoder must not cost us the raw master -- that is the half that cannot
            // be regenerated. Report and keep the .g2a.
            log("voice: export decoded WAV failed (${e.javaClass.simpleName}) -- raw master exported anyway")
        }
        return written
    }

    /** The most recent session that has a master on disk, or null. */
    fun latestSessionId(): String? = archive.listSessionIds().maxOrNull()

    /**
     * Counts and milliseconds only -- safe to log, safe to show, safe to ship.
     *
     * While a capture runs this is live. Once it has stopped, the parts that hold the counters
     * are gone, so this returns the snapshot frozen at [stop] -- the final tally of the session
     * you just recorded, which is precisely the moment the numbers are worth reading.
     */
    fun status(): Map<String, Any> {
        if (!running.get()) lastStatus?.let { return it }
        return liveStatus()
    }

    private fun liveStatus(): Map<String, Any> {
        val p = pipeline
        val fs = p?.stats() ?: VoiceFramerStats()
        val q = queue.stats()
        return linkedMapOf(
            "running" to running.get(),
            "sessionId" to (sessionId ?: ""),
            "captureSide" to captureSide,
            "otherSidePackets" to otherSidePackets,
            "packets" to fs.received,
            "duplicates" to fs.duplicates,
            "malformed" to fs.malformed,
            "concealedFrames" to fs.concealed,
            "resyncs" to fs.resyncs,
            "lostPackets" to fs.lostPackets,
            "decodeOverruns" to (p?.overruns ?: 0),
            "archiveOverruns" to archiveOverruns,
            "archivedPackets" to (writer?.packets ?: 0L),
            "sttPending" to q.pending,
            "sttProvider" to (providers.current()?.name ?: "none"),
            "decoderAvailable" to NativeLc3Decoder.available
        )
    }

    /**
     * Session ids are a UTC timestamp: they sort chronologically as filenames, they are unique at
     * the resolution a session can be started, and they carry no content.
     */
    private fun newSessionId(): String {
        val f = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return "s-" + f.format(java.util.Date())
    }
}
