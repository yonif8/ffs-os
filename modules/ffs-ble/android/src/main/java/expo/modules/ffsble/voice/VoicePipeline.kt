package expo.modules.ffsble.voice

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Where decoded audio and the numeric account of the stream come out.
 *
 * ⚠️ EVERY CALLBACK RUNS ON THE PIPELINE'S DECODE THREAD, serially, never re-entrantly, and
 * never on the BLE binder thread. An implementation that blocks in [onChunk] stalls decoding
 * and, once the queue fills, silently costs audio -- so anything slow (disk, network, the JS
 * bridge) belongs on its own queue behind this seam, not inside it.
 *
 * ⛔ A sink may not log, base64 or bridge [VoiceAudioChunk.pcm]. That is a RECORDING OF THE
 * WEARER; see `G2Central.onAudioPacket`.
 */
interface VoiceSink {
    fun onChunk(chunk: VoiceAudioChunk)

    /** A [VoiceFramer.stats] snapshot. Counts only -- safe to log, safe to show, safe to ship. */
    fun onStats(stats: VoiceFramerStats)
}

/**
 * The threading half of PACKET -> PCM: takes 205-byte notifications off the BLE binder thread
 * and turns them into 800-sample chunks on a thread of its own.
 *
 * ══ WHY A QUEUE AND A DEDICATED THREAD, AND NOT JUST DECODING IN THE CALLBACK ══════════════
 * `onCharacteristicChanged` runs on a BINDER THREAD owned by the Android Bluetooth stack. It is
 * not ours, it is shared with every other GATT callback on the process, and the stack delivers
 * the NEXT notification only after we return. Decoding five LC3 frames there means the BLE
 * stack's delivery rate is gated on liblc3, on this process's GC, and (if anyone ever adds it)
 * on disk. `[proven]` in the same shape elsewhere in this driver: the paced-write drain exists
 * because a blocked binder thread does not error, it just quietly loses throughput -- and the
 * firmware SILENTLY DROPS mic frames when its own tx queue backs up, so the loss would land
 * on-glass, upstream of anything we could measure.
 *
 * So [submit] is deliberately trivial: bounds-check, memcpy into a POOLED buffer, enqueue,
 * return. No decode, no allocation in the steady state, no lock held across anything slow, and
 * NO BLOCKING EVER -- an [ArrayBlockingQueue.offer] that fails evicts the OLDEST packet rather
 * than making the Bluetooth stack wait.
 *
 * ══ WHY OLDEST-DROP ═════════════════════════════════════════════════════════════════════════
 * If the decode thread has fallen [capacity] packets behind, the queue holds five seconds of
 * stale audio and the only question is which five seconds we lose. Dropping the NEWEST keeps a
 * growing lag forever -- the transcript falls further behind real time with every overrun and
 * never recovers. Dropping the OLDEST bounds the lag at [capacity] packets by construction. The
 * loss is counted in [overruns], and the counter is the point: a pipeline that drops audio must
 * say how much, out loud, in numbers.
 *
 * ══ WHY ONE DECODER, CREATED ON THE DECODE THREAD ═══════════════════════════════════════════
 * ⛔ ONE [Lc3Decoder] FOR THE WHOLE STREAM. The decoder carries state across frames; a fresh
 * instance per packet produces noise, and so does handing all 200 bytes to it as one frame
 * instead of five 40-byte frames. Both are documented failure signatures, not theory. The
 * instance is constructed inside [start]'s thread body so that the native handle is created,
 * used and closed on ONE thread and never crosses one -- JNI decoder state is not something to
 * find out about the hard way.
 *
 * ══ PRIVACY ════════════════════════════════════════════════════════════════════════════════
 * ⛔ No log line this class can emit contains audio, PCM, LC3 bytes, or anything derived from
 * sample VALUES. Counts, milliseconds and queue depths only. There is intentionally no debug
 * flag that changes that.
 */
class VoicePipeline(
    /**
     * Invoked ONCE, on the decode thread, at [start]. A factory rather than an instance so the
     * caller cannot accidentally share one native decoder between two streams (or construct it
     * on the wrong thread).
     */
    private val decoderFactory: () -> Lc3Decoder,
    private val sink: VoiceSink,
    /**
     * Queue depth in PACKETS. 100 packets x 50 ms = five seconds of slack -- enough to ride out
     * a GC pause or a slow sink, small enough that the memory is trivial (100 x 205 B) and that
     * "we are behind" turns into a counted overrun quickly rather than into unbounded latency.
     */
    private val capacity: Int = 100,
    /**
     * Monotonic clock, ms. Defaulted to [System.nanoTime] rather than
     * `android.os.SystemClock.elapsedRealtime` for one reason: this class must be constructible
     * in a plain-JVM unit test, and `SystemClock` is a stub that throws there.
     */
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L },
    /** Timestamped log sink. Counts and milliseconds ONLY -- see the privacy note above. */
    private val log: (String) -> Unit = {}
) {

    companion object {
        /**
         * Spare pooled buffers beyond [capacity]. A packet is in flight (owned by [submit] or by
         * the decode thread) while not in the queue, so a pool sized exactly to the queue
         * guarantees a miss under load. A handful of spares makes the steady state
         * allocation-free without pretending to be exact.
         */
        private const val POOL_SLACK = 8

        /**
         * Decode-thread poll interval. Sets the worst-case latency of [stop] noticing it should
         * wind down, and nothing else -- packets are delivered by the queue, not by the poll.
         */
        private const val POLL_MS = 50L

        /**
         * How long [stop] waits for the decode thread to finish draining before giving up and
         * reporting it. Generous: the drain is bounded by [capacity] packets of decode work.
         */
        private const val JOIN_MS = 3_000L

        /**
         * Publish a stats snapshot every N processed packets -- ~1 s at 20 packets/s. Per-packet
         * would put 20 sink calls a second on the decode thread for information that only ever
         * changes slowly.
         */
        private const val STATS_EVERY = 20
    }

    /**
     * One queued notification.
     *
     * Pooled and reused: [buf] is always [VoiceFormat.PACKET_BYTES] long, [len] records what
     * ACTUALLY arrived. Keeping the true length rather than rejecting on the binder thread is
     * what lets [VoiceFramer.parse] do the length assertion -- one place decides what a mic
     * packet is, and it is the tested one.
     */
    private class Slot {
        val buf = ByteArray(VoiceFormat.PACKET_BYTES)
        var len = 0
        var side = ""
        var tMs = 0L
    }

    private val queue = ArrayBlockingQueue<Slot>(capacity)
    private val pool = ArrayBlockingQueue<Slot>(capacity + POOL_SLACK)

    private val framer = VoiceFramer()
    private val running = AtomicBoolean(false)
    private val overrunCount = AtomicInteger(0)
    private val submittedCount = AtomicInteger(0)
    private val rejectedCount = AtomicInteger(0)
    private val sinkErrorCount = AtomicInteger(0)

    private var thread: Thread? = null

    @Volatile
    private var lastStats = VoiceFramerStats()

    init {
        // Preallocate the pool so the steady state never allocates on the binder thread. Doing
        // it here rather than lazily also means the memory cost is paid (and visible) up front.
        repeat(capacity + POOL_SLACK) { pool.offer(Slot()) }
    }

    /** Packets EVICTED from a full queue because the decode thread fell behind. */
    val overruns: Int get() = overrunCount.get()

    /** Packets accepted by [submit]. */
    val submitted: Int get() = submittedCount.get()

    /** Packets [submit] refused because the pipeline was not running. */
    val rejected: Int get() = rejectedCount.get()

    /** Exceptions thrown by [VoiceSink] and swallowed so they cannot kill the decode thread. */
    val sinkErrors: Int get() = sinkErrorCount.get()

    /** Current queue depth, in packets. */
    val depth: Int get() = queue.size

    /** True between a successful [start] and [stop]. */
    val isRunning: Boolean get() = running.get()

    /**
     * The most recently published framer snapshot. Safe to read from any thread and safe to log.
     * It lags the live counters by up to [STATS_EVERY] packets, which is deliberate -- see the
     * constant.
     */
    fun stats(): VoiceFramerStats = lastStats.copy()

    /**
     * Start the decode thread. Idempotent: a second call while running is a no-op, not a second
     * thread and not a second decoder.
     */
    @Synchronized
    fun start() {
        if (thread != null) return
        framer.reset()
        running.set(true)
        val t = Thread({ runDecodeLoop() }, "ffs-voice-decode")
        // Daemon: a forgotten pipeline must never be the reason the process refuses to exit.
        // stop() is still the correct shutdown; this is the backstop, not the plan.
        t.isDaemon = true
        thread = t
        t.start()
        log("voice: pipeline start (cap=$capacity)")
    }

    /**
     * Stop, DRAINING what is already queued (audio already paid for over the air is not thrown
     * away at shutdown), close the decoder and join the thread.
     *
     * Idempotent -- calling it twice, or without a [start], does nothing and reports nothing.
     * The join is bounded by [JOIN_MS]; a thread that misses that window is reported in the log
     * rather than left to be discovered as a leak.
     */
    @Synchronized
    fun stop() {
        val t = thread ?: return
        thread = null
        running.set(false)
        t.join(JOIN_MS)
        if (t.isAlive) log("voice: WARN decode thread still alive after ${JOIN_MS}ms")
        log("voice: pipeline stop (submitted=$submitted overruns=$overruns depth=${queue.size})")
    }

    /**
     * THE BLE BINDER THREAD'S ONLY ENTRY POINT. Non-blocking, allocation-free in the steady
     * state, and it never touches the decoder or the framer.
     *
     * [raw] is copied because the Android Bluetooth stack reuses (or may reuse) the value array
     * behind `characteristic.value` after the callback returns -- holding a reference to it is
     * a use-after-free in slow motion, and the symptom is corrupted audio, not a crash.
     */
    fun submit(raw: ByteArray, side: String) {
        if (!running.get()) {
            rejectedCount.incrementAndGet()
            return
        }
        val slot = pool.poll() ?: Slot()
        val n = if (raw.size < VoiceFormat.PACKET_BYTES) raw.size else VoiceFormat.PACKET_BYTES
        System.arraycopy(raw, 0, slot.buf, 0, n)
        // The TRUE length, not the clamped copy length: a 300-byte notification is malformed and
        // the framer must be able to say so. Clamping the copy only protects the buffer.
        slot.len = raw.size
        slot.side = side
        slot.tMs = clock()
        submittedCount.incrementAndGet()

        if (queue.offer(slot)) return

        // Full. Evict the OLDEST (see the class KDoc) and retry once. If the retry still fails,
        // a concurrent submit won the slot -- drop THIS packet instead and count it the same
        // way. Either way the binder thread returns immediately; that is non-negotiable.
        val evicted = queue.poll()
        if (evicted != null) {
            overrunCount.incrementAndGet()
            pool.offer(evicted)
        }
        if (!queue.offer(slot)) {
            overrunCount.incrementAndGet()
            pool.offer(slot)
        }
    }

    // -- decode thread -----------------------------------------------------------------------

    /**
     * The whole decode thread. ONE decoder, constructed here and closed here, so the native
     * handle never crosses a thread boundary.
     *
     * The loop polls with a timeout instead of blocking forever so that [stop] needs no poison
     * pill: `running == false` plus an empty queue is the exit condition, and "empty queue" is
     * what makes the shutdown a DRAIN rather than a truncation.
     */
    private fun runDecodeLoop() {
        val decoder = try {
            decoderFactory()
        } catch (t: Throwable) {
            log("voice: decoder init failed (${t.javaClass.simpleName})")
            running.set(false)
            return
        }
        var sinceStats = 0
        try {
            while (true) {
                val slot = queue.poll(POLL_MS, TimeUnit.MILLISECONDS)
                if (slot == null) {
                    // DRAIN-IDLE PUBLISH. The every-STATS_EVERY schedule below is an amortised
                    // cost control, but it makes `stats()` lag the live counters by up to 20
                    // packets -- and a caller polling `status()` to decide "has the decode thread
                    // caught up, is it safe to pull the file?" would be racing that lag. An empty
                    // queue means there is nothing left to catch up ON, so publish then: the
                    // snapshot is exact precisely when somebody is entitled to trust it.
                    if (sinceStats > 0) {
                        sinceStats = 0
                        publishStats()
                    }
                    if (!running.get()) break
                    continue
                }
                try {
                    process(decoder, slot)
                } catch (t: Throwable) {
                    // A single bad packet must not end the stream. Class name only -- never the
                    // message, which could in principle carry buffer contents.
                    log("voice: decode error (${t.javaClass.simpleName})")
                } finally {
                    slot.len = 0
                    pool.offer(slot)
                }
                if (++sinceStats >= STATS_EVERY) {
                    sinceStats = 0
                    publishStats()
                }
            }
        } finally {
            publishStats()
            try {
                decoder.close()
            } catch (t: Throwable) {
                log("voice: decoder close failed (${t.javaClass.simpleName})")
            }
        }
    }

    /** Parse -> framer decision -> conceal -> decode -> emit. All on the decode thread. */
    private fun process(decoder: Lc3Decoder, slot: Slot) {
        val packet = framer.parse(slot.buf, 0, slot.len, slot.side, slot.tMs) ?: return

        when (val action = framer.offer(packet)) {
            is FramerAction.Duplicate -> return

            is FramerAction.Resync -> {
                // Deliberately NO concealment: see FramerAction.Resync. Say how much was lost,
                // in packets and milliseconds, and move on.
                if (action.lostPackets > 0) {
                    log(
                        "voice: resync, lost=${action.lostPackets}pkt " +
                            "(${action.lostPackets * VoiceFormat.PACKET_MS}ms)"
                    )
                } else {
                    log("voice: resync, counter discontinuity")
                }
                emitPacket(decoder, packet)
            }

            is FramerAction.Deliver -> {
                if (action.concealBefore > 0) {
                    emitConcealment(decoder, packet, action.concealBefore)
                }
                emitPacket(decoder, packet)
            }
        }
    }

    /**
     * Synthesise the PLC frames that bridge a small gap, as one chunk PER MISSING PACKET.
     *
     * One chunk per missing packet (rather than one big one) keeps every [VoiceAudioChunk] the
     * same 50 ms shape as a real packet, which means everything downstream -- the WAV writer,
     * the STT segmenter -- has exactly one chunk size to reason about.
     *
     * The chunks are dated BACKWARDS from the packet that revealed the gap: we know when the
     * audio resumed, we never observed when it stopped, and back-dating is the only arithmetic
     * that keeps the timeline contiguous. `ssr`/`tdoa` are carried forward from the arriving
     * packet -- `[hypothesis]`, the least-wrong guess for an interval we have no measurement
     * for; `concealed = true` is the flag that lets a consumer distrust them.
     */
    private fun emitConcealment(decoder: Lc3Decoder, packet: VoicePacket, frames: Int) {
        val missing = frames / VoiceFormat.FRAMES_PER_PACKET
        for (k in 0 until missing) {
            val pcm = ShortArray(VoiceFormat.SAMPLES_PER_PACKET)
            for (f in 0 until VoiceFormat.FRAMES_PER_PACKET) {
                decoder.concealFrame(pcm, f * VoiceFormat.SAMPLES_PER_FRAME)
            }
            emit(
                VoiceAudioChunk(
                    pcm = pcm,
                    samples = VoiceFormat.SAMPLES_PER_PACKET,
                    ssr = packet.ssr,
                    tdoa = packet.tdoa,
                    concealed = true,
                    tMs = packet.tMs - (missing - k) * VoiceFormat.PACKET_MS
                )
            )
        }
    }

    /**
     * Decode the FIVE 40-byte frames of one packet into 800 samples.
     *
     * ⛔ THE LOOP IS THE POINT. `decodeFrame(lc3, off, 200, ...)` -- one call for all 200 bytes
     * -- compiles, returns success-looking values on some decoders and produces WHITE NOISE.
     * Five calls of 40 bytes each, through the SAME decoder instance, is the contract.
     *
     * A fresh [ShortArray] per chunk rather than a reused buffer: the chunk escapes to a sink
     * that may keep it (the archive certainly does), and handing out a buffer we intend to
     * overwrite 50 ms later is the kind of bug that shows up as one corrupted word in an hour
     * of transcript. 1.6 kB at 20/s is not worth being clever about.
     */
    private fun emitPacket(decoder: Lc3Decoder, packet: VoicePacket) {
        val pcm = ShortArray(VoiceFormat.SAMPLES_PER_PACKET)
        var bad = 0
        for (f in 0 until VoiceFormat.FRAMES_PER_PACKET) {
            val rc = decoder.decodeFrame(
                packet.lc3,
                packet.lc3Offset + f * VoiceFormat.FRAME_BYTES,
                VoiceFormat.FRAME_BYTES,
                pcm,
                f * VoiceFormat.SAMPLES_PER_FRAME
            )
            // liblc3: 0 = decoded, 1 = PLC ran and the OUTPUT IS VALID, <0 = bad parameters.
            // Only the negative case is a failure, and treating 1 as one is a documented trap.
            if (rc < 0) bad++
        }
        if (bad > 0) log("voice: $bad/${VoiceFormat.FRAMES_PER_PACKET} frames rejected by decoder")
        emit(
            VoiceAudioChunk(
                pcm = pcm,
                samples = VoiceFormat.SAMPLES_PER_PACKET,
                ssr = packet.ssr,
                tdoa = packet.tdoa,
                concealed = false,
                tMs = packet.tMs
            )
        )
    }

    private fun emit(chunk: VoiceAudioChunk) {
        try {
            sink.onChunk(chunk)
        } catch (t: Throwable) {
            sinkErrorCount.incrementAndGet()
            log("voice: sink error (${t.javaClass.simpleName})")
        }
    }

    private fun publishStats() {
        val snap = framer.stats()
        lastStats = snap
        try {
            sink.onStats(snap)
        } catch (t: Throwable) {
            sinkErrorCount.incrementAndGet()
            log("voice: sink stats error (${t.javaClass.simpleName})")
        }
    }
}
