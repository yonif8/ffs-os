package expo.modules.ffsble.voice

/**
 * LIVE TRANSCRIPTION ON GLASS -- the phone half.
 *
 * The loop is glasses -> phone -> STT -> phone -> glasses, with no PC anywhere in it: mic audio
 * arrives as LC3, [LiveSttStream] streams it to the provider word by word, and each revision is
 * pushed straight back to the on-glass reader app (`g2flash/apps/livetext.c`) over the FFSC data
 * channel. The durable [SttQueue] path writes the same words to the permanent index behind it.
 *
 * This is the shape Even's own conversate/translate use -- reading
 * `conversate_transcribe_data_update` 0x005ba53a settles it: the glasses never transcribe, they
 * render text the phone sends. The difference is that the channel and the renderer are both
 * ours, so there is no EvenHub page and no reflash in the loop.
 *
 * == COMMITTED vs PENDING ================================================================
 * A live provider revises itself: "so I" -> "so I thin" -> "so I think so". [setPending]
 * REPLACES the tail; [commit] settles it and starts a new one. The face therefore shows
 * `committed + " " + pending`, and a word being revised does not flicker the whole screen.
 *
 * == WHY A PUSHER THREAD ==================================================================
 * Interim messages arrive faster than a BLE link should be asked to repaint (Deepgram emits
 * several a second while a word is being said), and they arrive on the websocket thread, which
 * must never block. So mutations only set state and wake a coalescing thread: it pushes the
 * LATEST text at most once per [minIntervalMs], and skips a push whose bytes are identical to
 * the last (the glasses would drop it as a duplicate anyway -- `dup=yes`). A burst of ten
 * revisions in 300 ms therefore costs ONE frame on the radio, always the newest.
 *
 * == PRIVACY ==============================================================================
 * These bytes are what somebody said out loud. Nothing here logs, copies or persists them --
 * the permanent archive is [SqliteTranscriptIndex]'s job, and the only thing this class may
 * put in a log line is a COUNT.
 */
class LiveTextSink(
    /** The on-glass app_id to feed. Must match `@app id=` in `g2flash/apps/livetext.c`. */
    private val appId: Int = DEFAULT_APP_ID,
    /** Characters of history kept on the face. Below FFSC's 1024 B blob ceiling. */
    private val windowChars: Int = DEFAULT_WINDOW,
    /** Floor on the gap between two pushes, ms. Revisions inside one window coalesce. */
    private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
    /** Sends one ready FXP1 frame. Wired to `G2Central.pushToService(0x90, ...)`. */
    private val send: (ByteArray) -> Unit,
    /** COUNTS ONLY. Never the text. */
    private val log: ((String) -> Unit)? = null,
    /** Injectable clock + sleep so the coalescing is testable without real time. */
    private val now: () -> Long = { System.currentTimeMillis() }
) {
    companion object {
        const val DEFAULT_APP_ID = 14
        const val DEFAULT_WINDOW = 880
        /**
         * Floor on the gap between pushes. Every millisecond here is latency the wearer
         * sees, so it is set from what the radio can actually carry rather than from
         * caution. It was briefly cut to 150 ms to shave latency, and put back: the two
         * lenses only paint on AGREEMENT (g2flash/apps/livetext.c -- no lens ever paints
         * alone), and agreement takes ~180 ms, so pushing faster than that just means the
         * pair is still negotiating value N when N+1 lands and the newest text is never
         * the one being agreed on. The push rate has to sit above the agreement time.
         */
        const val DEFAULT_MIN_INTERVAL_MS = 300L
    }

    private val lock = Object()
    private val committed = StringBuilder()
    private var pendingText = ""
    private var seq = 0
    private var lastSent: String? = null
    private var dirty = false
    private var pushes = 0L
    private var coalesced = 0L
    private var worker: Thread? = null
    @Volatile private var running = false

    // -- lifecycle ------------------------------------------------------------------------

    /** Start the coalescing pusher. Idempotent. */
    fun start() {
        synchronized(lock) {
            if (running) return
            running = true
            worker = Thread({ loop() }, "livetext-push").apply { isDaemon = true; start() }
        }
    }

    /**
     * Stop the pusher, flushing whatever is still pending FIRST -- the last words of a session
     * are exactly the ones somebody is still looking at.
     */
    fun stop() {
        val w = synchronized(lock) {
            if (!running) return
            running = false
            lock.notifyAll()
            worker.also { worker = null }
        }
        flushNow()
        try { w?.join(1_000) } catch (_: InterruptedException) {}
        log?.invoke("livetext: pushes=$pushes coalesced=$coalesced")
    }

    // -- text -----------------------------------------------------------------------------

    /** Replace the unsettled tail with a better guess. */
    fun setPending(text: String) {
        val clean = fold(text)
        synchronized(lock) {
            if (clean == pendingText) return
            pendingText = clean
            dirty = true
            lock.notifyAll()
        }
    }

    /** Settle the tail: append it to history and start a new one. */
    fun commit(text: String) {
        val clean = fold(text)
        synchronized(lock) {
            pendingText = ""
            if (clean.isNotEmpty()) {
                if (committed.isNotEmpty()) committed.append(' ')
                committed.append(clean)
                if (committed.length > windowChars) committed.delete(0, committed.length - windowChars)
            }
            dirty = true
            lock.notifyAll()
        }
    }

    /**
     * Append settled text with no live tail involved -- what the durable [SttQueue] path calls
     * when live streaming is off, so the face still fills a sentence at a time.
     */
    fun append(text: String) = commit(text)

    /** Wipe the face and the window (a new session, or the wearer asked). */
    fun reset() {
        val n: Int
        synchronized(lock) {
            committed.setLength(0)
            pendingText = ""
            lastSent = null
            dirty = false
            n = nextSeqLocked()
        }
        try {
            send(FfscFrame.clear(appId, n))
            log?.invoke("livetext: cleared")
        } catch (t: Throwable) {
            log?.invoke("livetext: clear failed (${t.javaClass.simpleName})")
        }
    }

    /** Current window length in characters -- a count, which is all that may be logged. */
    fun size(): Int = synchronized(lock) { face().length }

    /** Push right now, ignoring the interval. Used by [stop] and by tests. */
    fun flushNow() {
        val body: ByteArray
        val n: Int
        synchronized(lock) {
            val text = face()
            if (!dirty || text == lastSent) { dirty = false; return }
            lastSent = text
            dirty = false
            n = nextSeqLocked()
            body = clamp(text.toByteArray(Charsets.US_ASCII))
        }
        push(body, n)
    }

    // -- internals ------------------------------------------------------------------------

    /** Caller holds [lock]. */
    private fun face(): String =
        if (pendingText.isEmpty()) committed.toString()
        else if (committed.isEmpty()) pendingText
        else "$committed $pendingText"

    /** Caller holds [lock]. Seq 0 is never used: it would look like a fresh channel. */
    private fun nextSeqLocked(): Int {
        seq = (seq + 1) and 0xFFFF
        if (seq == 0) seq = 1
        return seq
    }

    private fun loop() {
        var lastPush = 0L
        while (true) {
            var wait: Long
            synchronized(lock) {
                while (running && !dirty) lock.wait(1_000)
                if (!running) return
                val since = now() - lastPush
                wait = if (since >= minIntervalMs) 0 else minIntervalMs - since
            }
            if (wait > 0) {
                // Everything that arrives during this sleep is absorbed into the same push.
                try { Thread.sleep(wait) } catch (_: InterruptedException) { return }
                synchronized(lock) { coalesced++ }
            }
            if (!running) return
            lastPush = now()
            flushNow()
        }
    }

    /** A blob over the ceiling keeps its NEWEST bytes -- the words still being read. */
    private fun clamp(blob: ByteArray): ByteArray =
        if (blob.size > FfscFrame.MAX_BLOB) blob.copyOfRange(blob.size - FfscFrame.MAX_BLOB, blob.size)
        else blob

    private fun push(blob: ByteArray, n: Int) {
        if (blob.isEmpty()) return
        try {
            send(FfscFrame.put(appId, n, blob))
            synchronized(lock) { pushes++ }
            log?.invoke("livetext: pushed seq=$n (${blob.size} B, text not logged)")
        } catch (t: Throwable) {
            // A dropped push costs one repaint; the transcript is already in the index.
            log?.invoke("livetext: push failed (${t.javaClass.simpleName})")
        }
    }

    /**
     * Fold to the printable ASCII the on-glass 5x7 face can actually draw (0x20..0x7E). Common
     * Latin-1 accents lose their diacritic instead of becoming a box (the face draws a visible
     * box for a byte it has no glyph for -- honest, but unreadable); anything else becomes a
     * space, and runs of whitespace collapse.
     */
    private fun fold(s: String): String {
        val out = StringBuilder(s.length)
        var lastSpace = true
        for (ch in s) {
            val c = when {
                ch.code in 0x20..0x7E -> ch
                ch == '’' || ch == '‘' -> '\''
                ch == '“' || ch == '”' -> '"'
                ch == '–' || ch == '—' -> '-'
                ch == '…' -> '.'
                else -> ACCENTS[ch] ?: ' '
            }
            if (c == ' ') {
                if (lastSpace) continue
                lastSpace = true
            } else {
                lastSpace = false
            }
            out.append(c)
        }
        return out.toString().trim()
    }

    private val ACCENTS: Map<Char, Char> = buildMap {
        "àáâãäå".forEach { put(it, 'a') }
        "ÀÁÂÃÄÅ".forEach { put(it, 'A') }
        "èéêë".forEach { put(it, 'e') }
        "ÈÉÊË".forEach { put(it, 'E') }
        "ìíîï".forEach { put(it, 'i') }
        "ÌÍÎÏ".forEach { put(it, 'I') }
        "òóôõö".forEach { put(it, 'o') }
        "ÒÓÔÕÖ".forEach { put(it, 'O') }
        "ùúûü".forEach { put(it, 'u') }
        "ÙÚÛÜ".forEach { put(it, 'U') }
        put('ñ', 'n'); put('Ñ', 'N'); put('ç', 'c'); put('Ç', 'C')
    }
}
