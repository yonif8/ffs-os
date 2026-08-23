package expo.modules.ffsble.voice

import java.io.File

/**
 * The durable transcription worker: PCM clips in, [VoiceSegment] rows out, across app kills.
 *
 * ⛔ **NOTHING IS EVER DROPPED, TRUNCATED OR AUTO-DELETED.** That is the single design rule
 * this class exists to enforce, and every other decision here follows from it:
 *
 *   * An item that has failed a thousand times is still pending. There is no dead-letter bin,
 *     no `maxAttempts` after which work is discarded, no TTL. A permanently-failing item is a
 *     bug or a misconfiguration; deleting it destroys the only evidence AND the audio.
 *   * With `providerKind=none` items simply ACCUMULATE. "No provider configured" is a normal
 *     steady state -- the glasses keep listening, the archive keeps growing, and the day a
 *     provider is configured the whole backlog transcribes. `[proven]` by
 *     `SttQueueBacklogTest`: enqueue with no provider, configure the mock, drain, find text.
 *   * The PCM handed to [enqueue] is COPIED to its own file under [pcmDir] before the item is
 *     acknowledged, so a kill between "session ended" and "upload succeeded" loses nothing.
 *     That copy is kept after success too -- see [PcmRetention].
 *
 * DURABILITY MECHANISM
 * --------------------
 * One JSONL file, [queueFile], rewritten atomically (`.tmp` + rename) on every mutation. JSONL
 * rather than one JSON document so a truncated tail costs one item instead of the whole queue,
 * and rewrite-whole rather than append-only because the queue is small (tens of items) and a
 * compactor is one more thing to get wrong.
 *
 * THREADING
 * ---------
 * One worker thread, started by [start] and stopped by [stop]. [enqueue] is safe from any
 * thread. All mutation of the in-memory list happens under `lock`. Tests can skip the thread
 * entirely and call [drainOnce] synchronously, which is what makes the backlog behaviour
 * assertable without sleeping.
 *
 * ⛔ **LOGGING IS COUNTS-ONLY.** Never a transcript, never a filename that embeds one, never a
 * provider error containing a body. [SttResult.error] is already constrained to a short
 * reason code by [HttpSttProvider]; this class passes it through unchanged and nothing else.
 */
class SttQueue(
    /** Directory the queue owns. Typically `<filesDir>/voice/`. */
    private val root: File,
    private val providers: SttProviderFactory,
    private val index: TranscriptIndex,
    /** Wall clock, ms. Injectable so backoff is testable without sleeping. */
    private val clock: () -> Long = { System.currentTimeMillis() },
    /** Counts-only log sink. */
    private val log: ((String) -> Unit)? = null,
    /**
     * Fired on the worker thread for every transcript that lands, AFTER it is safely in the
     * index -- so a listener that throws can cost a repaint but never a stored transcript.
     * Used to mirror the words onto the glasses ([LiveTextSink]).
     *
     * ⛔ The text is the callee's to handle; nothing in this class logs it.
     */
    private val onTranscript: ((sessionId: String, text: String) -> Unit)? = null
) {

    companion object {
        const val QUEUE_FILE = "stt-queue.jsonl"
        const val PCM_DIR = "stt-pcm"

        /** Idle poll interval for the worker thread when the queue is empty. */
        private const val IDLE_WAIT_MS = 30_000L
    }

    /**
     * Why the copied PCM survives a successful transcription.
     *
     * A transcript is lossy and a provider can be wrong. Keeping the clip means a future
     * provider (or a better model at the same provider) can re-transcribe the archive without
     * the user having said anything twice. Disk is cheap: 16 kHz mono s16 is 32 kB/s, so an
     * hour of speech is ~115 MB and a realistic day of clipped speech is far less. If this
     * ever needs a bound it must be a USER-INVOKED cleanup, never a background policy.
     */
    object PcmRetention

    /** One unit of work. Immutable except for the retry bookkeeping. */
    data class Item(
        val id: Long,
        val sessionId: String,
        val startMs: Long,
        val endMs: Long,
        /** Absolute path of the s16le PCM clip. */
        val pcmPath: String,
        val sampleRate: Int = VoiceFormat.SAMPLE_RATE,
        val enqueuedAtMs: Long = 0L,
        var attempts: Int = 0,
        /** Earliest clock at which the next attempt may run (backoff). */
        var nextAttemptAtMs: Long = 0L,
        /** Short reason code from the last failure. ⛔ Never a body, never text. */
        var lastError: String? = null
    ) {
        fun toJson(): String = MiniJson.write(
            linkedMapOf<String, Any?>(
                "id" to id, "sessionId" to sessionId, "startMs" to startMs, "endMs" to endMs,
                "pcmPath" to pcmPath, "sampleRate" to sampleRate,
                "enqueuedAtMs" to enqueuedAtMs, "attempts" to attempts,
                "nextAttemptAtMs" to nextAttemptAtMs, "lastError" to lastError
            )
        )

        companion object {
            fun fromJson(line: String): Item? {
                val m = MiniJson.parseOrNull(line) as? Map<*, *> ?: return null
                val id = MiniJson.long(m, "id", -1L)
                val sid = MiniJson.str(m, "sessionId", "")
                val path = MiniJson.str(m, "pcmPath", "")
                if (id < 0 || sid.isEmpty() || path.isEmpty()) return null
                return Item(
                    id = id,
                    sessionId = sid,
                    startMs = MiniJson.long(m, "startMs", 0L),
                    endMs = MiniJson.long(m, "endMs", 0L),
                    pcmPath = path,
                    sampleRate = MiniJson.int(m, "sampleRate", VoiceFormat.SAMPLE_RATE),
                    enqueuedAtMs = MiniJson.long(m, "enqueuedAtMs", 0L),
                    attempts = MiniJson.int(m, "attempts", 0),
                    nextAttemptAtMs = MiniJson.long(m, "nextAttemptAtMs", 0L),
                    lastError = m["lastError"] as? String
                )
            }
        }
    }

    /** Counts only -- the whole of what may be logged or bridged to JS about the queue. */
    data class Stats(
        var enqueued: Long = 0,
        var transcribed: Long = 0,
        var failures: Long = 0,
        var pending: Int = 0,
        var waitingForProvider: Long = 0
    )

    private val lock = Object()
    private val pending = ArrayList<Item>()
    private val stats = Stats()
    private var nextId = 1L
    private var worker: Thread? = null
    @Volatile private var running = false

    val queueFile: File get() = File(root, QUEUE_FILE)
    val pcmDir: File get() = File(root, PCM_DIR)

    init {
        if (!root.exists()) root.mkdirs()
        if (!pcmDir.exists()) pcmDir.mkdirs()
        loadPending()
    }

    // -- enqueue -----------------------------------------------------------------------------

    /**
     * Add a clip. The samples are written to their own file BEFORE the item is persisted and
     * before this returns, so the caller may reuse its buffer immediately and a crash one
     * instruction later still leaves recoverable work.
     *
     * Returns the item id.
     */
    fun enqueue(
        sessionId: String,
        startMs: Long,
        endMs: Long,
        pcm: ShortArray,
        sampleRate: Int = VoiceFormat.SAMPLE_RATE
    ): Long {
        val id: Long
        synchronized(lock) { id = nextId++ }
        val f = File(pcmDir, "clip-$id.pcm")
        f.writeBytes(HttpSttProvider.pcmToLeBytes(pcm))
        return enqueueFile(sessionId, startMs, endMs, f, sampleRate, id)
    }

    /**
     * Add a clip that is ALREADY on disk as s16le PCM. Used by the archive writer, which has
     * the bytes in a file anyway and should not pay for a second copy.
     *
     * ⚠️ The queue does not take ownership of a path it did not create: it never deletes it.
     */
    @JvmOverloads
    fun enqueueFile(
        sessionId: String,
        startMs: Long,
        endMs: Long,
        pcmFile: File,
        sampleRate: Int = VoiceFormat.SAMPLE_RATE,
        forcedId: Long? = null
    ): Long {
        val item: Item
        synchronized(lock) {
            val id = forcedId ?: nextId++
            item = Item(
                id = id, sessionId = sessionId, startMs = startMs, endMs = endMs,
                pcmPath = pcmFile.absolutePath, sampleRate = sampleRate,
                enqueuedAtMs = clock()
            )
            pending.add(item)
            if (id >= nextId) nextId = id + 1
            stats.enqueued++
            stats.pending = pending.size
            persist()
            lock.notifyAll()
        }
        log?.invoke("stt-queue: enqueued id=${item.id} pending=${stats.pending}")
        return item.id
    }

    // -- draining ----------------------------------------------------------------------------

    /**
     * Run ONE pass over the pending items, synchronously, on the calling thread.
     *
     * Returns the number of items successfully transcribed. Zero with a non-empty queue is
     * normal and not an error -- it is what "no provider yet" looks like.
     *
     * Retry policy: within a pass an item gets up to [SttConfig.retryAttempts] tries; on the
     * last failure it takes an exponential backoff (doubling from [SttConfig.retryBackoffMs],
     * capped at [SttConfig.retryMaxBackoffMs]) and STAYS PENDING.
     */
    fun drainOnce(): Int {
        val provider = providers.current()
        if (provider == null || !provider.isConfigured()) {
            synchronized(lock) {
                stats.waitingForProvider++
                stats.pending = pending.size
            }
            if (pending.isNotEmpty()) {
                log?.invoke("stt-queue: no provider; ${pending.size} item(s) waiting (kept)")
            }
            return 0
        }

        // Retry/limit knobs come from the same config the provider does. With the mock (which
        // has no config file of its own) this is `SttConfig.NONE`, whose retry defaults are
        // exactly what we want anyway.
        val cfg = providers.config()
        val now = clock()
        val batch: List<Item> = synchronized(lock) {
            pending.filter { it.nextAttemptAtMs <= now }.toList()
        }
        var done = 0
        for (item in batch) {
            if (!running && worker != null) break // stop() asked us to wind down
            if (transcribeItem(item, provider, cfg)) done++
        }
        synchronized(lock) { stats.pending = pending.size }
        if (done > 0) log?.invoke("stt-queue: drained $done, pending=${stats.pending}")
        return done
    }

    /** Attempt one item. Returns true if a segment was written. */
    private fun transcribeItem(item: Item, provider: SttProvider, cfg: SttConfig): Boolean {
        val pcm = try {
            readPcm(File(item.pcmPath))
        } catch (t: Throwable) {
            // The clip file is missing or unreadable. ⛔ Still not dropped: back off and keep
            // it, because a missing file is far more likely to be a storage hiccup or an
            // unmounted volume than genuinely-lost work.
            failItem(item, "pcm-unreadable:${t.javaClass.simpleName}", cfg)
            return false
        }

        val attempts = maxOf(1, cfg.retryAttempts)
        var last: SttResult? = null
        for (n in 0 until attempts) {
            item.attempts++
            last = try {
                provider.transcribe(
                    SttRequest(
                        pcm = pcm, sampleRate = item.sampleRate, sessionId = item.sessionId,
                        startMs = item.startMs, endMs = item.endMs
                    )
                )
            } catch (t: Throwable) {
                SttResult(false, "", null, provider.name, error = "throw:${t.javaClass.simpleName}")
            }
            if (last.ok) break
        }

        val r = last ?: return false
        if (!r.ok) {
            failItem(item, r.error ?: "unknown", cfg)
            return false
        }

        index.addSegment(
            sessionId = item.sessionId,
            startMs = item.startMs,
            endMs = item.endMs,
            text = r.text,
            confidence = r.confidence,
            provider = r.provider
        )
        synchronized(lock) {
            pending.removeAll { it.id == item.id }
            stats.transcribed++
            stats.pending = pending.size
            persist()
        }
        // ⛔ chars, not text.
        log?.invoke("stt-queue: id=${item.id} ok (${r.text.length} chars, not logged)")
        // The row is already committed above, so a listener that throws costs at most a
        // repaint on the face -- never the transcript.
        if (r.text.isNotEmpty()) {
            try {
                onTranscript?.invoke(item.sessionId, r.text)
            } catch (t: Throwable) {
                log?.invoke("stt-queue: onTranscript threw (${t.javaClass.simpleName}) -- row kept")
            }
        }
        return true
    }

    private fun failItem(item: Item, reason: String, cfg: SttConfig) {
        synchronized(lock) {
            item.lastError = reason
            var back = cfg.retryBackoffMs.coerceAtLeast(1L)
            val steps = minOf(item.attempts, 20)
            for (i in 1 until steps) {
                back *= 2
                if (back >= cfg.retryMaxBackoffMs) { back = cfg.retryMaxBackoffMs; break }
            }
            item.nextAttemptAtMs = clock() + back
            stats.failures++
            persist()
        }
        log?.invoke("stt-queue: id=${item.id} failed ($reason), attempts=${item.attempts}, kept")
    }

    /** s16le bytes -> samples. */
    internal fun readPcm(f: File): ShortArray {
        val bytes = f.readBytes()
        val out = ShortArray(bytes.size / 2)
        for (i in out.indices) {
            out[i] = (((bytes[i * 2 + 1].toInt() and 0xFF) shl 8) or
                      (bytes[i * 2].toInt() and 0xFF)).toShort()
        }
        return out
    }

    // -- worker thread -----------------------------------------------------------------------

    /** Start the background worker. Idempotent. */
    fun start() {
        synchronized(lock) {
            if (running) return
            running = true
            worker = Thread({ loop() }, "stt-queue").apply { isDaemon = true; start() }
        }
        log?.invoke("stt-queue: worker started, pending=${pending.size}")
    }

    /** Stop the worker and wait briefly for it. Pending work stays on disk. */
    fun stop() {
        val t = synchronized(lock) {
            running = false
            lock.notifyAll()
            worker.also { worker = null }
        }
        try { t?.join(2_000) } catch (_: InterruptedException) { }
        log?.invoke("stt-queue: worker stopped, pending=${pending.size}")
    }

    /** Wake the worker -- call after the config changes so a backlog drains immediately. */
    fun poke() { synchronized(lock) { lock.notifyAll() } }

    private fun loop() {
        while (running) {
            try {
                drainOnce()
            } catch (t: Throwable) {
                log?.invoke("stt-queue: pass threw ${t.javaClass.simpleName}; continuing")
            }
            synchronized(lock) {
                if (!running) return
                // Sleep until the earliest scheduled retry, or the idle interval.
                val now = clock()
                val soonest = pending.minOfOrNull { it.nextAttemptAtMs } ?: (now + IDLE_WAIT_MS)
                val waitMs = (soonest - now).coerceIn(1_000L, IDLE_WAIT_MS)
                try { lock.wait(waitMs) } catch (_: InterruptedException) { return }
            }
        }
    }

    // -- persistence -------------------------------------------------------------------------

    private fun loadPending() {
        val f = queueFile
        if (!f.exists()) return
        var maxId = 0L
        try {
            f.forEachLine { line ->
                if (line.isNotBlank()) {
                    val item = Item.fromJson(line)
                    // ⚠️ A malformed line is SKIPPED, not fatal: a torn tail from a kill mid-
                    // write costs the last item, and the rest of the backlog survives.
                    if (item != null) {
                        pending.add(item)
                        if (item.id > maxId) maxId = item.id
                    }
                }
            }
        } catch (t: Throwable) {
            log?.invoke("stt-queue: queue file unreadable (${t.javaClass.simpleName})")
        }
        nextId = maxId + 1
        stats.pending = pending.size
        log?.invoke("stt-queue: recovered ${pending.size} pending item(s)")
    }

    /** Rewrite the queue file. Caller holds [lock]. */
    private fun persist() {
        try {
            val tmp = File(root, "$QUEUE_FILE.tmp")
            tmp.bufferedWriter(Charsets.UTF_8).use { w ->
                for (item in pending) { w.write(item.toJson()); w.write("\n") }
            }
            if (queueFile.exists()) @Suppress("ResultOfMethodCallIgnored") queueFile.delete()
            if (!tmp.renameTo(queueFile)) {
                tmp.copyTo(queueFile, overwrite = true)
                @Suppress("ResultOfMethodCallIgnored") tmp.delete()
            }
        } catch (t: Throwable) {
            // ⛔ A persistence failure must not lose the in-memory queue.
            log?.invoke("stt-queue: persist failed (${t.javaClass.simpleName}); memory intact")
        }
    }

    // -- introspection -----------------------------------------------------------------------

    /** Snapshot of the counters. Counts only. */
    fun stats(): Stats = synchronized(lock) { stats.copy(pending = pending.size) }

    /** Number of items still waiting. */
    fun pendingCount(): Int = synchronized(lock) { pending.size }

    /** Read-only view of the pending items, for a diagnostics screen. */
    fun pendingSnapshot(): List<Item> = synchronized(lock) { pending.toList() }
}
