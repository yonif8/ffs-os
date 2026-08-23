package expo.modules.ffsble.voice

/**
 * What [VoiceFramer.offer] decided to do with one arriving packet.
 *
 * The framer NEVER touches audio bytes and never decodes: it hands back an instruction and the
 * caller (always [VoicePipeline], always on the decode thread) carries it out. That split is
 * what makes the loss/duplicate rules -- the part with all the off-by-one danger in it --
 * testable on a plain JVM with no decoder, no BLE and no threads.
 */
sealed class FramerAction {
    /**
     * Drop it. Either the OTHER lens's copy of a packet we already decoded, or a packet that
     * arrived slightly out of order and is behind the stream head.
     *
     * BOTH LENSES NOTIFY THE SAME AUDIO with the SAME counter `[proven]` -- see [VoiceFormat].
     * A duplicate is the normal steady state, not an anomaly: at ~20 packets/s per lens we
     * expect to drop ~20 packets/s here forever while both lenses are subscribed.
     */
    object Duplicate : FramerAction()

    /**
     * Decode this packet's five frames. [concealBefore] frames of packet-loss concealment must
     * be synthesised FIRST (via [Lc3Decoder.concealFrame]) to bridge the firmware's silent
     * drop, and it is always a multiple of [VoiceFormat.FRAMES_PER_PACKET].
     */
    data class Deliver(val concealBefore: Int) : FramerAction()

    /**
     * The gap was too big to paper over ([VoiceFramer.MAX_CONCEAL_GAP] packets). Audio is
     * genuinely, irrecoverably missing; concealing a second of it would fabricate a second of
     * plausible-sounding speech that was never said, which is far worse for a transcript than
     * a hole. So: count [lostPackets], log the number, and decode this packet as the new head.
     *
     * A `Resync` still DELIVERS the packet -- it is `Deliver(0)` plus an accounting entry.
     */
    data class Resync(val lostPackets: Int) : FramerAction()
}

/**
 * The loss / duplicate / wraparound accounting for the S-VOICE microphone stream.
 *
 * WHY THIS IS PURE
 * ----------------
 * NO ANDROID IMPORTS, NO THREADS, NO I/O, NO DECODER. Every hard-won rule about this pipe lives
 * in the mod-256 arithmetic below, and every one of those rules is a place a plausible
 * implementation is silently wrong for hours of recording before anybody notices. Keeping the
 * rules in an object with no dependencies means `./gradlew :ffs-ble:test` proves them in
 * milliseconds instead of a wearer proving them in a stale transcript.
 *
 * THE THREE RULES
 * ---------------
 * 1. **The counter is the only loss signal.** `[proven]` from the wire format: byte 204 is a
 *    mod-256 counter and there is no CRC, no sequence number and no in-band header on this
 *    characteristic. If the counter does not say a packet went missing, nothing does.
 * 2. **Gaps are NORMAL.** `[proven]` -- the firmware SILENTLY DROPS mic frames when its tx
 *    queue is half full. A gap is back-pressure, not a bug in the phone, and the correct
 *    response is PLC, not an error.
 * 3. **A duplicate is not a stall.** Both lenses notify the same 50 ms with the same counter,
 *    so `delta == 0` means "the other eye's copy", never "the glasses stopped counting".
 *
 * THREADING
 * ---------
 * NOT thread-safe, deliberately -- no locks in the hot path. [VoicePipeline] owns one instance
 * and touches it ONLY from its single decode thread, which is also the reason the BLE binder
 * thread is not allowed anywhere near it.
 *
 * PRIVACY
 * -------
 * This class never copies, hashes, logs or exposes a byte of LC3 payload. [parse] returns a
 * [VoicePacket] whose `lc3` field ALIASES the caller's buffer; the only state kept here is a
 * counter and six integers. See `G2Central.onAudioPacket` for why that is structural.
 */
class VoiceFramer {

    companion object {
        /**
         * Largest gap, in packets, we will bridge with concealment.
         *
         * `[hypothesis]` 8 packets = 400 ms = 40 PLC frames. liblc3's concealment is designed
         * to ride out a handful of frames; past a few hundred milliseconds it decays to
         * noise-ish filler and, worse, that filler is indistinguishable from speech to an STT
         * provider. Beyond this we resync and say so out loud. Tune with real recordings, not
         * by feel.
         */
        const val MAX_CONCEAL_GAP = 8

        /**
         * How far BEHIND the stream head a packet may be and still be treated as a duplicate
         * rather than a discontinuity.
         *
         * Two lenses on two independent GATT links do not arrive in lockstep: `[mapped]` the
         * right lens is the master and generally leads, but a scheduling hiccup on either link
         * can hand us R(n) then L(n-1). Without this window that reordering reads as a gap of
         * 255 and would trigger a bogus resync on every hiccup.
         */
        const val STALE_LOOKBACK = 8

        /** Counter modulus -- byte 204 is a u8. */
        private const val MOD = 256
    }

    private val counters = VoiceFramerStats()

    /**
     * Counter of the last packet we DELIVERED, or -1 before the first one. Note "delivered":
     * duplicates and stale reorderings deliberately do not move the head, so a lens that keeps
     * echoing an old counter cannot drag the stream backwards.
     */
    private var head = -1

    /** [head]'s arrival time, so [VoicePipeline] can date concealed frames. */
    var lastDeliveredMs: Long = 0L
        private set

    /**
     * An IMMUTABLE snapshot of the counters. `VoiceFramerStats` is a `var`-field data class
     * owned by another stream, so we hand out `copy()` rather than the live object -- a caller
     * that publishes it to JS or a sink must not be able to mutate our accounting, and must
     * not see it change under them mid-log-line.
     *
     * Counts and milliseconds only. There is deliberately no way to ask this class what the
     * audio was.
     */
    fun stats(): VoiceFramerStats = counters.copy()

    /** Forget the stream head and zero the counters. Call when a capture STARTS, not when it ends. */
    fun reset() {
        head = -1
        lastDeliveredMs = 0L
        counters.received = 0
        counters.duplicates = 0
        counters.malformed = 0
        counters.concealed = 0
        counters.resyncs = 0
        counters.lostPackets = 0
    }

    /**
     * Parse one whole notification.
     *
     * @return the packet, or `null` if it is not a mic packet -- in which case [stats]'s
     *   `malformed` has been bumped and the bytes are dropped without further inspection.
     */
    fun parse(raw: ByteArray, side: String, tMs: Long): VoicePacket? =
        parse(raw, 0, raw.size, side, tMs)

    /**
     * Parse a packet living inside a larger (pooled, reused) buffer.
     *
     * **THE LENGTH IS ASSERTED, NOT ASSUMED.** `enc_len` is a firmware variable: the offsets of
     * `ssr` / `tdoa` / `counter` are derived from it on-glass, so if a build ever ships a
     * different `enc_len` then this packet's byte 200 is LC3 payload, and reading it as `ssr`
     * yields a plausible-looking integer and a silently corrupt stream. Length-checking first
     * is the only thing that turns "wrong data forever" into "counted and dropped".
     *
     * The returned [VoicePacket.lc3] ALIASES [raw] -- no copy, because at 20 packets/s a copy
     * per packet is pure garbage-collector pressure. The caller must finish with the packet
     * before recycling the buffer.
     */
    fun parse(raw: ByteArray, off: Int, len: Int, side: String, tMs: Long): VoicePacket? {
        if (len != VoiceFormat.PACKET_BYTES || off < 0 || off + len > raw.size) {
            counters.malformed++
            return null
        }
        return VoicePacket(
            lc3 = raw,
            lc3Offset = off,
            ssr = le16(raw, off + VoiceFormat.OFF_SSR),
            tdoa = le16(raw, off + VoiceFormat.OFF_TDOA),
            counter = raw[off + VoiceFormat.OFF_COUNTER].toInt() and 0xFF,
            side = side,
            tMs = tMs
        )
    }

    /**
     * Signed little-endian 16-bit read.
     *
     * BOTH fields are SIGNED. `tdoa` is a cross-correlation lag and is negative for half of all
     * sound sources -- reading it unsigned turns "sound from the left" into +65000-ish and
     * breaks direction-of-arrival entirely. `ssr` is likewise signed in the firmware. The
     * `.toShort().toInt()` round-trip IS the sign extension, and it is not decoration.
     */
    private fun le16(a: ByteArray, i: Int): Int {
        val lo = a[i].toInt() and 0xFF
        val hi = a[i + 1].toInt() and 0xFF
        return ((hi shl 8) or lo).toShort().toInt()
    }

    /**
     * Decide what to do with a parsed packet, and advance the stream head.
     *
     * THE ARITHMETIC, spelled out because it is the whole class:
     *
     * `delta` is the SIGNED distance from the head, folded into `-128..127`. Signed folding is
     * what makes wraparound free: head 255 -> counter 0 is `delta == 1`, not `-255`, so the
     * seam at 256 needs no special case at all and cannot be forgotten in a refactor.
     *
     * ```
     *   delta ==  0                   -> Duplicate   (the other lens's copy)
     *   delta in -STALE_LOOKBACK..-1  -> Duplicate   (reordered / lagging lens)
     *   delta ==  1                   -> Deliver(0)  (the normal case)
     *   delta in  2..MAX_CONCEAL_GAP  -> Deliver((delta-1)*5) PLC frames first
     *   otherwise                     -> Resync
     * ```
     *
     * `(delta - 1) * 5`: each missing PACKET is five 10 ms FRAMES, and [Lc3Decoder.concealFrame]
     * works a frame at a time. Concealing per-packet instead of per-frame is another way to get
     * white noise out of this pipe.
     *
     * A far-negative `delta` (further back than [STALE_LOOKBACK]) is not loss -- it is the
     * counter having RESTARTED, which is what a lens reconnecting or the firmware reopening the
     * mic looks like. We resync with `lostPackets = 0` because we genuinely do not know how
     * much, if anything, was lost, and inventing a number here would poison the only honest
     * loss figure we have.
     */
    fun offer(packet: VoicePacket): FramerAction {
        counters.received++

        if (head < 0) {
            head = packet.counter
            lastDeliveredMs = packet.tMs
            return FramerAction.Deliver(0)
        }

        val delta = signedDelta(head, packet.counter)

        if (delta <= 0 && delta >= -STALE_LOOKBACK) {
            counters.duplicates++
            return FramerAction.Duplicate
        }

        head = packet.counter
        lastDeliveredMs = packet.tMs

        if (delta == 1) return FramerAction.Deliver(0)

        if (delta in 2..MAX_CONCEAL_GAP) {
            val lost = delta - 1
            val frames = lost * VoiceFormat.FRAMES_PER_PACKET
            counters.lostPackets += lost
            counters.concealed += frames
            return FramerAction.Deliver(frames)
        }

        val lost = if (delta > 0) delta - 1 else 0
        counters.lostPackets += lost
        counters.resyncs++
        return FramerAction.Resync(lost)
    }

    /**
     * Distance from [from] to [to] on the mod-256 counter ring, folded to `-128..127`.
     *
     * `+ MOD/2` then `- MOD/2` is the fold; the mask is `and (MOD - 1)` rather than `%` because
     * `%` on a negative intermediate in Kotlin is negative, which is precisely the bug this
     * helper exists to make impossible.
     */
    private fun signedDelta(from: Int, to: Int): Int =
        (((to - from) + MOD + MOD / 2) and (MOD - 1)) - MOD / 2
}
