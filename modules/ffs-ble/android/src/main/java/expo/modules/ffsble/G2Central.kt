package expo.modules.ffsble

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.UUID

/**
 * G2Central.kt -- Android twin of `ios/G2Central.swift`.
 *
 * From-scratch `android.bluetooth` central for the Even Realities G2 glasses. The G2 is TWO
 * independent BLE peripherals (left + right lens), each exposing the same GATT. This manager
 * scans -> filters G2 lenses -> connects BOTH -> discovers services/characteristics per side
 * -> subscribes to the protocol + audio notify characteristics -> and coordinates the pair.
 * It adds per-side, 6ms-paced FIFO write queues (all write-without-response) drained by
 * independent loops behind a per-side write-lock, and a `send(to:)` API targeting one side or
 * both. Each side's disconnect is handled independently -- one lens dropping never nukes the
 * other's state.
 *
 * Asymmetry (FUT-159): the RIGHT lens carries the protocol notify + ACK channel; the LEFT arm
 * is SILENT on async protocol events. We discover characteristics on both sides and subscribe
 * on whichever side exposes the notify char, but we expect protocol notifications on the RIGHT.
 *
 * MIT attribution: the BLE protocol constants below are derived from MentraOS
 * (https://github.com/Mentra-Community/MentraOS), MIT License. The CoreBluetooth plumbing was
 * reimplemented from scratch in the Swift original; this is a port of that original to
 * android.bluetooth, and the platform-specific parts are new code.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHERE ANDROID GENUINELY DIFFERS FROM THE PROVEN iOS DRIVER
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * These are not stylistic. Each one is a place where a faithful line-by-line translation
 * would produce a driver that compiles, runs, and does not work:
 *
 *  1. MTU IS NOT NEGOTIATED FOR YOU. iOS hands you ~180+ bytes per write-without-response.
 *     Android starts every link at MTU 23 = 20 usable bytes. Our transport packets are up to
 *     244 bytes (8 header + 236 payload), so without an explicit `requestMtu` EVERY packet is
 *     silently truncated. We request 247 (= 244 payload, exactly one full packet) after
 *     connect and BEFORE service discovery, and log loudly if less is granted.
 *
 *  2. NOTIFICATIONS NEED AN EXPLICIT CCCD WRITE. `setCharacteristicNotification` only wires up
 *     the local callback; the peripheral is never told to send anything until descriptor
 *     0x2902 is written. iOS's `setNotifyValue` does both. Miss this and you get a connected,
 *     char-bound, permanently silent link -- indistinguishable from a dead protocol.
 *
 *  3. GATT OPERATIONS MUST BE SERIALIZED PER LINK. CoreBluetooth queues internally; Android
 *     drops a second operation on the floor while one is in flight. Hence [G2Lens.pendingOps].
 *
 *  4. A WRITE CAN BE REFUSED. iOS's `writeValue` always buffers. Android returns a busy status
 *     and does NOT queue the packet -- dropping it would corrupt the framed stream mid-message.
 *     The drain therefore PEEKS, writes, and only pops on success, retrying with backoff.
 *
 *  5. `gatt.close()` IS MANDATORY. Android has a hard limit on concurrent GATT client
 *     interfaces; leaking them is the classic cause of connect status 133 after a few
 *     reconnect cycles. Every teardown path here closes.
 *
 * Per cardinal rule 1, none of the above counts until it is seen working on the glasses.
 */
@SuppressLint("MissingPermission")
class G2Central(
    private val context: Context,
    /** Supplies the current Activity for a runtime-permission request, or null if none. */
    private val activityProvider: () -> Activity?
) {

    // MARK: - Protocol constants (mirrored from MentraOS G2.swift, MIT)

    companion object {
        /** EvenHub GATT service. */
        val SERVICE_UUID: UUID = UUID.fromString("00002760-08c2-11e1-9073-0e8ac72e0000")
        /** phone -> glasses (write, without response). */
        val CHAR_WRITE: UUID = UUID.fromString("00002760-08c2-11e1-9073-0e8ac72e5401")
        /** glasses -> phone protocol/acks (notify). */
        val CHAR_NOTIFY: UUID = UUID.fromString("00002760-08c2-11e1-9073-0e8ac72e5402")
        /** glasses -> phone LC3 mic audio (notify). */
        val AUDIO_NOTIFY: UUID = UUID.fromString("00002760-08c2-11e1-9073-0e8ac72e6402")
        // OTA firmware-flash channels (FUT-167). DATA svc e1001: write e0001 / notify e0002.
        val FLASH_DATA_WRITE: UUID = UUID.fromString("00002760-08c2-11e1-9073-0e8ac72e0001")
        val FLASH_DATA_NOTIFY: UUID = UUID.fromString("00002760-08c2-11e1-9073-0e8ac72e0002")

        /** Client Characteristic Configuration Descriptor -- the notify enable switch. */
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /** Substring every G2 peripheral name contains, e.g. "Even G2_XX_L_XXXXXX". */
        private const val NAME_MATCH = "G2"

        /** Inter-packet pacing for the per-side write queues (P0 spec: 6ms). */
        private const val WRITE_PACING_MS = 6L

        /**
         * Backoff before re-attempting a packet the stack refused (see difference 4 above).
         * Deliberately longer than the pacing interval: a refusal means the stack's buffer is
         * full, so hammering it at 6ms just burns CPU to be refused again.
         */
        private const val WRITE_RETRY_MS = 12L

        /**
         * Give up on a single packet after this many refusals (~1.2s of retries). At that
         * point the link is not coming back on its own and silently retrying forever would
         * wedge the drain -- and with it the heartbeat -- with no signal at all.
         */
        private const val WRITE_MAX_RETRIES = 100

        /**
         * FUT-253: master switch for the write-backpressure GATE. OFF = the proven prior
         * behavior -- the drain writes unconditionally, paced only by WRITE_PACING_MS.
         *
         * The iOS gate consults `canSendWriteWithoutResponse`, which has no Android equivalent.
         * The faithful Android analogue is completion-driven pacing: write the next packet from
         * `onCharacteristicWrite` instead of from a timer. That is arguably BETTER than the 6ms
         * guess -- but it changes write hot-path timing near the pacer / heartbeat / anim frame
         * gating, so per cardinal rule 1 it stays OFF until proven on-glass. Flip to true for a
         * dedicated on-glass test.
         */
        const val ENABLE_BACKPRESSURE_GATE = false

        /** Safety net for the gate: resume the drain if a write completion never arrives. */
        private const val WRITE_COMPLETION_TIMEOUT_MS = 100L

        /** Interval (ms) at which the write-drain throughput meter is emitted per side. */
        private const val TX_METER_INTERVAL_MS = 1000L

        /** FUT-219 recovery watchdog period. */
        private const val RECOVER_TIMEOUT_MS = 6000L

        /** How long a completely empty scan runs before we log why that is usually happening. */
        private const val BARREN_SCAN_MS = 10_000L

        /**
         * Backoff and cap for a GATT op the stack refused. The refusal is almost always the
         * paced write drain holding the link's single in-flight slot, so it clears in one
         * pacing interval; the cap is generous because giving up loses a subscription.
         */
        private const val GATT_OP_RETRY_MS = 20L
        private const val GATT_OP_MAX_RETRIES = 50
        private const val GATT_OP_TIMEOUT_MS = 3000L

        /**
         * ATT MTU we ask for. 247 is not arbitrary: ATT overhead is 3 bytes, so 247 grants
         * exactly the 244-byte maximum transport packet (8-byte header + 236-byte payload).
         * Asking for more buys nothing; accepting less truncates packets.
         */
        private const val WANT_MTU = 247
        private const val ATT_OVERHEAD = 3

        /** SharedPreferences keys for the FUT-219 cross-launch re-bind. */
        private const val PREFS = "ffs_ble"
        private const val KEY_MAC_PREFIX = "ffs.g2.mac."

        private const val TAG = "ffs-ble"
    }

    // MARK: - Callbacks (wired by the Expo module; signatures mirror the Swift closures)

    /** (message) -- every log line, already timestamped by [log]. */
    var onLog: ((String) -> Unit)? = null
    /** (stateDescription) -- adapter transitions ("poweredOn", ...), iOS CBManagerState names. */
    var onStateChange: ((String) -> Unit)? = null
    /** (name, side, rssi, sn?, mac?) -- a G2 lens seen in a scan. */
    var onDeviceFound: ((String, String, Int, String?, String?) -> Unit)? = null
    /** (name, side) -- a lens finished connecting. */
    var onConnected: ((String, String) -> Unit)? = null
    /** (side, charUUIDs) -- a side's services discovered; the UUIDs we matched. */
    var onServicesDiscovered: ((String, List<String>) -> Unit)? = null
    /** () -- BOTH lenses connected AND required chars found. Fires once per pair-up. */
    var onPairReady: (() -> Unit)? = null
    /**
     * (base64Payload, characteristicUUID, side) -- a notification arrived.
     *
     * ⛔ MICROPHONE AUDIO NEVER ARRIVES HERE. See [onAudioPacket] and the guard at the top of
     * `handleNotificationLocked`.
     */
    var onNotify: ((String, String, String) -> Unit)? = null

    /**
     * (packet, side) -- ONE raw 205-byte LC3 microphone packet from the glasses.
     *
     * ══ WHY THIS EXISTS SEPARATELY FROM [onNotify] ═════════════════════════════════════════
     * Mic packets are a RECORDING OF THE WEARER. [onNotify] base64s its payload, writes a
     * `Notify <uuid> (side=…, N bytes)` line to the driver log, and ships the base64 to
     * JavaScript, where `os/calibration/capture.ts` records it and `os/log.ts` is configured to
     * treat `ble:notify` as a sampled hot category bound for an off-device collector. Every one
     * of those is a place audio must never reach, and none of them would notice if it did.
     *
     * So the audio characteristic is diverted BEFORE any of that happens: no base64, no log
     * line, no JS bridge, no `onNotify`. This callback hands the bytes straight to whatever is
     * decoding them, and its contract is:
     *
     *   • do not log the packet, its length, its contents, or anything derived from them;
     *   • do not write it to disk;
     *   • do not marshal it to JavaScript (20 packets/s over the bridge is both wasteful and a
     *     second copy of the recording in a second process) -- decode in native code and pass
     *     JS only the transcript, and only once the wearer has asked for it to be sent.
     *
     * Metadata -- counts, gaps, durations -- IS safe to log, and `src/sdk/mic.ts` defines exactly
     * which fields those are. Nothing else about a mic session is.
     *
     * Packet layout, and the LC3 decode, are documented in `src/sdk/mic.ts`.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    var onAudioPacket: ((ByteArray, String) -> Unit)? = null

    /**
     * (side, gapMs, requestedByUs) -- the microphone started streaming and **we did not ask**.
     *
     * The glasses can open their own mic: `[proven]` from the 08-18/08-20 archive, three of the
     * eighteen audio bursts had no `CTRL ENTER` from this phone before them -- the GX8002 wake
     * word, or a temple long-press into Even's stock voice flow. An idle mic is not a closed one,
     * and nothing in the stack said so out loud.
     *
     * Fired once per BURST (first packet after the mic burst-gap of silence), never per packet.
     * Carries no audio and nothing derived from audio -- a side, a gap in milliseconds, and
     * whether our own [setMicStream]/[aiSwirl] is what opened it.
     */
    var onMicUnexpected: ((String, Long, Boolean) -> Unit)? = null

    /**
     * All mic-session telemetry lives behind [G2MicStats] -- counts and clock readings only,
     * never a byte of audio (see that class for the archive incident that made "numeric by
     * construction" a hard requirement). Driven entirely on the serial queue, so it needs no
     * lock of its own; its dependencies are the driver's own [log] sink and [onMicUnexpected]
     * callback, read at call time so a callback wired after construction still fires.
     */
    private val micStats = G2MicStats(
        log = { msg -> log(msg) },
        onUnexpected = { side, gapMs, requestedByUs ->
            onMicUnexpected?.invoke(side, gapMs, requestedByUs)
        }
    )

    /** Zero the counters. Call at the start of a capture, not at the end. */
    fun micResetStats() = post { micStats.resetCounters() }

    /**
     * Emit the counters. Safe to log, safe to ship, and the ONLY answer to "did packets flow?"
     * that does not involve putting the wearer's voice in a file.
     */
    fun micLogStats() = post { micStats.logStats() }
    /** (name, side, reason?, code, domain) -- a lens disconnected. code=0 is a clean teardown. */
    var onDisconnected: ((String, String, String?, Int, String) -> Unit)? = null

    /**
     * An inbound event from the glasses: (kind, containerId, containerName, itemIndex, itemName,
     * eventType, eventSource). This is how a natively-owned screen reports back -- the phone
     * declares a list once and hears only the selection, instead of re-rendering per scroll.
     */
    var onGlassesEvent: ((String, Int?, String?, Int?, String?, Int?, Int?) -> Unit)? = null

    /**
     * (serviceId, base64) -- EVERY reassembled inbound service payload, before any
     * interpretation, for EVERY service.
     *
     * This is the channel the TypeScript SDK listens on. It is deliberately raw and deliberately
     * unfiltered: the SDK carries its own decoders, unit-tested against captured byte vectors,
     * and feeding them the real bytes is what makes those vectors evidence about the HARDWARE
     * rather than evidence about the Kotlin decoder agreeing with itself. A frame shape neither
     * side recognises still reaches JS instead of vanishing into a log line.
     *
     * Carries the service id because the SDK needs more than one: pages and events arrive on
     * EvenHub (0xE0) while settings snapshots arrive on 0x09. An EvenHub-only channel silently
     * starved the settings reader — the OS's Device screen rendered "--" forever with nothing
     * anywhere reporting a problem.
     */
    var onServiceRaw: ((Int, String) -> Unit)? = null
    /** (gesture, side, source?) -- a decoded touch gesture. */
    var onGesture: ((String, String, Int?) -> Unit)? = null
    /** (leftVersion?, rightVersion?, battery?, charging?) -- a device-info response. */
    var onDeviceInfo: ((String?, String?, Int?, Boolean?) -> Unit)? = null
    /** (leftReady, rightReady, detail) -- result of the zero-write flash-channel probe. */
    var onFlashProbe: ((Boolean, Boolean, String) -> Unit)? = null
    /** (message, progress 0..1, done, ok) -- CFW flash/validate progress. */
    var onFlashProgress: ((String, Double, Boolean, Boolean) -> Unit)? = null

    // FUT-253 observability callbacks (native BLE link telemetry).

    /** (side, rssi) -- a live connected-RSSI reading, polled in the 5s heartbeat. */
    var onRssi: ((String, Int) -> Unit)? = null
    /** (side, mtu) -- the write-without-response payload ceiling, read once at connect. */
    var onMtu: ((String, Int) -> Unit)? = null
    /** (side, code, domain, desc) -- a connect ATTEMPT failed (distinct from a drop). */
    var onConnectFailed: ((String, Int, String, String) -> Unit)? = null
    /** (side, bytesPerInterval, pktsPerInterval, queueDepth) -- write-drain throughput meter. */
    var onTxMeter: ((String, Int, Int, Int) -> Unit)? = null
    /** (side, queueDepth) -- the stack refused a write; the paced drain is backing off. */
    var onTxStall: ((String, Int) -> Unit)? = null
    /** (side, queueDepth) -- writes are being accepted again and the drain has resumed. */
    var onTxResume: ((String, Int) -> Unit)? = null
    /** (side, characteristicUUID, on) -- a notify-subscription state change. */
    var onSubscribe: ((String, String, Boolean) -> Unit)? = null

    // MARK: - Per-lens state

    /**
     * All per-lens state: the device, its GATT client, its matched characteristics, its paced
     * write queue, and the flag that serializes a multi-packet message.
     *
     * Every field here is touched ONLY on [handler]'s thread (the single serial queue), so no
     * additional locking is needed -- the "write-lock" is the [draining] flag guarding the
     * paced drain loop, which is also queue-confined. The lock's job is to keep a multi-fragment
     * message on one side contiguous: once a drain loop starts emptying a side's queue it holds
     * that side until the queue is empty, so a second message enqueued mid-drain can never
     * interleave its packets with the first.
     */
    private class G2Lens(
        val device: BluetoothDevice,
        val side: G2Side,
        val name: String
    ) {
        var gatt: BluetoothGatt? = null
        var connected = false
        /** Distinguishes "the connect attempt failed" from "an established link dropped". */
        var everConnected = false

        var writeChar: BluetoothGattCharacteristic? = null
        var notifyChar: BluetoothGattCharacteristic? = null
        var audioChar: BluetoothGattCharacteristic? = null

        /** FIFO of packets waiting to go out on this side, oldest first. */
        val writeQueue = ArrayDeque<ByteArray>()
        /** The paced drain loop is currently running for this side (the write-lock). */
        var draining = false

        // FUT-253 tx observability. All touched ONLY on the serial queue.
        var txBytesAccum = 0
        var txPktsAccum = 0
        /** The stack is refusing writes and the drain is backing off. */
        var txStalled = false
        /** Consecutive refusals for the packet currently at the head of the queue. */
        var txRetries = 0
        /** Bumped per write so a stale completion/timeout cannot double-drive the drain. */
        var writeGen = 0

        var mtuReported = false
        var negotiatedMtu = 23
        /** One oversize-packet warning per side is enough; see drainStepLocked. */
        var oversizeWarned = false

        /** Inbound transport reassembler for this side (independent syncId stream). */
        val rx = G2RxReassembler()

        /**
         * Serialized GATT operations (see difference 3 in the class header). The head runs when
         * the previous one's callback lands; [opInFlight] is the guard and [opGen] fences a
         * timeout against a late completion for the same slot.
         */
        val pendingOps = ArrayDeque<GattOp>()
        var opInFlight: GattOp? = null
        var opGen = 0
    }

    /** One serialized GATT operation. [run] returns false if the stack refused to start it. */
    private class GattOp(
        val label: String,
        val run: () -> Boolean,
        /** Called once the op is abandoned, so a lost subscription can still be reported. */
        val onGiveUp: (() -> Unit)? = null
    ) {
        var attempts = 0
    }

    // MARK: - State

    private val thread = HandlerThread("FfsBleQueue", Process.THREAD_PRIORITY_FOREGROUND)
        .apply { start() }
    private val handler = Handler(thread.looper)

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter? = bluetoothManager?.adapter

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Discovered lenses keyed by side (deduped as the same lens re-advertises). */
    private val discovered = HashMap<G2Side, G2Discovery>()

    /** The connected (or connecting) lenses, keyed by side. */
    private val lenses = HashMap<G2Side, G2Lens>()

    /** Whether we've already emitted onPairReady for the current pair-up. */
    private var pairReadyFired = false

    /** Connect intent. When set we connect BOTH lenses as they're discovered. */
    private var wantsPair = false
    /** Single-side connect intent (testing convenience): connect only this side. */
    private var wantsSingleSide: G2Side? = null

    private var isScanning = false
    private var txMeterRunning = false
    /** Scan results of ANY kind since the current scan started -- see diagnoseBarrenScan. */
    private var scanResultsSeen = 0

    /**
     * Dump every inbound EvenHub payload field-by-field. Costly and noisy, so it is off by
     * default and turned on for protocol archaeology -- e.g. learning the native ListEvent's
     * shape, which is documented nowhere we trust.
     */
    @Volatile
    var dumpInbound = false

    /**
     * Readiness snapshots for the synchronous JS probes. The Swift driver answered
     * `isPairReady()` with a blocking hop onto the CoreBluetooth queue; doing that here would
     * mean a cross-thread round trip on every poll from JS (and a deadlock the moment it is
     * ever called from the BLE thread). These are written on the serial queue only and read
     * without locking, which is exactly what @Volatile is for.
     */
    @Volatile private var pairReadySnapshot = false
    @Volatile private var leftReadySnapshot = false
    @Volatile private var rightReadySnapshot = false

    // EvenHub session + display state.
    private val counters = G2SendCounters()
    private var sessionAuthed = false
    private var heartbeatRunning = false
    /**
     * A handshake is running. `sessionAuthed` only flips at the END of the ~1.4s chain, so it
     * cannot serve as the guard -- callers arriving inside that window all see false. Observed
     * on-glass 2026-08-07: two handshakes 7ms apart, every auth command sent twice.
     */
    private var authInProgress = false
    /** Callers that arrived mid-handshake, run in order once it completes. */
    private val authWaiters = ArrayList<() -> Unit>()

    // The EvenHub page / image-transfer / animation state (pageLatches, pageCreated,
    // imgAck*, animActive/animContainerReady/animSession) was quarantined 2026-08-22 along with
    // the render machinery that used it -- see modules/ffs-ble/legacy/ and docs/APK-CLEANUP-PLAN.md.

    private var recoverTimer: Runnable? = null

    /**
     * The CFW OTA flasher (FUT-260). Owns its own thread and blocks on acks, so it is handed
     * ready-made targets and never reaches back into driver state. `flasher.active` gates the
     * notify router and the heartbeat below.
     */
    private val flasher = G2Flasher(
        log = { msg -> log(msg) },
        onProgress = { msg, frac, done, ok -> onFlashProgress?.invoke(msg, frac, done, ok) }
    )

    private var lastGestureName = ""
    private var lastGestureAt = 0L
    /** Per-SIDE, not global — see [handleDeviceInfoLocked]. A global window dropped the left
     *  lens's answer entirely, which is how two per-lens bugs stayed invisible to us. */
    private val lastDeviceInfoAtBySide = HashMap<String, Long>()

    /**
     * MUST be declared ABOVE the `init` block. Kotlin runs property initializers and init blocks
     * in source order, and `init` posts to [handler] -- whose thread is already running and can
     * pick that work up while the constructor is still executing. Any property declared after
     * `init` is therefore still null when the first log line is emitted. Moving this below the
     * init block crashes the app on launch with an NPE on a background thread; it is not a
     * theoretical race, it happened on the first run of this driver.
     */
    private val isoFormatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US)

    // MARK: - Init

    init {
        registerAdapterStateReceiver()
    }

    /**
     * Emit the initial adapter state. MUST be called by the module AFTER wiring the callbacks --
     * which is exactly why it is not in `init`.
     *
     * The constructor posts to a HandlerThread that is already running, so anything `init`
     * emitted would race the module's `c.onStateChange = { ... }` assignment and, in practice,
     * lose: JS would never receive the startup state and the UI would sit on its default until
     * something else happened to change it. The same race in the first cut of this driver also
     * dereferenced a not-yet-initialized field and killed the app on launch.
     */
    fun start() = post {
        log("G2Central initialized (dual-radio / android.bluetooth)")
        val desc = adapterStateDescription()
        log("Adapter state -> $desc")
        onStateChange?.invoke(desc)
    }

    /** Stop everything and release the serial queue. Called if the module is torn down. */
    fun shutdown() {
        post {
            stopScanLocked()
            for (lens in lenses.values) closeLens(lens)
            lenses.clear()
            try {
                context.unregisterReceiver(adapterReceiver)
            } catch (_: IllegalArgumentException) {
                // Never registered, or already gone. Not worth failing a teardown over.
            }
            thread.quitSafely()
        }
    }

    // MARK: - Logging

    /** Timestamp (ISO8601 + millis) + forward to the module. Also logcat, for `adb logcat`. */
    fun log(message: String) {
        val line = "[${isoFormatter.format(java.util.Date())}] $message"
        Log.i(TAG, line)
        onLog?.invoke(line)
    }

    // MARK: - Serial-queue helpers

    /**
     * Everything the driver does runs through here, and every one of those blocks is wrapped.
     *
     * An uncaught exception on a HandlerThread is a FATAL EXCEPTION: it kills the entire app,
     * not just the BLE layer. On a driver whose whole job is talking to hardware over an
     * unreliable link, that turns any single bad frame or unexpected null into a lost debugging
     * session -- the app dies, the glasses stay in whatever state they were in, and the log ends
     * mid-sentence. Catching here degrades a driver bug to a loud log line that reaches both
     * logcat AND the JS log sink, which is strictly more debuggable than a stack trace the user
     * has to go dig out of `adb logcat` after the fact.
     *
     * This is NOT swallowing errors: the message and the stack trace both go out at error level.
     */
    private fun guarded(what: String, block: () -> Unit): Runnable = Runnable {
        try {
            block()
        } catch (t: Throwable) {
            Log.e(TAG, "unhandled exception on the BLE queue ($what)", t)
            onLog?.invoke("[ffs-ble] EXCEPTION on the BLE queue ($what): $t")
        }
    }

    private fun post(block: () -> Unit) {
        handler.post(guarded("post", block))
    }

    /** Run [block] on the serial queue after [ms] milliseconds. */
    private fun schedule(ms: Long, block: () -> Unit) {
        handler.postDelayed(guarded("delayed", block), ms)
    }

    // MARK: - Adapter state

    private val adapterReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            post { handleAdapterStateChangeLocked() }
        }
    }

    private fun registerAdapterStateReceiver() {
        val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(adapterReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(adapterReceiver, filter)
        }
    }

    /**
     * Android has no `centralManagerDidUpdateState`. This reproduces it from the adapter
     * broadcast, and DELIBERATELY emits the iOS CBManagerState vocabulary ("poweredOn",
     * "poweredOff", ...) -- the shared TypeScript OS switches on those strings, and inventing
     * Android-flavoured names here would silently break every state-dependent screen.
     */
    private fun adapterStateDescription(): String {
        if (adapter == null) return "unsupported"
        if (missingPermissions().isNotEmpty()) return "unauthorized"
        return when (adapter.state) {
            BluetoothAdapter.STATE_ON -> "poweredOn"
            BluetoothAdapter.STATE_OFF -> "poweredOff"
            BluetoothAdapter.STATE_TURNING_ON, BluetoothAdapter.STATE_TURNING_OFF -> "resetting"
            else -> "unknown"
        }
    }

    private fun handleAdapterStateChangeLocked() {
        val desc = adapterStateDescription()
        log("Adapter state -> $desc")
        onStateChange?.invoke(desc)

        if (desc == "poweredOn") {
            // If a scan or connect was requested before BT was ready, honor it now.
            if (wantsPair || wantsSingleSide != null || isScanning) {
                isScanning = false // reset; startScanLocked re-sets it
                startScanLocked()
                connectDiscoveredLocked()
                reclaimConnectedLocked()
                armRecoverWatchdogLocked()
            }
        } else {
            // Anything other than on means our connections (if any) are gone. Android does not
            // deliver a disconnect callback for every link when the radio is switched off, so
            // tear the lenses down here or they stay "connected" forever.
            isScanning = false
            if (lenses.isNotEmpty()) {
                for (lens in lenses.values.toList()) {
                    closeLens(lens)
                    onDisconnected?.invoke(
                        lens.name, lens.side.raw, "bluetooth turned off", 0, GATT_DOMAIN
                    )
                }
                lenses.clear()
                resetSessionLocked()
                evaluatePairLocked()
            }
        }
    }

    // MARK: - Permissions

    /**
     * The runtime permissions BLE actually needs on this API level. On 31+ these are
     * BLUETOOTH_SCAN/CONNECT; below that, scanning required location permission.
     *
     * NOTE the module manifest marks BLUETOOTH_SCAN `neverForLocation` -- without that flag,
     * API 31+ ALSO requires ACCESS_FINE_LOCATION or the scan returns zero results while
     * reporting success, which is the single most confusing failure mode in Android BLE.
     */
    private fun requiredPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun missingPermissions(): List<String> = requiredPermissions().filter {
        context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
    }

    /**
     * True if we may touch the radio. If not, fire a runtime request at the current Activity
     * and return false -- the caller logs and gives up for this attempt. We deliberately do not
     * try to resume the original call from the permission result: the user re-taps, and that is
     * both simpler and more predictable than a queued intent that fires minutes later.
     */
    private fun ensurePermissionsLocked(what: String): Boolean {
        val missing = missingPermissions()
        if (missing.isEmpty()) return true
        log("$what blocked -- missing permission(s): ${missing.joinToString(", ")}")
        val activity = activityProvider()
        if (activity == null) {
            log("cannot request BLE permissions: no foreground activity")
        } else {
            log("requesting BLE permissions -- tap $what again once granted")
            handler.post {
                activity.runOnUiThread {
                    activity.requestPermissions(missing.toTypedArray(), 4711)
                }
            }
        }
        onStateChange?.invoke("unauthorized")
        return false
    }

    // MARK: - Public API (called from the module, off-queue -> hop onto the queue)

    fun startScan() = post { startScanLocked() }

    private fun startScanLocked() {
        val adapter = this.adapter
        if (adapter == null || !adapter.isEnabled) {
            log("startScan deferred -- adapter not powered on (state=${adapterStateDescription()})")
            return
        }
        if (!ensurePermissionsLocked("startScan")) return
        if (isScanning) {
            log("startScan ignored -- already scanning")
            return
        }
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            log("startScan failed -- no BLE scanner (adapter off?)")
            return
        }
        isScanning = true
        // Scan with NO service filter: the container service is not advertised, so a
        // ScanFilter on it matches nothing. We filter by name in the callback instead -- same
        // reason the iOS driver passes withServices: nil.
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .build()
        scanner.startScan(null, settings, scanCallback)
        scanResultsSeen = 0
        log("Scanning started (no service filter; name-matching '$NAME_MATCH')")
        schedule(BARREN_SCAN_MS) { diagnoseBarrenScanLocked() }
    }

    /**
     * A scan that returns NOTHING AT ALL reports success and stays silent forever -- there is
     * no callback for "I am scanning and the world is empty". That failure mode has a small,
     * fixed set of causes on Android, so name them rather than leaving the next session to
     * guess. Only fires when we have seen zero results of ANY kind, which means the radio is
     * not delivering; seeing non-G2 devices but no lens is a different (and honest) answer.
     */
    private fun diagnoseBarrenScanLocked() {
        if (!isScanning || scanResultsSeen > 0) return
        val pm = context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
        val screenOn = pm?.isInteractive
        log(
            "DIAGNOSTIC: ${BARREN_SCAN_MS / 1000}s of scanning with ZERO results of any kind. " +
                "That is the stack delivering nothing, not the glasses being absent. Check, in order:"
        )
        // Deliberately first: it is the only one on this list that has actually been OBSERVED
        // happening on this project's test phone (2026-08-07).
        log(
            "  1. SCREEN OFF? interactive=$screenOn. Android 8.1+ silently returns ZERO results for an " +
                "UNFILTERED scan while the screen is off, and this scan is unfiltered (by design -- the " +
                "container service is not advertised, so a ScanFilter on it would match nothing). " +
                "Wake the screen and retry. A manufacturer-data ScanFilter on the 'ER' company id would " +
                "lift this, but only once the glasses have been SEEN advertising it (cardinal rule 1)."
        )
        log("  2. BLUETOOTH_SCAN granted? missing=${missingPermissions()}")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            log(
                "  3. The manifest sets neverForLocation on BLUETOOTH_SCAN. If this ROM filters " +
                    "more aggressively than stock, drop the flag and grant ACCESS_FINE_LOCATION."
            )
        } else {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
            val locOn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) lm?.isLocationEnabled else null
            log("  3. API<=30 requires location SERVICES on (not just permission): enabled=$locOn")
        }
        log("  4. Is another app (Even's own, or a previous build) already holding the lenses?")
        log("  5. Android rate-limits an app to 5 scan starts per 30s -- a burst gets silently punished.")
    }

    fun stopScan() = post { stopScanLocked() }

    private fun stopScanLocked() {
        if (!isScanning) return
        isScanning = false
        if (missingPermissions().isNotEmpty()) return
        adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        log("Scanning stopped")
    }

    /**
     * Connect BOTH lenses (the pair). The primary entry point: we connect each side as it is
     * discovered and only consider the driver "ready" once both are up with their required
     * characteristics.
     */
    fun connectPair() = post {
        wantsPair = true
        wantsSingleSide = null
        log("connectPair requested")
        connectDiscoveredLocked()
        // FUT-219: bind any lens the system already holds connected (it won't advertise, so a
        // scan can never find it). This is what makes a plain reconnect work without an unpair.
        reclaimConnectedLocked()
        if (lenses[G2Side.LEFT] == null || lenses[G2Side.RIGHT] == null) {
            startScanLocked()
        }
        armRecoverWatchdogLocked()
    }

    /** Connect a SINGLE side only (testing convenience). Does not gate on the pair. */
    fun connectSide(side: G2Side) = post {
        if (side != G2Side.LEFT && side != G2Side.RIGHT) return@post
        wantsPair = false
        wantsSingleSide = side
        log("connectSide requested (side=${side.raw})")
        val disc = discovered[side]
        if (disc != null && lenses[side] == null) {
            beginConnectLocked(disc)
        } else if (lenses[side] == null) {
            reclaimConnectedLocked()
            if (lenses[side] == null) {
                log("Side ${side.raw} not discovered yet -- ensuring scan is active")
                startScanLocked()
            }
        }
        armRecoverWatchdogLocked()
    }

    /** Disconnect BOTH lenses and drop all intent. */
    fun disconnect() = post {
        wantsPair = false
        wantsSingleSide = null
        cancelRecoverWatchdogLocked()
        if (lenses.isEmpty()) {
            log("disconnect ignored -- nothing connected")
            return@post
        }
        for (lens in lenses.values.toList()) {
            log("Disconnecting from ${lens.name} (side=${lens.side.raw})")
            // For an ESTABLISHED link, disconnect() asks politely and yields an
            // onConnectionStateChange, which is where close() happens. Calling close() there
            // instead of here keeps JS from being told the link is down before it is.
            lens.gatt?.disconnect()

            // For a link that never came up, that callback NEVER ARRIVES. Cancelling a
            // background (autoConnect=true) connect goes through bta_gattc_cancel_bk_conn in
            // AOSP, which drops the allow-list entry without any client connection-state
            // callback. That is exactly the reclaim path (FUT-219 binds a remembered lens with
            // autoConnect=true and it pends forever while the glasses sit on the charger), so
            // "user taps Disconnect while a reclaim is pending" is the ordinary case, not a
            // corner one. Without this branch the lens stays in `lenses` and its GATT client is
            // never closed, which wedges Connect for the life of the process: connectDiscovered,
            // reclaim, the scan gate and the recovery watchdog ALL key off `lenses[side] != null`
            // and would every one of them skip the side forever. The leaked client interfaces
            // are also the textbook cause of status 133 on later connects.
            //
            // CoreBluetooth has no equivalent hole because it has no client interface to leak,
            // which is why the Swift original gets away with the single cancelPeripheralConnection.
            if (!lens.everConnected) {
                log("  side=${lens.side.raw} never connected -- closing it here (Android sends no callback for a cancelled pending connect)")
                closeLens(lens)
                lenses.remove(lens.side)
                onDisconnected?.invoke(
                    lens.name, lens.side.raw, "cancelled before connect", 0, GATT_DOMAIN
                )
            }
        }
        evaluatePairLocked()
    }

    /** Both lenses connected AND their required characteristics discovered. */
    fun isPairReady(): Boolean = pairReadySnapshot

    /** Is a given side currently connected + chars ready? */
    fun isSideReady(side: G2Side): Boolean = when (side) {
        G2Side.LEFT -> leftReadySnapshot
        G2Side.RIGHT -> rightReadySnapshot
        G2Side.UNKNOWN -> false
    }

    // MARK: - Writes (per-side paced FIFO queues behind the write-lock)

    /**
     * Enqueue an ordered list of fragments as ONE contiguous message to the target side(s).
     * The fragments are appended together under the serial queue, so they can never be split
     * by another message's packets.
     */
    private fun enqueueLocked(fragments: List<ByteArray>, target: G2Target) {
        if (fragments.isEmpty()) return
        for (side in sidesFor(target)) {
            val lens = lenses[side]
            if (lens == null) {
                log("send dropped -- side ${side.raw} not connected (${fragments.size} pkt)")
                continue
            }
            // Append the whole message contiguously, THEN kick the drain. Because both the
            // append and every drain step run on the same serial queue, the fragments are
            // guaranteed adjacent in the FIFO before any packet leaves.
            lens.writeQueue.addAll(fragments)
            startDrainLocked(lens)
        }
    }

    private fun sidesFor(target: G2Target): List<G2Side> = when (target) {
        G2Target.LEFT -> listOf(G2Side.LEFT)
        G2Target.RIGHT -> listOf(G2Side.RIGHT)
        G2Target.BOTH -> listOf(G2Side.LEFT, G2Side.RIGHT)
    }

    /**
     * Start the paced drain loop for a side if it is not already running. The [G2Lens.draining]
     * flag IS the per-side write-lock: only one drain loop per side.
     */
    private fun startDrainLocked(lens: G2Lens) {
        if (lens.draining) return
        if (lens.writeChar == null) {
            log("drain skipped -- side ${lens.side.raw} has no write characteristic")
            return
        }
        lens.draining = true
        drainStepLocked(lens)
    }

    /**
     * Write one packet, then reschedule the next after WRITE_PACING_MS. Holds the side
     * (draining=true) until the queue empties.
     *
     * The packet is PEEKED, not popped, until the stack accepts it (difference 4 in the class
     * header): on Android a refused write never reaches the peripheral, and popping first would
     * punch a hole in the middle of a framed multi-packet message -- which the glasses would
     * reject wholesale at the CRC, with nothing in any log to say why.
     */
    private fun drainStepLocked(lens: G2Lens) {
        val gatt = lens.gatt
        val writeChar = lens.writeChar
        // The lens may have disconnected between steps -- bail and release the lock.
        if (!lens.connected || gatt == null || writeChar == null) {
            lens.draining = false
            lens.txStalled = false
            lens.txRetries = 0
            lens.writeQueue.clear()
            return
        }
        val packet = lens.writeQueue.firstOrNull()
        if (packet == null) {
            lens.draining = false
            return
        }

        // A write longer than the negotiated ceiling is TRUNCATED by the stack, not rejected:
        // the call succeeds, short bytes go on the wire, and the glasses drop the message at the
        // CRC with nothing logged anywhere. Worth one loud line per side.
        //
        // KNOWN LIVE CASE, and it is in the shared framer rather than here: buildPackets spills
        // the CRC into an extra packet only when the final chunk is EXACTLY 236, so a final chunk
        // of 235 emits 8+235+2 = 245 bytes -- one over the 244 that MTU 247 buys. It fires
        // whenever payload.size % 236 == 235, roughly 1 message in 236. The same arithmetic holds
        // in G2Protocol.swift, so this is inherited from the proven iOS path, not introduced
        // here; fixing the framer would change bytes on BOTH platforms and needs an on-glass
        // decision, so for now it is made VISIBLE rather than silently patched. See the handover.
        val ceiling = lens.negotiatedMtu - ATT_OVERHEAD
        if (packet.size > ceiling && !lens.oversizeWarned) {
            lens.oversizeWarned = true
            log(
                "WARNING side=${lens.side.raw}: ${packet.size}B packet exceeds the ${ceiling}B write " +
                    "ceiling -- the stack will TRUNCATE it and the glasses will fail its CRC"
            )
        }

        val status = writeNoResponse(gatt, writeChar, packet)
        if (status != 0) {
            lens.txRetries += 1
            if (!lens.txStalled) {
                lens.txStalled = true
                log("tx STALL side=${lens.side.raw} depth=${lens.writeQueue.size} status=$status")
                onTxStall?.invoke(lens.side.raw, lens.writeQueue.size)
            }
            if (lens.txRetries > WRITE_MAX_RETRIES) {
                // Dropping one packet corrupts one message; wedging the drain kills the
                // heartbeat and takes the whole session with it. Drop, shout, keep going.
                lens.writeQueue.removeFirst()
                lens.txRetries = 0
                log(
                    "tx DROP side=${lens.side.raw} -- packet refused $WRITE_MAX_RETRIES times " +
                        "(${packet.size}B); the message it belonged to is now corrupt"
                )
            }
            schedule(WRITE_RETRY_MS) { drainStepLocked(lens) }
            return
        }

        lens.writeQueue.removeFirst()
        if (lens.txStalled) {
            lens.txStalled = false
            log("tx RESUME side=${lens.side.raw} depth=${lens.writeQueue.size}")
            onTxResume?.invoke(lens.side.raw, lens.writeQueue.size)
        }
        lens.txRetries = 0
        lens.txBytesAccum += packet.size
        lens.txPktsAccum += 1
        ensureTxMeterLocked()

        if (ENABLE_BACKPRESSURE_GATE) {
            // Completion-driven pacing: the next packet goes out from onCharacteristicWrite.
            // The timer below is a safety net only -- some stacks do not report completion for
            // write-without-response, and a lost callback would otherwise wedge this side.
            val gen = ++lens.writeGen
            schedule(WRITE_COMPLETION_TIMEOUT_MS) {
                if (lens.draining && lens.writeGen == gen) drainStepLocked(lens)
            }
        } else {
            schedule(WRITE_PACING_MS) { drainStepLocked(lens) }
        }
    }

    /**
     * One write-without-response. Returns 0 on success, non-zero if the stack refused it.
     *
     * API 33 replaced the mutate-then-write pattern with an explicit value argument returning a
     * status int. The old form is not merely deprecated on 33+ -- `characteristic.value` is
     * shared mutable state on the GATT object, so two sides writing concurrently through it can
     * race. We use the new API wherever it exists.
     */
    private fun writeNoResponse(
        gatt: BluetoothGatt,
        ch: BluetoothGattCharacteristic,
        value: ByteArray
    ): Int = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeCharacteristic(
                ch, value, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            )
        } else {
            @Suppress("DEPRECATION")
            run {
                ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                ch.value = value
                if (gatt.writeCharacteristic(ch)) 0 else -1
            }
        }
    } catch (e: SecurityException) {
        log("write refused -- SecurityException (${e.message})")
        -2
    }

    // MARK: - FUT-253 tx-throughput meter

    /** Ensure the tx-meter tick loop is running (idempotent); self-stops when no lens is up. */
    private fun ensureTxMeterLocked() {
        if (txMeterRunning) return
        txMeterRunning = true
        schedule(TX_METER_INTERVAL_MS) { txMeterTickLocked() }
    }

    /**
     * One tx-meter interval: for each connected side that saw traffic OR still has a backlog,
     * emit bytes/pkts-this-interval + current queue depth, then reset the accumulators. Emits
     * nothing for idle sides (bounds the meter's own volume).
     */
    private fun txMeterTickLocked() {
        if (lenses.isEmpty()) {
            txMeterRunning = false
            return
        }
        for (lens in lenses.values) {
            val depth = lens.writeQueue.size
            if (lens.txPktsAccum > 0 || depth > 0) {
                onTxMeter?.invoke(lens.side.raw, lens.txBytesAccum, lens.txPktsAccum, depth)
            }
            lens.txBytesAccum = 0
            lens.txPktsAccum = 0
        }
        schedule(TX_METER_INTERVAL_MS) { txMeterTickLocked() }
    }

    // MARK: - Pair / readiness helpers

    /**
     * Required chars for a side: WRITE always; NOTIFY only on the side that actually exposes it
     * (the RIGHT lens carries the protocol channel -- the LEFT is silent, so we do NOT require
     * a notify char on the left).
     */
    private fun requiredCharsFound(lens: G2Lens): Boolean {
        if (lens.writeChar == null) return false
        if (lens.side == G2Side.RIGHT) return lens.notifyChar != null
        return true
    }

    private fun sideReadyLocked(side: G2Side): Boolean {
        val lens = lenses[side] ?: return false
        return lens.connected && requiredCharsFound(lens)
    }

    private fun pairReadyLocked(): Boolean =
        sideReadyLocked(G2Side.LEFT) && sideReadyLocked(G2Side.RIGHT)

    /**
     * "Is the CURRENT connect intent satisfied?" -- pair-ready when we want the pair, or the
     * single side ready when we want just one. Used by the recovery watchdog so a single-side
     * connect (which never makes the pair ready) still terminates.
     */
    private fun intentReadyLocked(): Boolean {
        if (wantsPair) return pairReadyLocked()
        val s = wantsSingleSide ?: return false
        return sideReadyLocked(s)
    }

    /**
     * Re-check the pair after any connect / char-discovery / disconnect. Fires onPairReady
     * exactly once on the transition into the ready state, and re-arms once the pair is no
     * longer ready (so a reconnect can fire again).
     */
    private fun evaluatePairLocked() {
        leftReadySnapshot = sideReadyLocked(G2Side.LEFT)
        rightReadySnapshot = sideReadyLocked(G2Side.RIGHT)
        val ready = leftReadySnapshot && rightReadySnapshot
        pairReadySnapshot = ready

        if (ready && !pairReadyFired) {
            pairReadyFired = true
            log("PAIR READY -- both lenses connected + required characteristics bound")
            onPairReady?.invoke()
        } else if (!ready && pairReadyFired) {
            pairReadyFired = false
        }
        armRecoverWatchdogLocked()
    }

    // MARK: - Connect helpers

    /** Connect whatever discovered lenses satisfy the current intent. */
    private fun connectDiscoveredLocked() {
        if (wantsPair) {
            for (side in listOf(G2Side.LEFT, G2Side.RIGHT)) {
                if (lenses[side] == null) discovered[side]?.let { beginConnectLocked(it) }
            }
        } else {
            val side = wantsSingleSide ?: return
            if (lenses[side] == null) discovered[side]?.let { beginConnectLocked(it) }
        }
    }

    /**
     * @param fromAdvertisement true when we just saw this device advertising, which is the
     * only case where autoConnect=false is right. See the note inside.
     */
    private fun beginConnectLocked(disc: G2Discovery, fromAdvertisement: Boolean = true) {
        val side = disc.side
        if (side != G2Side.LEFT && side != G2Side.RIGHT) {
            log("Refusing to connect lens with unknown side: ${disc.name}")
            return
        }
        if (lenses[side] != null) return // already connecting/connected
        if (!ensurePermissionsLocked("connect")) return

        val lens = G2Lens(disc.device, side, disc.name)
        lenses[side] = lens
        log("Connecting to ${disc.name} (side=${side.raw}, direct=$fromAdvertisement)")

        // STOP SCANNING BEFORE connectGatt. Measured 2026-08-07 on the Redmi A2+ (MediaTek):
        // the LEFT lens failed with "GATT_ERROR (133) -- connect timeout" and the watchdog then
        // retried every 6s, so a pair took ~40s to come up and looked like a link that "drops and
        // re-pairs on its own". It is not a drop -- everConnected was false, i.e. a failed
        // ATTEMPT. An active LE scan concurrent with connectGatt is the classic 133 on MediaTek
        // and Broadcom stacks: the controller cannot service a scan window and an initiator at
        // once, so the connect request times out.
        //
        // maybeStopScanningLocked() below could not prevent this -- it only stops once EVERY
        // wanted side is in the map, so the first lens always connected mid-scan, and the second
        // connectGatt was issued while the scan was still running too.
        //
        // Safe to stop unconditionally: if a side is still missing, the recovery watchdog
        // re-arms a scan within RECOVER_TIMEOUT_MS (see runRecoveryLocked -> startScanLocked).
        stopScanLocked()

        // autoConnect is the single most consequential argument here and it has no iOS
        // equivalent. false = "connect now, fail after ~30s with status 133" -- correct when we
        // have just seen the device advertise. true = "connect whenever it shows up, never time
        // out" -- correct for a reclaim of a bonded lens that is not advertising, which is
        // exactly the FUT-219 case iOS covers with a pending connect().
        lens.gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            disc.device.connectGatt(
                context, !fromAdvertisement, gattCallback, BluetoothDevice.TRANSPORT_LE
            )
        } else {
            disc.device.connectGatt(context, !fromAdvertisement, gattCallback)
        }
        if (lens.gatt == null) {
            log("connectGatt returned null for ${disc.name} (side=${side.raw})")
            lenses.remove(side)
            return
        }

        // Once we've initiated connects for every side we still want, stop scanning to save
        // power. For a single-side connect, stop as soon as it is underway; for the pair, stop
        // only once both sides are accounted for.
        maybeStopScanningLocked()
    }

    private fun maybeStopScanningLocked() {
        if (wantsPair) {
            if (lenses[G2Side.LEFT] != null && lenses[G2Side.RIGHT] != null) stopScanLocked()
        } else {
            val side = wantsSingleSide ?: return
            if (lenses[side] != null) stopScanLocked()
        }
    }

    /** Fully release a lens's GATT client. See difference 5 in the class header. */
    private fun closeLens(lens: G2Lens) {
        lens.connected = false
        lens.writeQueue.clear()
        lens.draining = false
        lens.txStalled = false
        lens.txRetries = 0
        lens.writeChar = null
        lens.notifyChar = null
        lens.audioChar = null
        lens.pendingOps.clear()
        lens.opInFlight = null
        lens.rx.reset()
        try {
            lens.gatt?.close()
        } catch (e: Exception) {
            log("gatt.close() threw for side=${lens.side.raw}: ${e.message}")
        }
        lens.gatt = null
    }

    // MARK: - Reclaim already-connected / bonded lenses (FUT-219)

    private fun persistMacLocked(side: G2Side, address: String) {
        if (side != G2Side.LEFT && side != G2Side.RIGHT) return
        prefs.edit().putString(KEY_MAC_PREFIX + side.raw, address).apply()
    }

    private fun savedMac(side: G2Side): String? = prefs.getString(KEY_MAC_PREFIX + side.raw, null)

    /**
     * The root-cause fix for the "R lens stuck Booting..." reconnect bug (FUT-219): a lens the
     * system already holds connected/bonded does NOT advertise, so a scan can never rediscover
     * it. Ask the stack for what it already has connected, plus anything we have bonded to or
     * remembered by MAC, and connect those directly.
     *
     * Android's advantage over iOS here: MAC addresses are stable and can be resolved offline
     * with `getRemoteDevice`, so a remembered side can be re-bound with no scan and no system
     * lookup at all. Only binds sides the current intent wants and that are not already boxed;
     * safe to call repeatedly.
     */
    private fun reclaimConnectedLocked() {
        val adapter = this.adapter ?: return
        if (!adapter.isEnabled) return
        if (!wantsPair && wantsSingleSide == null) return
        if (missingPermissions().isNotEmpty()) return

        val candidates = LinkedHashMap<String, BluetoothDevice>()

        // 1. Remembered by side -- the most reliable, and it survives a name we cannot read.
        for (side in listOf(G2Side.LEFT, G2Side.RIGHT)) {
            if (lenses[side] != null) continue
            if (!wantsPair && wantsSingleSide != side) continue
            val mac = savedMac(side) ?: continue
            val dev = try {
                adapter.getRemoteDevice(mac)
            } catch (e: IllegalArgumentException) {
                log("stored MAC for side ${side.raw} is invalid ($mac)")
                null
            } ?: continue
            val name = dev.name ?: "Even G2 (${side.raw})"
            val disc = G2Discovery(dev, name, side, 0, null)
            discovered[side] = disc
            log("Reclaiming remembered lens '$name' side=${side.raw} (mac=$mac) -- no advertisement needed")
            beginConnectLocked(disc, fromAdvertisement = false)
        }

        // 2. Anything the system already holds a GATT link to, plus bonded devices.
        bluetoothManager?.let { mgr ->
            for (profile in intArrayOf(BluetoothProfile.GATT, BluetoothProfile.GATT_SERVER)) {
                for (d in mgr.getConnectedDevices(profile)) candidates[d.address] = d
            }
        }
        for (d in adapter.bondedDevices.orEmpty()) candidates[d.address] = d

        for (dev in candidates.values) {
            val nm = dev.name ?: continue
            if (!nm.contains(NAME_MATCH)) continue
            val s = sideFromName(nm)
            if (s != G2Side.LEFT && s != G2Side.RIGHT) continue
            if (lenses[s] != null) continue
            if (!wantsPair && wantsSingleSide != s) continue
            val disc = G2Discovery(dev, nm, s, 0, null)
            discovered[s] = disc
            log("Reclaiming already-known lens '$nm' side=${s.raw} -- binding without an advertisement")
            beginConnectLocked(disc, fromAdvertisement = false)
        }
    }

    // MARK: - Recovery watchdog (FUT-219)

    private fun cancelRecoverWatchdogLocked() {
        recoverTimer?.let { handler.removeCallbacks(it) }
        recoverTimer = null
    }

    /**
     * Arm/refresh the recovery watchdog. Cheap to call after any pair re-evaluation; it cancels
     * itself once the pair is ready or connect intent is dropped.
     */
    private fun armRecoverWatchdogLocked() {
        cancelRecoverWatchdogLocked()
        // OBSERVED ON-GLASS 2026-08-07 during the first Android flash: the LEFT lens reboots
        // the instant its transfer commits, which drops the pair, which re-arms this watchdog,
        // which then starts SCANNING and reconnecting *while the RIGHT lens is still receiving
        // firmware blocks*. It happened to survive that run, but a scan plus a fresh GATT
        // connection competing with an OTA transfer is not something to leave to luck: a
        // corrupted block mid-main-app is a half-written lens. The flasher owns the link
        // exclusively for its duration, exactly as the heartbeat already stands down.
        if (flasher.active) return
        if (!wantsPair && wantsSingleSide == null) return
        if (intentReadyLocked()) return
        // Wrapped, then STORED -- removeCallbacks matches by identity, so the object we post
        // and the object we later cancel have to be the same one.
        val work = guarded("recoverWatchdog") {
            recoverTimer = null
            runRecoveryLocked()
        }
        recoverTimer = work
        handler.postDelayed(work, RECOVER_TIMEOUT_MS)
    }

    /**
     * One recovery pass for a stuck/half-connected state, then re-arm while still not ready.
     * Order: (1) re-bind anything the system already holds connected (the non-advertising root
     * cause), (2) re-issue GATT discovery on a side that connected but never bound its chars,
     * (3) ensure a scan is running for a genuinely-absent side.
     */
    private fun runRecoveryLocked() {
        // Second guard: a watchdog armed before the flash started must not fire during it.
        if (flasher.active) return
        if (!wantsPair && wantsSingleSide == null) return
        if (intentReadyLocked()) return
        log("Recovery watchdog -- connect intent not ready within ${RECOVER_TIMEOUT_MS}ms; recovering")

        reclaimConnectedLocked()

        for ((s, lens) in lenses) {
            if (lens.connected && !requiredCharsFound(lens)) {
                log("Recovery -- re-discovering services on connected-but-incomplete side=${s.raw}")
                lens.gatt?.discoverServices()
            }
        }

        val missingSide = (wantsPair && (lenses[G2Side.LEFT] == null || lenses[G2Side.RIGHT] == null)) ||
            (wantsSingleSide != null && lenses[wantsSingleSide] == null)
        if (missingSide) startScanLocked()

        armRecoverWatchdogLocked()
    }

    // MARK: - Advertisement parsing

    /** Derive the lens side from a peripheral name like "Even G2_XX_L_XXXXXX". */
    private fun sideFromName(name: String): G2Side = when {
        name.contains("_L_") -> G2Side.LEFT
        name.contains("_R_") -> G2Side.RIGHT
        else -> G2Side.UNKNOWN
    }

    /**
     * Parse the manufacturer-specific advertisement blob:
     *   "ER"(2) + SN(14 ASCII) + MAC(6, little-endian) + flag(1), >= 22 bytes.
     * MAC is reversed -> big-endian colon-hex.
     *
     * The 2-byte prefix matters: iOS hands you the manufacturer AD payload INCLUDING the
     * company-ID bytes, while Android splits it into a SparseArray keyed BY company ID with
     * those bytes already stripped. [manufacturerBlob] re-attaches them so this parser stays
     * byte-identical to the Swift one -- worth the small cost, because the SN/MAC offsets are
     * the kind of thing nobody re-derives once it works.
     */
    private fun parseManufacturer(data: ByteArray?): G2Manufacturer? {
        if (data == null || data.size < 22) return null
        // bytes[0..2) == "ER" magic; not hard-required, matching the Swift original.
        val sn = String(data, 2, 14, Charsets.US_ASCII).trim { it == '\u0000' }
        val mac = (21 downTo 16).joinToString(":") { "%02X".format(data[it].toInt() and 0xFF) }
        return G2Manufacturer(sn, mac)
    }

    /** Rebuild the iOS-shaped manufacturer blob (company ID + payload) from a scan record. */
    private fun manufacturerBlob(result: ScanResult): ByteArray? {
        val msd = result.scanRecord?.manufacturerSpecificData ?: return null
        if (msd.size() == 0) return null
        val id = msd.keyAt(0)
        val payload = msd.valueAt(0) ?: return null
        val out = ByteArray(payload.size + 2)
        out[0] = (id and 0xFF).toByte()
        out[1] = ((id ushr 8) and 0xFF).toByte()
        System.arraycopy(payload, 0, out, 2, payload.size)
        return out
    }

    // MARK: - Scanning callbacks

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            post { handleScanResultLocked(result) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            post { for (r in results) handleScanResultLocked(r) }
        }

        override fun onScanFailed(errorCode: Int) {
            post {
                isScanning = false
                val why = when (errorCode) {
                    SCAN_FAILED_ALREADY_STARTED -> "already started"
                    SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "app registration failed"
                    SCAN_FAILED_INTERNAL_ERROR -> "internal error"
                    SCAN_FAILED_FEATURE_UNSUPPORTED -> "feature unsupported"
                    // 6 = SCAN_FAILED_SCANNING_TOO_FREQUENTLY: Android rate-limits an app to 5
                    // scan starts per 30s window and silently punishes the 6th.
                    6 -> "scanning too frequently (5 starts / 30s limit)"
                    else -> "code $errorCode"
                }
                log("Scan FAILED -- $why")
            }
        }
    }

    private fun handleScanResultLocked(result: ScanResult) {
        scanResultsSeen += 1
        val device = result.device ?: return
        // The advertised local name is the authoritative filter surface, exactly as on iOS.
        val name = result.scanRecord?.deviceName ?: device.name ?: return
        if (!name.contains(NAME_MATCH)) return

        val s = sideFromName(name)
        val mfg = parseManufacturer(manufacturerBlob(result))
        val disc = G2Discovery(device, name, s, result.rssi, mfg)
        val isNew = discovered[s] == null
        discovered[s] = disc // dedupe by side; keep latest advertisement

        if (isNew) {
            log(
                "Discovered G2 lens '$name' side=${s.raw} rssi=${result.rssi}" +
                    " sn=${mfg?.sn ?: "?"} mac=${mfg?.mac ?: "?"}"
            )
        }
        onDeviceFound?.invoke(name, s.raw, result.rssi, mfg?.sn, mfg?.mac)

        if ((s == G2Side.LEFT || s == G2Side.RIGHT) && lenses[s] == null) {
            if (wantsPair || wantsSingleSide == s) beginConnectLocked(disc)
        }
    }

    // MARK: - GATT callbacks
    //
    // Every one of these arrives on a binder thread from the Bluetooth stack. They do the
    // absolute minimum inline and hop straight onto the serial queue, so all driver state stays
    // single-threaded exactly as it is on the CoreBluetooth queue in the Swift original.

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            post { handleConnectionStateLocked(gatt, status, newState) }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            post { handleMtuChangedLocked(gatt, mtu, status) }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            post { handleServicesDiscoveredLocked(gatt, status) }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            post { handleDescriptorWriteLocked(gatt, descriptor, status) }
        }

        override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
            post {
                val lens = lensFor(gatt) ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    log("readRSSI error (side=${lens.side.raw}): status=$status")
                    return@post
                }
                onRssi?.invoke(lens.side.raw, rssi)
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (!ENABLE_BACKPRESSURE_GATE) return
            post {
                val lens = lensFor(gatt) ?: return@post
                if (characteristic.uuid != CHAR_WRITE) return@post
                // Consume the safety-net timer's generation so it cannot double-fire.
                lens.writeGen += 1
                if (lens.draining) drainStepLocked(lens)
            }
        }

        // API 33+ delivers the value explicitly; below that it lives on the characteristic.
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            val uuid = characteristic.uuid
            post { handleNotificationLocked(gatt, uuid, value) }
        }

        @Deprecated("Deprecated in API 33, still the only path below it")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            val uuid = characteristic.uuid
            // Copy: the framework reuses this buffer for the next notification.
            val value = characteristic.value?.copyOf() ?: return
            post { handleNotificationLocked(gatt, uuid, value) }
        }
    }

    private fun lensFor(gatt: BluetoothGatt): G2Lens? =
        lenses.values.firstOrNull { it.gatt === gatt || it.device.address == gatt.device.address }

    private fun handleConnectionStateLocked(gatt: BluetoothGatt, status: Int, newState: Int) {
        val lens = lensFor(gatt)
        val address = gatt.device.address
        if (lens == null) {
            // A link we no longer track (e.g. a stale gatt from a torn-down lens). Close it or
            // it leaks a GATT client interface for the life of the process.
            log("Connection state $newState (status=$status) for untracked device $address -- closing")
            try {
                gatt.close()
            } catch (_: Exception) {
            }
            return
        }
        val side = lens.side

        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
            lens.connected = true
            lens.everConnected = true
            persistMacLocked(side, address)
            log("Connected to ${lens.name} (side=${side.raw}) -- negotiating MTU")
            onConnected?.invoke(lens.name, side.raw)

            // MTU first, discovery second (see difference 1). Changing the MTU after service
            // discovery works on most stacks and corrupts the cached attribute table on some;
            // asking first is free.
            val requested = try {
                gatt.requestMtu(WANT_MTU)
            } catch (e: SecurityException) {
                log("requestMtu refused: ${e.message}")
                false
            }
            if (!requested) {
                log("requestMtu($WANT_MTU) refused by the stack -- discovering services at default MTU")
                gatt.discoverServices()
            }
            evaluatePairLocked()
            return
        }

        if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            val wasConnected = lens.connected
            val everConnected = lens.everConnected
            val desc = describeGattStatus(status)
            closeLens(lens)
            lenses.remove(side)

            if (!everConnected) {
                // Never made it up: this is a failed ATTEMPT, not a drop. iOS splits these into
                // two delegate methods; Android reports both through this one callback, and the
                // distinction matters -- 133-on-connect means "retry", 8-after-connect means
                // "the user walked away".
                log("Failed to connect to ${lens.name} (side=${side.raw}): $desc [status=$status]")
                onConnectFailed?.invoke(side.raw, status, GATT_DOMAIN, desc)
            } else {
                val reason = if (status == BluetoothGatt.GATT_SUCCESS) null else desc
                log(
                    "Disconnected from ${lens.name} (side=${side.raw}): " +
                        "${reason ?: "clean"} [status=$status]"
                )
                onDisconnected?.invoke(lens.name, side.raw, reason, status, GATT_DOMAIN)
            }
            if (wasConnected || everConnected) resetSessionLocked()
            evaluatePairLocked()
            return
        }

        // A connected-state callback carrying a failure status, or an intermediate state.
        if (status != BluetoothGatt.GATT_SUCCESS) {
            log(
                "Connection state change with error on side=${side.raw}: " +
                    "state=$newState status=$status (${describeGattStatus(status)})"
            )
        }
    }

    private fun handleMtuChangedLocked(gatt: BluetoothGatt, mtu: Int, status: Int) {
        val lens = lensFor(gatt) ?: return
        lens.negotiatedMtu = mtu
        val payload = mtu - ATT_OVERHEAD
        if (!lens.mtuReported) {
            lens.mtuReported = true
            log("MTU (write-without-response) side=${lens.side.raw} = $payload (att mtu=$mtu, status=$status)")
            onMtu?.invoke(lens.side.raw, payload)
        }
        // 244 = 8-byte transport header + the 236-byte payload chunk the framer emits. Below
        // that, full packets are truncated on the wire and every multi-packet message fails its
        // CRC -- with no error anywhere, because the write itself succeeded.
        if (payload < 8 + G2Wire.MAX_PACKET_PAYLOAD) {
            log(
                "WARNING side=${lens.side.raw}: negotiated write ceiling is $payload B but the " +
                    "transport emits up to ${8 + G2Wire.MAX_PACKET_PAYLOAD} B -- large packets " +
                    "will be truncated"
            )
        }
        gatt.discoverServices()
    }

    private fun handleServicesDiscoveredLocked(gatt: BluetoothGatt, status: Int) {
        val lens = lensFor(gatt) ?: return
        val s = lens.side
        if (status != BluetoothGatt.GATT_SUCCESS) {
            log("Service discovery error (side=${s.raw}): status=$status")
            return
        }
        val services = gatt.services.orEmpty()
        log(
            "Discovered ${services.size} service(s) on side ${s.raw}: " +
                services.joinToString(", ") { it.uuid.toString().uppercase() }
        )

        val matched = ArrayList<String>()
        for (service in services) {
            for (ch in service.characteristics.orEmpty()) {
                when (ch.uuid) {
                    CHAR_WRITE -> {
                        lens.writeChar = ch
                        matched.add(uuidString(ch.uuid))
                        log("Found WRITE char ${uuidString(ch.uuid)} (side=${s.raw})")
                    }
                    CHAR_NOTIFY -> {
                        lens.notifyChar = ch
                        matched.add(uuidString(ch.uuid))
                        log("Found NOTIFY char ${uuidString(ch.uuid)} (side=${s.raw}) -- subscribing")
                        subscribeLocked(lens, ch)
                    }
                    AUDIO_NOTIFY -> {
                        lens.audioChar = ch
                        matched.add(uuidString(ch.uuid))
                        log("Found AUDIO char ${uuidString(ch.uuid)} (side=${s.raw}) -- subscribing")
                        subscribeLocked(lens, ch)
                    }
                }
            }
        }
        if (matched.isNotEmpty()) onServicesDiscovered?.invoke(s.raw, matched)
        // Characteristic discovery is where readiness actually flips -- re-evaluate.
        evaluatePairLocked()
    }

    /**
     * Enable notifications for [ch]. TWO steps, both required (difference 2 in the class
     * header): `setCharacteristicNotification` wires the local callback, and the CCCD write
     * tells the peripheral to actually send. The descriptor write is queued because a second
     * one issued while the first is in flight is silently discarded -- which is precisely what
     * happens on the right lens, where we subscribe to both the protocol and audio channels.
     */
    private fun subscribeLocked(lens: G2Lens, ch: BluetoothGattCharacteristic) {
        val gatt = lens.gatt ?: return
        if (!gatt.setCharacteristicNotification(ch, true)) {
            log("setCharacteristicNotification FAILED for ${uuidString(ch.uuid)} (side=${lens.side.raw})")
            return
        }
        val cccd = ch.getDescriptor(CCCD)
        if (cccd == null) {
            // Without a CCCD the peripheral has no way to be told to notify. Report it as an
            // unsubscribed channel rather than pretending the subscription took.
            log("no CCCD on ${uuidString(ch.uuid)} (side=${lens.side.raw}) -- cannot enable notifications")
            onSubscribe?.invoke(lens.side.raw, uuidString(ch.uuid), false)
            return
        }
        val useIndicate = (ch.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0 &&
            (ch.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
        val value = if (useIndicate) {
            BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        } else {
            BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        }
        val chUuid = uuidString(ch.uuid)
        enqueueGattOpLocked(
            lens,
            "subscribe:$chUuid",
            // If the subscription is abandoned, SAY SO. A silently missing notify channel is
            // indistinguishable from a peripheral that has nothing to say -- and on the right
            // lens it means no gestures, no image ACKs and no device info, forever.
            onGiveUp = {
                log("SUBSCRIPTION LOST for $chUuid (side=${lens.side.raw}) -- this channel is dead")
                onSubscribe?.invoke(lens.side.raw, chUuid, false)
            }
        ) {
            writeDescriptor(gatt, cccd, value)
        }
    }

    private fun writeDescriptor(
        gatt: BluetoothGatt,
        descriptor: BluetoothGattDescriptor,
        value: ByteArray
    ): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                descriptor.value = value
                gatt.writeDescriptor(descriptor)
            }
        }
    } catch (e: SecurityException) {
        log("writeDescriptor refused: ${e.message}")
        false
    }

    /** Queue a serialized GATT operation for this link, starting it if nothing is in flight. */
    private fun enqueueGattOpLocked(
        lens: G2Lens,
        label: String,
        onGiveUp: (() -> Unit)? = null,
        op: () -> Boolean
    ) {
        lens.pendingOps.addLast(GattOp(label, op, onGiveUp))
        startNextGattOpLocked(lens)
    }

    /**
     * Run the head of this link's op queue.
     *
     * Two things here are load-bearing and were both wrong in the first cut of this driver:
     *
     * 1. The op is PEEKED, not popped, and a REFUSAL IS RETRIED. `BluetoothGatt` guards a single
     *    in-flight operation per link with one `mDeviceBusy` flag, and the paced write drain --
     *    which is NOT part of this queue -- re-arms that flag every 6 ms. So a CCCD write issued
     *    while the drain is running is refused on the spot. Discarding it there loses the
     *    subscription permanently: the lens then reports ready with a dead notify channel, and
     *    on the right lens that channel IS the protocol path (gestures, image ACKs, device info).
     *    Nothing anywhere would have said so.
     *
     * 2. The timeout is matched by GENERATION, not by label. Two ops can share a label, and a
     *    completion arriving after its own timeout already fired would otherwise complete the
     *    NEXT op -- silently skipping it and everything queued behind it.
     */
    private fun startNextGattOpLocked(lens: G2Lens) {
        if (lens.opInFlight != null) return
        val op = lens.pendingOps.firstOrNull() ?: return
        lens.opInFlight = op
        val gen = ++lens.opGen

        if (!op.run()) {
            lens.opInFlight = null
            op.attempts += 1
            if (op.attempts > GATT_OP_MAX_RETRIES) {
                lens.pendingOps.removeFirstOrNull()
                log(
                    "GATT op '${op.label}' refused $GATT_OP_MAX_RETRIES times (side=${lens.side.raw})" +
                        " -- giving up"
                )
                op.onGiveUp?.invoke()
            } else {
                log("GATT op '${op.label}' refused (side=${lens.side.raw}) -- retry ${op.attempts}")
            }
            schedule(GATT_OP_RETRY_MS) { startNextGattOpLocked(lens) }
            return
        }

        // A lost completion callback would wedge every later op on this link -- including the
        // second subscription on the right lens. Time out and move on rather than stall silently.
        schedule(GATT_OP_TIMEOUT_MS) {
            if (lens.opGen == gen && lens.opInFlight === op) {
                log("GATT op '${op.label}' timed out (side=${lens.side.raw}) -- continuing")
                lens.pendingOps.removeFirstOrNull()
                lens.opInFlight = null
                op.onGiveUp?.invoke()
                startNextGattOpLocked(lens)
            }
        }
    }

    /** A GATT operation completed; retire it and start the next. */
    private fun completeGattOpLocked(lens: G2Lens) {
        lens.opGen += 1 // invalidates the in-flight op's pending timeout
        lens.pendingOps.removeFirstOrNull()
        lens.opInFlight = null
        startNextGattOpLocked(lens)
    }

    private fun handleDescriptorWriteLocked(
        gatt: BluetoothGatt,
        descriptor: BluetoothGattDescriptor,
        status: Int
    ) {
        val lens = lensFor(gatt) ?: return
        val chUuid = uuidString(descriptor.characteristic.uuid)
        if (descriptor.uuid == CCCD) {
            val on = status == BluetoothGatt.GATT_SUCCESS
            if (on) {
                log("Notify state for $chUuid (side=${lens.side.raw}) -> ON")
            } else {
                log("Notify subscribe FAILED for $chUuid (side=${lens.side.raw}): status=$status")
            }
            // FUT-253: the right lens's notify channel IS the protocol/ACK path -- a silent
            // unsubscribe explains a dead session, so this is a structured emit, not a log line.
            onSubscribe?.invoke(lens.side.raw, chUuid, on)
        }
        completeGattOpLocked(lens)
    }

    // MARK: - Inbound notifications

    private fun handleNotificationLocked(gatt: BluetoothGatt, uuid: UUID, data: ByteArray) {
        val lens = lensFor(gatt)
        val s = lens?.side ?: sideFromName(gatt.device.name ?: "")

        // FUT-167 Stage 2: during a flash the DATA-notify characteristic carries OTA ack frames.
        // Hand them to the flasher and do NOT run them through gesture/image parsing -- they are
        // a different protocol entirely and would decode as garbage.
        if (flasher.active && uuid == FLASH_DATA_NOTIFY) {
            flasher.offerRx(data)
            return
        }

        // ⛔ PRIVACY GUARD -- microphone audio leaves the notification path RIGHT HERE, before it
        // can be base64'd, logged, or shipped to JS. This is not a routing optimisation: below
        // this line every notification is turned into a base64 string, written to the driver log
        // and emitted to JavaScript, and a recording of the wearer must not go anywhere near any
        // of that. Keep this the FIRST thing that happens after the flasher check, and never
        // "temporarily" add a log line inside it. See [onAudioPacket].
        if (uuid == AUDIO_NOTIFY) {
            micStats.count(data.size, s.raw)
            onAudioPacket?.invoke(data, s.raw)
            return
        }

        val b64 = android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)
        // Compact log -- the full payload goes to JS as base64 via onNotify, tagged side.
        log("Notify ${uuidString(uuid)} (side=${s.raw}, ${data.size} bytes)")
        onNotify?.invoke(b64, uuidString(uuid), s.raw)

        // Reassemble the 0xAA transport per side (once), then interpret an EvenHub (0xE0)
        // message as either a touch gesture OR an image-fragment ACK.
        if (uuid != CHAR_NOTIFY || lens == null) return
        val (svc, payload) = lens.rx.feed(data) ?: return
        dispatchInboundLocked(svc, payload, s)
    }

    /**
     * Interpret one fully-reassembled inbound service message. Split out from the notification
     * handler so [simulateGesture] can drive the identical decode path with a synthetic frame.
     */
    private fun dispatchInboundLocked(svc: Int, payload: ByteArray, s: G2Side) {
        // Hand the untouched payload to JS FIRST, for every service, so the SDK sees every frame
        // regardless of what the Kotlin decoders below make of it.
        onServiceRaw?.invoke(svc, encodeBase64(payload))
        when (svc) {
            G2ServiceID.EVEN_HUB -> {
                val gesture = G2EvenHub.parseGesture(payload)
                if (gesture != null) {
                    handleGestureLocked(gesture.name, s, gesture.source)
                    // THE SAME FRAME carries the structured event. Observed on-glass 2026-08-07:
                    // a temple tap on a declared list arrives as gesture AND as
                    // Cmd=2 / DevEvent(13) / ListEvent(1){ContainerID=3, ContainerName="ffs-list",
                    // CurrentSelectItemIndex=1}. Decoding it here (not only in the else branch)
                    // is what turns "a tap happened" into "the user chose row 1".
                    G2EvenHub.decodeEvent(payload)?.let { evt ->
                        log("GLASSES EVENT: ${evt.describe()}")
                        onGlassesEvent?.invoke(
                            evt.kind, evt.containerId, evt.containerName,
                            evt.itemIndex, evt.itemName, evt.eventType, evt.eventSource
                        )
                    }
                    if (dumpInbound) log("EvenHub event fields:\n" + G2EvenHub.describePayload(payload))
                } else {
                    // Image-fragment ACKs were handled here for the (quarantined) image-transfer
                    // path; the bridge no longer streams images. What remains is the return path.
                    val evt = G2EvenHub.decodeEvent(payload)
                    if (evt != null) {
                        // THE RETURN PATH of the hybrid architecture: the glasses owned the
                        // interaction and are telling us only what the user chose.
                        log("GLASSES EVENT: ${evt.describe()}")
                        onGlassesEvent?.invoke(
                            evt.kind, evt.containerId, evt.containerName,
                            evt.itemIndex, evt.itemName, evt.eventType, evt.eventSource
                        )
                    } else if (dumpInbound) {
                        // Anything the decoders did not recognise. Silence here is how a new
                        // message shape stays invisible.
                        log("EvenHub UNDECODED (${payload.size}B):\n" + G2EvenHub.describePayload(payload))
                    }
                }
            }
            G2ServiceID.G2_SETTING -> {
                // FUT-169 / FUT-167: a device-info response (battery / version). Routed purely
                // by service id, so it can never swallow an EvenHub gesture/image-ack frame.
                G2Setting.parseDeviceInfo(payload)?.let { handleDeviceInfoLocked(it, s) }
                // The full settings snapshot. This is the camera-free verification loop: set a
                // value, read it back, compare. Quantitative, so it beats eyeballing the HUD.
                G2Setting.parseSettingsSnapshot(payload)?.let {
                    log("SETTINGS (side=${s.raw}): ${it.describe()}")
                }
            }
        }
    }

    // MARK: - Gesture simulation (test affordance)

    /**
     * Inject a synthetic touch gesture as if the glasses had sent it.
     *
     * WHAT THIS PROVES, AND WHAT IT DOES NOT. The frame is built to the real firmware shape
     * (`evenhub_main_msg_ctx{cmd=2, f13=SendDeviceEvent{f3=SysEvent{...}}}`) and pushed through
     * the REAL 0xAA transport framer, the REAL reassembler, the REAL `parseGesture`, the REAL
     * 100 ms L/R dedup and the REAL `onGesture` emit -- so everything from the wire format up
     * through the TypeScript OS's navigation and rendering is genuinely exercised.
     *
     * What it CANNOT prove is the half below it: that a finger on the temple pad actually
     * produces this frame and that it reaches us over BLE. That is the open FUT-249 / FUT-233
     * question and only a real touch answers it. Per cardinal rule 1, a green run here is NOT
     * on-glass proof of input -- which is exactly why every injection logs "SIMULATED".
     *
     * Deliberately routed through the framer rather than calling `onGesture` directly: a
     * shortcut that skipped the decode would keep passing after a protocol change broke it.
     */
    /**
     * Feed a synthetic inbound EvenHub payload through the REAL dispatch path.
     *
     * Exists because the only genuine sources of a list selection are a human's finger on a
     * temple pad and the R1 ring, neither of which is available to an unattended run. Injecting a
     * CAPTURED event vector exercises everything downstream of the radio -- the SDK's decoder,
     * the screen stack, the page slot, and the resulting page actually rendering on the lens.
     *
     * ⚠️ What this proves and what it does not: the INPUT is synthetic, so this is not evidence
     * that the firmware reports taps (that is proven separately, from real captures). It IS
     * evidence about everything the injected event then drives, because the render goes to real
     * hardware over the real link. The log line says so explicitly, so a future reader scrolling
     * past cannot mistake it for a hardware capture.
     */
    /**
     * Change one already-declared text container's content IN PLACE (EvenHub Cmd 5), without
     * rebuilding the page.
     *
     * The distinction is not about saving bytes: a REBUILD re-declares the list and sends its
     * focus back to row 0, so any live value (clock, timer, battery) is only possible this way.
     */
    fun updateTextContainer(containerId: Int, text: String) = post {
        if (!pairReadyLocked()) {
            log("updateText ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        withSessionLocked {
            sendEvenHubLocked(
                G2EvenHub.updateText(containerId, text, counters.nextMagic()), G2Target.RIGHT
            )
            log("updateText: container=$containerId '$text' (in place, no rebuild)")
        }
    }

    /**
     * Start or stop the glasses' head-motion (IMU) stream -- EvenHub Cmd 19, the ONLY message
     * that opens the sensor hub. Samples come back as SysEvents (OsEventTypeList.IMU_DATA_REPORT
     * = 8) carrying IMU_Report_Data{x,y,z}, which the existing inbound decoder already handles;
     * this is purely the missing OUTBOUND half.
     *
     * ⚠️ RIGHT LENS ONLY, and that is not the usual "EvenHub goes right" habit -- it is a
     * firmware refusal. The on-glass sensor probe read the lens role register as 3 (RIGHT), and
     * the firmware's own string table refuses role 2 with "IMU open role type is left, cannot
     * open". Broadcasting to BOTH would spend a guaranteed rejection on the left lens and, worse,
     * make a partial success look like a whole one -- see docs/gui-re/FINDINGS-per-lens-truth.md
     * on how easily a per-lens answer is mistaken for the pair's.
     *
     * `pace` is an ImuReportPace CODE (100..1000 step 100), not literal Hz. It is ignored by the
     * encoder when disabling.
     *
     * ⛔ SCOPE: this sends ONE EvenHub command and nothing else. It touches no firmware address
     * and never goes near sid 0x80 (dev_config).
     */
    fun setImuStream(on: Boolean, pace: Int = 100) = post {
        if (!pairReadyLocked()) {
            log("setImuStream ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        // Surface every inbound frame while the stream is on. Without this a run that produces no
        // decoded samples cannot be told apart from a run where the glasses sent nothing at all,
        // which is the single most expensive ambiguity this experiment can have.
        if (on) dumpInbound = true
        withSessionLocked {
            sendEvenHubLocked(
                G2EvenHub.imuControl(on, pace, counters.nextMagic()), G2Target.RIGHT
            )
            log("setImuStream: ${if (on) "OPEN pace=$pace" else "CLOSE"} -> right (EvenHub Cmd 19, sub-field 22)")
        }
    }

    /**
     * OPEN OR CLOSE THE MICROPHONE.
     *
     * ══ WHICH MESSAGE ACTUALLY OPENS IT, AND HOW WE KNOW ═════════════════════════════════
     * `[proven]` from our own glog archive, not inferred. The audio characteristic has notified
     * this phone **3,281 times, every single one 205 bytes and every single one side=L**, in 18
     * bursts across four days. Nine of those bursts start 0.2-0.5 s after an
     * `aiSwirl: CTRL ENTER` line and stop within a second of `CTRL EXIT`. In the 22:55:47 burst
     * the first packet lands at .845 -- **250 ms after CTRL ENTER and 165 ms BEFORE the ASK** --
     * so it is the CTRL, not the ASK, that opens the mic.
     *
     * That single fact rearranges the whole design:
     *   • the mic needs **no EvenHub container**, no Cmd 15, and no CFW patch;
     *   • it is ONE message on the even_ai service (0x07), which we already send;
     *   • ⭐ and we never have to send an ASK, so **nothing is ever submitted to Even's cloud**.
     *     `aiSwirl` sends `ask(" ")` purely to keep an animation alive. Dictation must not.
     *
     * ⚠️ EXIT IS NOT OPTIONAL. Without it the DMIC pair stays powered and the glasses keep
     * recording. Every caller pairs them; [micStop] is also what the safety timeout calls.
     *
     * ⚠️ Some bursts in the archive have NO swirl before them (2026-08-19 02:17, 08-20 18:29,
     * 18:35). Those are almost certainly Even's own on-glass triggers -- the GX8002 wake word,
     * or a temple long-press into the stock voice flow -- which means **the glasses can open
     * their own microphone without the phone asking**. Worth knowing before assuming an idle
     * mic is a closed one.
     *
     * @param alsoCmd15 additionally send EvenHub Cmd 15 / field 18. Off by default: that path
     *   is the SECONDARY experiment (see G2EvenHub.audioControl) and mixing it into the proven
     *   route would make a success unattributable.
     */
    fun setMicStream(on: Boolean, alsoCmd15: Boolean = false) = post {
        if (!pairReadyLocked()) {
            log("setMicStream ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        withSessionLocked {
            if (on) {
                micStats.resetSession()
                // Claim the window BEFORE the open goes out, or our own first burst races the
                // flag and gets reported as the glasses opening their own microphone.
                micStats.requestedByUs = true
                sendEvenAILocked(
                    G2EvenAI.ctrl(G2EvenAI.STATUS_ENTER, counters.nextMagic()), G2Target.BOTH
                )
                log("setMicStream: OPEN -- evenAI CTRL ENTER -> both (NO ask; nothing goes to Even's cloud)")
            } else {
                micStats.requestedByUs = false
                sendEvenAILocked(
                    G2EvenAI.ctrl(G2EvenAI.STATUS_EXIT, counters.nextMagic()), G2Target.BOTH
                )
                log("setMicStream: CLOSE -- evenAI CTRL EXIT -> both")
            }
            if (alsoCmd15) {
                sendEvenHubLocked(
                    G2EvenHub.audioControl(on, counters.nextMagic()), G2Target.RIGHT
                )
                log("setMicStream: ALSO sent EvenHub Cmd 15/field 18 -> right (secondary route under test)")
            }
        }
    }

    fun injectInboundEvenHub(base64: String) = post {
        val data = decodeBase64(base64)
        if (data == null || data.isEmpty()) {
            log("injectInbound ignored -- bad/empty base64")
            return@post
        }
        log("INJECTED INBOUND EvenHub (${data.size}B) -- synthetic frame, NOT from the hardware")
        dispatchInboundLocked(G2ServiceID.EVEN_HUB, data, G2Side.RIGHT)
    }

    fun simulateGesture(gesture: String) = post {
        val eventType = when (gesture) {
            "tap" -> 0
            "swipe_up" -> 1
            "swipe_down" -> 2
            "double_tap" -> 3
            else -> {
                log("simulateGesture: unknown glasses gesture '$gesture' " +
                    "(tap | double_tap | swipe_up | swipe_down)")
                return@post
            }
        }
        // Sys_ItemEvent{ f1=eventType, f2=eventSource }. Source 1 is a temple pad -- the only
        // value real telemetry has ever carried.
        val sys = G2ProtobufWriter()
        sys.writeInt32Field(1, eventType)
        sys.writeInt32Field(2, 1)
        val devEvent = G2ProtobufWriter()
        devEvent.writeMessageField(3, sys.data) // SendDeviceEvent.f3 = SysEvent
        val msg = G2ProtobufWriter()
        msg.writeInt32Field(1, 2) // rspOsNotifyEvent
        msg.writeInt32Field(2, counters.nextMagic())
        msg.writeMessageField(13, devEvent.data)

        log("SIMULATED GESTURE '$gesture' -- synthetic frame, NOT from the hardware")
        // A fresh reassembler, so an injection can never splice itself into a real message the
        // right lens happens to be part-way through.
        val rx = G2RxReassembler()
        for (pkt in G2Transport.buildPackets(0, G2ServiceID.EVEN_HUB, msg.data, reserveFlag = true)) {
            rx.feed(pkt)?.let { (svc, payload) -> dispatchInboundLocked(svc, payload, G2Side.RIGHT) }
        }
    }

    /**
     * A decoded gesture arrived. Dedup L/R duplicates of the SAME gesture within 100ms (both
     * lenses can deliver the same event -- FUT-159), then emit.
     */
    private fun handleGestureLocked(gesture: String, side: G2Side, source: Int?) {
        val now = System.currentTimeMillis()
        if (gesture == lastGestureName && now - lastGestureAt < 100L) return
        lastGestureName = gesture
        lastGestureAt = now
        // `source` is logged verbatim (including "none") because its ABSENCE is the finding:
        // FUT-233 wants to know whether a ring event ever reaches this path.
        log("GESTURE: $gesture (side=${side.raw}, source=${source?.toString() ?: "none"})")
        onGesture?.invoke(gesture, side.raw, source)
    }

    /**
     * A device-info response arrived. Both lenses answer the same request.
     *
     * ⛔ THIS USED TO DEDUP GLOBALLY — `if (now - lastDeviceInfoAt < 300L) return` — on the
     * reasoning that "the aggregate battery/version is identical from either". That was true
     * when the reply carried only battery and firmware version. It stopped being true the day
     * we started riding `⟨LOADER … lens= dash= apps= run= src= …⟩` in the SAME reply, because
     * every one of those fields is PER-LENS and the two lenses genuinely diverge.
     *
     * The cost was not theoretical. The left lens answered every single time and the phone
     * threw it away inside 300 ms, so the left lens was unobservable from this machine, so
     * TWO per-lens bugs (left eye receiving no data; a `°` drawn in one eye only) could only
     * ever be found by Yoni putting the glasses on his face. Nothing upstream was broken —
     * a value arrived correctly and something discarded it before anyone could look, which is
     * the same shape as the `!s->have` bug it took a night to find.
     *
     * So: dedup PER SIDE. A lens that answers twice in 300 ms is still a duplicate; the other
     * lens answering is NOT. `onDeviceInfo` still fires once per burst (the aggregate really
     * is side-independent) but the LOG — where every `⟨LOADER⟩` readback is read from — now
     * carries both.
     */
    private fun handleDeviceInfoLocked(info: G2Setting.DeviceInfo, side: G2Side) {
        val now = System.currentTimeMillis()
        val key = side.raw
        val prev = lastDeviceInfoAtBySide[key] ?: 0L
        if (now - prev < 300L) return
        val firstThisBurst = lastDeviceInfoAtBySide.values.none { now - it < 300L }
        lastDeviceInfoAtBySide[key] = now
        log(
            "DEVICE INFO (side=$key): batt=${info.battery ?: "?"} " +
                "charging=${info.charging ?: "?"} " +
                "L=${info.leftVersion ?: "?"} R=${info.rightVersion ?: "?"}"
        )
        // The aggregate (battery/version) IS side-independent, so only surface it once per
        // burst -- but never let that suppress the per-side log line above.
        if (firstThisBurst) {
            onDeviceInfo?.invoke(info.leftVersion, info.rightVersion, info.battery, info.charging)
        }
    }

    // MARK: - EvenHub senders

    /** Send an EvenHub (0xE0) payload as paced packets to the target side(s). */
    private fun sendEvenHubLocked(payload: ByteArray, target: G2Target) {
        enqueueLocked(counters.packets(G2ServiceID.EVEN_HUB, payload, reserveFlag = true), target)
    }

    private fun sendDevSettingsLocked(payload: ByteArray, target: G2Target) {
        enqueueLocked(counters.packets(G2ServiceID.DEVICE_SETTINGS, payload), target)
    }

    private fun sendGestureCtrlLocked(payload: ByteArray, target: G2Target) {
        enqueueLocked(counters.packets(G2ServiceID.GESTURE_CTRL, payload), target)
    }

    private fun sendOnboardingLocked(payload: ByteArray, target: G2Target) {
        enqueueLocked(counters.packets(G2ServiceID.ONBOARDING, payload), target)
    }

    private fun sendEvenAILocked(payload: ByteArray, target: G2Target) {
        enqueueLocked(counters.packets(G2ServiceID.EVEN_AI, payload, reserveFlag = true), target)
    }

    private fun sendG2SettingLocked(payload: ByteArray, target: G2Target) {
        enqueueLocked(counters.packets(G2ServiceID.G2_SETTING, payload, reserveFlag = true), target)
    }

    // MARK: - Session (auth handshake + heartbeat)

    /**
     * Auth handshake: authL->left, authR->right, pipeRoleChange->right, timeSync->both, then
     * skip-onboarding, gesture_ctrl init and head-up-off, spaced 200ms (P0 spec). Fires [done]
     * on the queue after the final step.
     */
    private fun runAuthLocked(done: () -> Unit) {
        // RE-ENTRY GUARD. `sessionAuthed` only flips at the END of a ~1.4s chain, so two callers
        // arriving inside that window both saw false and both started a full handshake -- every
        // auth command went out twice, during the most timing-sensitive phase of the session,
        // and the two completions raced `pageCreated` (observed on-glass 2026-08-07: two
        // "starting handshake" lines 7ms apart, then "created text page" immediately followed by
        // "rebuilt text page"). Queue the later callers onto the handshake already running.
        if (authInProgress) {
            authWaiters.add(done)
            log("runAuth: already in progress -- queued (${authWaiters.size} waiting)")
            return
        }
        authInProgress = true
        authWaiters.add(done)
        log("runAuth: starting handshake")
        sendDevSettingsLocked(G2DevSettings.authCmd(counters.nextMagic()), G2Target.LEFT)
        schedule(200) {
            sendDevSettingsLocked(G2DevSettings.authCmd(counters.nextMagic()), G2Target.RIGHT)
            schedule(200) {
                sendDevSettingsLocked(
                    G2DevSettings.pipeRoleChange(counters.nextMagic()), G2Target.RIGHT
                )
                schedule(200) {
                    sendDevSettingsLocked(
                        G2DevSettings.timeSync(counters.nextMagic()), G2Target.BOTH
                    )
                    schedule(200) {
                        // Mark onboarding FINISHED -- until we do, the firmware runs its own
                        // on-glass onboarding UI on the touchpad and only forwards double-tap.
                        // This is the gate for single-tap + swipe reaching the host. FUT-160.
                        sendOnboardingLocked(
                            G2Onboarding.skip(counters.nextMagic()), G2Target.BOTH
                        )
                        log("runAuth: sent skip-onboarding -> both")
                        schedule(200) {
                            // Register with the gesture controller (lifecycle handshake).
                            sendGestureCtrlLocked(
                                G2GestureCtrl.initCmd(counters.nextMagic()), G2Target.BOTH
                            )
                            log("runAuth: sent gesture_ctrl init -> both")
                            schedule(200) {
                                // Disable the stock head-up DASHBOARD so it can't pop over our OS.
                                sendG2SettingLocked(
                                    G2Setting.setHeadUpSwitch(counters.nextMagic(), false),
                                    G2Target.BOTH
                                )
                                log("runAuth: disabled stock head-up dashboard -> both")
                                schedule(200) {
                                    sessionAuthed = true
                                    authInProgress = false
                                    // Copy before running: a waiter may itself call back into
                                    // the session and mutate this list mid-iteration.
                                    val waiters = ArrayList(authWaiters)
                                    authWaiters.clear()
                                    log("runAuth: handshake complete (session authed)" +
                                        ", ${waiters.size} waiter(s)")
                                    for (w in waiters) w()
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /** Run [body] once the session is authed, running the handshake first if needed. */
    private fun withSessionLocked(startHeartbeat: Boolean = true, body: () -> Unit) {
        if (sessionAuthed) {
            body()
        } else {
            runAuthLocked {
                if (startHeartbeat) startHeartbeatsLocked()
                body()
            }
        }
    }

    /**
     * 5s EvenHub heartbeat to BOTH arms (FUT-159: the plugin task dies after ~10s of no
     * traffic). Gated on sessionAuthed + pairReady.
     */
    private fun startHeartbeatsLocked() {
        if (heartbeatRunning) return
        heartbeatRunning = true
        heartbeatTickLocked()
    }

    private fun heartbeatTickLocked() {
        // A flash owns the link exclusively; EvenHub traffic during an OTA transfer competes
        // with firmware blocks for the same radio and is exactly what the flasher's own 12s
        // CTRL keep-alive replaces.
        if (flasher.active) {
            schedule(5000) { heartbeatTickLocked() }
            return
        }
        if (!heartbeatRunning || !sessionAuthed || !pairReadyLocked()) {
            heartbeatRunning = false
            return
        }
        sendEvenHubLocked(G2EvenHub.heartbeat(counters.nextMagic()), G2Target.BOTH)
        // FUT-253: piggyback a live RSSI poll on the heartbeat. The reading lands async in
        // onReadRemoteRssi -> onRssi. Only flows while the session is up.
        for (lens in lenses.values) {
            if (lens.connected) lens.gatt?.readRemoteRssi()
        }
        schedule(5000) { heartbeatTickLocked() }
    }

    /** Reset the EvenHub session (called when a lens drops -- the session is broken). */
    private fun resetSessionLocked() {
        if (sessionAuthed || heartbeatRunning) log("session reset (a lens dropped)")
        sessionAuthed = false
        heartbeatRunning = false
        // A drop mid-handshake must not leave the guard latched, or every later withSessionLocked
        // caller would queue a waiter onto a chain that is never going to complete.
        authInProgress = false
        authWaiters.clear()
        // (page/animation/image-transfer teardown moved out with the render machinery, 2026-08-22.)
    }

    /** Public: tear down the EvenHub session state (stops heartbeats). */
    fun stopSession() = post { resetSessionLocked() }

    /**
     * HUD BRIGHTNESS (sid 0x09). 0-100, nonlinear; [autoAdjust] hands control to the ambient-light
     * sensor. Sent to BOTH lenses -- brightness is a per-lens driver setting, and sending it to one
     * side leaves the pair visibly mismatched.
     *
     * Doubles as an INSTRUMENT control: a dimmer HUD is markedly easier for the phone camera to
     * focus on, so lowering it improves every visual proof this project makes. Turn [autoAdjust]
     * OFF when measuring, or the ALS moves the level under you mid-observation.
     *
     * MEASURED THROUGH THE RIG on a 4-row list -- **use level 15**:
     *   100 = the selected row blows out to an unreadable white blob
     *    20 = readable
     *    15 = ALL rows crisp  <-- the working default
     *    10 = selected row fine, lower rows still dim
     *     5 = selected row crisp, but the UNSELECTED rows go nearly invisible
     * Judge the WHOLE screen, not the highlighted row: 5 was picked first on the strength of the
     * selected row alone and was wrong.
     */
    fun setBrightness(level: Int, autoAdjust: Boolean = false) = post {
        if (!pairReadyLocked()) {
            log("setBrightness ignored -- pair not ready")
            return@post
        }
        val clamped = level.coerceIn(0, 100)
        withSessionLocked {
            sendG2SettingLocked(
                G2Setting.setBrightness(counters.nextMagic(), clamped, autoAdjust), G2Target.BOTH
            )
            log("setBrightness -> level=$clamped autoAdjust=$autoAdjust -> both")
        }
    }

    /** Read the settings snapshot back (battery, firmware, brightness, head-up, wear, x/y coords). */
    fun querySettings(brightnessOnly: Boolean = false) = post {
        if (!pairReadyLocked()) {
            log("querySettings ignored -- pair not ready")
            return@post
        }
        dumpInbound = true // the reply shape is not decoded yet -- see the inbound-decoder task
        withSessionLocked {
            val type = if (brightnessOnly) G2Setting.REQ_BRIGHTNESS_INFO else G2Setting.REQ_BASIC_SETTING
            sendG2SettingLocked(
                G2Setting.querySettings(counters.nextMagic(), type), G2Target.RIGHT
            )
            log("querySettings(type=$type) -> right; watch for the inbound snapshot")
        }
    }

    /** Suppress the audio cue on container pushes / notifications. */
    fun setSilentMode(enabled: Boolean) = post { sendSettingLocked("setSilentMode(%s)".format(enabled)) { m -> G2Setting.setSilentMode(m, enabled) } }

    /** Nose-bridge proximity sensor. Transitions emit an async sid-0x0d state-change event. */
    fun setWearDetection(enabled: Boolean) = post { sendSettingLocked("setWearDetection(%s)".format(enabled)) { m -> G2Setting.setWearDetection(m, enabled) } }

    /**
     * Nudge the rendered image. Applied to EVERY frame, per-arm, range ~ +/-20 px. This is the
     * only way to improve the camera rig's FRAMING without a human re-aiming the phone.
     */
    fun setLensOffset(x: Int?, y: Int?) = post {
        if (x != null) sendSettingLocked("setLensX($x)") { m -> G2Setting.setLensX(m, x) }
        if (y != null) sendSettingLocked("setLensY($y)") { m -> G2Setting.setLensY(m, y) }
    }

    /**
     * PANIC RESET -- reboot both lenses when nothing else can reach them.
     *
     * Sent to BOTH arms, because a starved heap is a per-lens condition and recovering one eye
     * is not recovering the glasses. See [G2Setting.panicReset] for what this is and why the
     * ordinary "push a reboot payload" route cannot work.
     *
     * ⚠️ This deliberately runs through the SAME `sendSettingLocked` path as brightness and wear
     * detection. It is not special-cased, does not bypass the pair-ready check, and holds no
     * privileged state: the entire mechanism lives in the firmware, and this is a normal
     * settings write that happens to carry a marker the firmware acts on.
     *
     * [token] defaults to the real marker. Passing a different 12-byte string is the NEGATIVE
     * CONTROL: it takes an identical path and must do nothing.
     */
    fun panicReset(token: String = G2Setting.PANIC_TOKEN) = post {
        sendSettingLocked("panicReset(token=%s)".format(token)) { m -> G2Setting.panicReset(m, token) }
    }

    private fun sendSettingLocked(label: String, build: (Int) -> ByteArray) {
        if (!pairReadyLocked()) {
            log("$label ignored -- pair not ready")
            return
        }
        withSessionLocked {
            sendG2SettingLocked(build(counters.nextMagic()), G2Target.BOTH)
            log("$label -> both")
        }
    }

    // MARK: - FUT-216 payload delivery

    /**
     * Push a base64-encoded payload to a custom service id (e.g. 0x90 CFW loader). The payload
     * bytes are framed as one service message and reassembled firmware-side.
     */
    fun pushToService(serviceId: Int, base64: String) = post {
        if (!pairReadyLocked()) {
            log("pushToService ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        val data = decodeBase64(base64)
        if (data == null || data.isEmpty()) {
            log("pushToService ignored -- bad/empty base64")
            return@post
        }
        enqueueLocked(counters.packets(serviceId and 0xFF, data), G2Target.BOTH)
        log("pushToService 0x${(serviceId and 0xFF).toString(16)} -> both (${data.size} B)")
    }

    private fun decodeBase64(s: String): ByteArray? = try {
        android.util.Base64.decode(s, android.util.Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
        null
    }

    /** NO_WRAP: a wrapped base64 string arrives in JS with newlines and fails to decode. */
    private fun encodeBase64(data: ByteArray): String =
        android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)

    // MARK: - Device info

    /**
     * Public: request real device info (battery %, charging, per-lens firmware version). The
     * answer arrives asynchronously via [onDeviceInfo]. Sent to BOTH lenses so whichever
     * answers is captured; the reply is deduped.
     */
    fun requestDeviceInfo() = post {
        if (!pairReadyLocked()) {
            log("requestDeviceInfo ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        sendG2SettingLocked(G2Setting.requestDeviceInfo(counters.nextMagic()), G2Target.BOTH)
        log("requestDeviceInfo -> both (service 0x09)")
    }

    /**
     * FUT-269 dual-lens telemetry: request device info from ONE lens only. This is the phone-side
     * lever for defeating the deduped "whichever lens answered" — addressing a single lens means
     * only it can reply, so its side-tagged answer (and the payload's own G2FW_LENS_SIDE stamp) is
     * unambiguous. ⚠️ Whether the LEFT lens actually answers a direct service-0x09 query is
     * UNVERIFIED on-glass: FUT-159 records the left arm as SILENT on async protocol events. A
     * left reply appearing after this call is itself the on-glass proof the path works.
     */
    fun requestDeviceInfoSide(side: G2Side) = post {
        if (!pairReadyLocked()) {
            log("requestDeviceInfoSide ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        val target = when (side) {
            G2Side.LEFT -> G2Target.LEFT
            G2Side.RIGHT -> G2Target.RIGHT
            else -> { log("requestDeviceInfoSide: unknown side"); return@post }
        }
        sendG2SettingLocked(G2Setting.requestDeviceInfo(counters.nextMagic()), target)
        log("requestDeviceInfoSide -> ${side.raw} (service 0x09)")
    }

    // MARK: - Flash channel probe (FUT-167 Stage 1 -- zero writes)

    /**
     * A ZERO-WRITE flash-channel probe. Confirms the OTA firmware-flash characteristics are
     * discoverable on BOTH lenses -- no writes, no brick risk. Reads already-discovered GATT
     * state only; sends nothing.
     */
    fun flashDryRun() = post {
        val want = listOf(
            "CTRL.write" to CHAR_WRITE,
            "CTRL.notify" to CHAR_NOTIFY,
            "DATA.write" to FLASH_DATA_WRITE,
            "DATA.notify" to FLASH_DATA_NOTIFY
        )

        fun probe(side: G2Side): Pair<Boolean, String> {
            val lens = lenses[side]
            if (lens == null || !lens.connected) return Pair(false, "${side.raw}: not connected")
            val found = HashSet<UUID>()
            for (svc in lens.gatt?.services.orEmpty()) {
                for (ch in svc.characteristics.orEmpty()) found.add(ch.uuid)
            }
            val missing = want.filter { !found.contains(it.second) }.map { it.first }
            return if (missing.isEmpty()) {
                Pair(true, "${side.raw}: all 4 flash channels present OK")
            } else {
                Pair(false, "${side.raw}: MISSING ${missing.joinToString(", ")}")
            }
        }

        val l = probe(G2Side.LEFT)
        val r = probe(G2Side.RIGHT)
        val detail = "FLASH DRY-RUN (zero-write, no data sent)\n${l.second}\n${r.second}"
        log("flashDryRun -- ${l.second}; ${r.second}")
        onFlashProbe?.invoke(l.first, r.first, detail)
    }

    /**
     * FUT-167 Stage 2 / FUT-260: the real CFW OTA flash. Downloads [urlStr], verifies
     * [expectedSha256], runs the MRAM brick-guard + golden-vector self-test, then either stops
     * ([dryRun] = true, no writes at all) or flashes both lenses. Progress via onFlashProgress.
     *
     * Resolves the OTA characteristics HERE, on the serial queue, and hands the flasher
     * finished targets — it must never read driver state from its own thread.
     *
     * Order note: the DATA-notify subscription is enabled first and given time to bind before
     * the transfer starts, because the very first ack would otherwise arrive on an unsubscribed
     * characteristic and be lost — which presents as a begin-ack timeout and looks exactly like
     * a dead OTA channel.
     */
    fun startCfwFlash(urlStr: String, expectedSha256: String, dryRun: Boolean) = post {
        if (flasher.active) {
            log("startCfwFlash ignored -- a flash is already running")
            return@post
        }

        val targets = ArrayList<G2Flasher.Target>()
        val missing = ArrayList<String>()
        for (side in listOf(G2Side.LEFT, G2Side.RIGHT)) {
            val lens = lenses[side]
            val gatt = lens?.gatt
            if (lens == null || !lens.connected || gatt == null) {
                missing.add("${side.raw}: not connected"); continue
            }
            val dataWrite = findCharLocked(gatt, FLASH_DATA_WRITE)
            val dataNotify = findCharLocked(gatt, FLASH_DATA_NOTIFY)
            val ctrlWrite = lens.writeChar // CTRL write == CHAR_WRITE (…E5401)
            if (dataWrite == null || dataNotify == null || ctrlWrite == null) {
                missing.add(
                    "${side.raw}: missing " + listOfNotNull(
                        if (dataWrite == null) "DATA.write" else null,
                        if (dataNotify == null) "DATA.notify" else null,
                        if (ctrlWrite == null) "CTRL.write" else null
                    ).joinToString("/")
                )
                continue
            }
            targets.add(G2Flasher.Target(side.raw, gatt, dataWrite, dataNotify, ctrlWrite))
            // Subscribe to the OTA ack channel before any transfer begins.
            subscribeLocked(lens, dataNotify)
        }

        if (missing.isNotEmpty()) {
            val detail = "OTA channels unavailable -- ${missing.joinToString("; ")}"
            log("startCfwFlash refused: $detail")
            onFlashProgress?.invoke(detail, 0.0, true, false)
            return@post
        }

        // Let the CCCD writes land before the first ack can arrive (iOS sleeps 2.5s here).
        log("startCfwFlash: ${targets.size} lens(es) ready, dryRun=$dryRun -- settling subscriptions")
        schedule(2500) {
            flasher.start(targets, urlStr, expectedSha256, dryRun) {
                // Back on the flasher's thread; hop home before touching driver state.
                post {
                    log("flash finished -- restoring session")
                    if (pairReadyLocked()) startHeartbeatsLocked()
                }
            }
        }
    }

    /** Find a characteristic by UUID anywhere in a link's discovered services. */
    private fun findCharLocked(gatt: BluetoothGatt, uuid: UUID): BluetoothGattCharacteristic? {
        for (svc in gatt.services.orEmpty()) {
            for (ch in svc.characteristics.orEmpty()) if (ch.uuid == uuid) return ch
        }
        return null
    }

    // MARK: - Small helpers

    /**
     * Emit characteristic UUIDs UPPERCASE. Android's `UUID.toString()` is lowercase and iOS's
     * `CBUUID.uuidString` is uppercase; JS receives these as opaque strings and at least one
     * screen shows them verbatim, so matching iOS keeps the shared UI identical on both
     * platforms rather than subtly different.
     */
    private fun uuidString(uuid: UUID): String = uuid.toString().uppercase()

    /**
     * Human-readable GATT status. These codes are the Android analogue of the CBError codes
     * FUT-253 wants in the log, and they are the fastest triage signal there is:
     *  8   = link supervision timeout -- the wearer walked out of range
     *  19  = the peripheral terminated the connection (firmware reboot / power-off)
     *  22  = the local host terminated it (usually our own disconnect())
     *  133 = the catch-all GATT_ERROR, almost always a connect timeout or a leaked GATT client
     */
    private fun describeGattStatus(status: Int): String = when (status) {
        BluetoothGatt.GATT_SUCCESS -> "success"
        1 -> "invalid handle"
        5 -> "insufficient authentication"
        8 -> "connection timeout (supervision timeout)"
        19 -> "remote terminated the connection"
        22 -> "local host terminated the connection"
        34 -> "connection LMP timeout"
        62 -> "connection failed to establish"
        133 -> "GATT_ERROR (133) -- connect timeout or exhausted GATT clients"
        143 -> "unsupported connection parameters"
        else -> "gatt status $status"
    }
}

/** The domain string reported alongside a numeric GATT status (iOS reports an NSError domain). */
private const val GATT_DOMAIN = "android.bluetooth.gatt"

// G2Side, G2Target, G2Manufacturer and G2Discovery now live in G2Types.kt (same package).
