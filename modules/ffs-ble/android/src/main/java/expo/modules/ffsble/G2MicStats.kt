package expo.modules.ffsble

/**
 * The whole of what the driver may know -- and say -- about a microphone session.
 *
 * WHY THIS IS ITS OWN CLASS
 * -------------------------
 * ⛔ COUNTS AND CLOCK READINGS ONLY, NEVER A BYTE OF AUDIO. `[proven]` from our own glog
 * archive, 3,281 notifications of the audio characteristic were base64'd, written to the
 * driver log and shipped off-device across four days before the privacy guard existed. The
 * instrument that replaced them has to be numeric BY CONSTRUCTION, or the same thing happens
 * again the first time somebody needs to know whether packets arrived.
 *
 * Making that "by construction" is exactly why this is a class of its own rather than a
 * cluster of loose fields on [G2Central]: everything mic-session lives behind this boundary
 * hands out nothing but integers and log strings, it takes no [ByteArray], and it is
 * reachable from a plain-JVM unit test (`G2Central` needs a BluetoothManager, a Handler and a
 * live pair, so nothing inside it runs under `./gradlew :ffs-ble:test`). It mirrors
 * [EvenHubPageLatches]: cohesive state + rule, dependencies injected as lambdas, the tested
 * object is the same object the driver runs.
 *
 * [G2Central] owns one instance, drives it entirely on its serial queue (so no field here
 * needs its own lock), and keeps thin public `micResetStats()` / `micLogStats()` wrappers so
 * the native module surface is unchanged.
 */
internal class G2MicStats(
    /** Timestamped log sink -- the SAME [G2Central.log] the rest of the driver uses. */
    private val log: (String) -> Unit,
    /**
     * (side, gapMs, requestedByUs) -- the microphone started streaming, fired once per BURST.
     * Carries no audio and nothing derived from audio. Bridged to [G2Central.onMicUnexpected].
     */
    private val onUnexpected: (String, Long, Boolean) -> Unit,
    /**
     * Monotonic clock, ms. Defaulted to the real device clock; injectable so a unit test can
     * drive burst detection deterministically without `android.os.SystemClock` on the JVM.
     */
    private val clock: () -> Long = { android.os.SystemClock.elapsedRealtime() }
) {

    // ⛔ THE ONLY THINGS ABOUT A MIC SESSION THAT MAY BE READ OUT. Counts and clock readings.
    private var pkts = 0
    private var pktsRight = 0
    private var bad = 0
    private var firstMs = 0L
    private var lastMs = 0L
    /** Any audio notification, L or R, good or bad -- the clock burst detection runs on. */
    private var lastAnyMs = 0L
    private var bursts = 0
    private var burstsUnexpected = 0

    /** True between our own CTRL ENTER and CTRL EXIT. A burst outside that window is theirs. */
    var requestedByUs = false

    companion object {
        /**
         * Silence, in ms, that separates one mic burst from the next. Packets arrive every
         * ~50 ms, so anything past this is a new session rather than a dropped frame.
         */
        private const val BURST_GAP_MS = 1_500L
    }

    /**
     * Zero the packet counters (the `micResetStats` affordance). Call at the START of a
     * capture, not the end. Deliberately leaves burst / session tracking alone -- it mirrors
     * the prior inline reset, which touched only these five fields.
     */
    fun resetCounters() {
        pkts = 0; pktsRight = 0; bad = 0; firstMs = 0L; lastMs = 0L
        log("mic stats reset")
    }

    /**
     * Full reset at the moment WE open the mic (CTRL ENTER). Clears the burst/session tracking
     * too, so our own first burst is measured cleanly. Does NOT touch [requestedByUs]; the
     * caller claims that window separately and BEFORE the open goes out, or our own first burst
     * races the flag and is misreported as the glasses opening their own microphone.
     */
    fun resetSession() {
        pkts = 0; pktsRight = 0; bad = 0; firstMs = 0L; lastMs = 0L
        lastAnyMs = 0L; bursts = 0; burstsUnexpected = 0
    }

    /**
     * Emit the counters. Safe to log, safe to ship, and the ONLY answer to "did packets flow?"
     * that does not involve putting the wearer's voice in a file.
     */
    fun logStats() {
        val span = if (firstMs == 0L) 0L else lastMs - firstMs
        log(
            "MICSTATS pkts=$pkts (L) right=$pktsRight bad=$bad " +
                "spanMs=$span audioMs=${pkts * 50} " +
                "expectedPkts=${if (span > 0) span / 50 else 0} " +
                "bursts=$bursts unrequested=$burstsUnexpected"
        )
    }

    /** Count one audio notification. Length and side only -- never the contents. */
    fun count(len: Int, side: String) {
        val now = clock()

        // Burst edge: the first packet after a gap of silence. This is the only moment worth
        // reporting -- at ~20 packets/s a per-packet signal would be noise, and the question
        // ("did the mic just open?") is a question about edges.
        val gap = if (lastAnyMs == 0L) Long.MAX_VALUE else now - lastAnyMs
        lastAnyMs = now
        if (gap > BURST_GAP_MS) {
            bursts++
            if (!requestedByUs) {
                burstsUnexpected++
                // Metadata only, and deliberately loud: this line is the record that the glasses
                // opened their own microphone. Never add the packet to it.
                log("MIC-UNEXPECTED side=$side -- audio started and WE DID NOT ASK " +
                    "(burst #$bursts, $burstsUnexpected unrequested this session)")
            }
            onUnexpected(side, if (gap == Long.MAX_VALUE) -1L else gap, requestedByUs)
        }

        if (len != 205) { bad++; return }
        if (side == "R") { pktsRight++; return }
        if (firstMs == 0L) firstMs = now
        lastMs = now
        pkts++
    }
}
