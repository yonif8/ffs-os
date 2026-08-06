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
 * R1Central.kt -- Android twin of `ios/R1Central.swift`.
 *
 * `android.bluetooth` central for the Even Realities R1 smart ring -- the FFS SDK's INPUT
 * device (FUT-233).
 *
 * ── Why this is a separate central from G2Central ──────────────────────────────────────────
 * The ring is its own BLE peripheral on its own service (BAE80001-...), not a third channel on
 * the glasses link. G2Central is hard-wired to a PAIR of G2 lenses (enum G2Side L/R, protocol
 * notify on the right lens only); bending it around a single-peripheral device with a
 * different service would corrupt both.
 *
 * ── Route decision (LOCKED 2026-07-28, FUT-233) ────────────────────────────────────────────
 * The ring talks to the PHONE, and the phone is the input hub. The alternative -- letting the
 * ring talk to the glasses and forwarding gestures up through the firmware -- was rejected: it
 * needs CFW (gesture forwarding is compiled OUT of our loader build), and it is structurally
 * source-blind, because the firmware's `eventSource` field exists only on Sys events, so a tap
 * landing on a text or list container can never be attributed to ring vs temple.
 *
 * Crucially the two routes are NOT mutually exclusive at the transport level:
 * [connectToGlasses] below is the phone COMMANDING the ring to also hold a link to the
 * glasses. We consume the phone link; that other link is something we can drive, not something
 * we depend on.
 *
 * ── Provenance ─────────────────────────────────────────────────────────────────────────────
 * Protocol constants, the init sequence, the gesture encoding and the advStart command are
 * ported from MentraOS `R1.swift` (MIT -- copy permitted with attribution; notice retained),
 * itself reverse-engineered from BTSnoop captures. The structure, threading, logging and
 * callback surface are original FFS code and follow G2Central.
 *
 * ⚠️ UNRESOLVED, and the first thing to test on hardware: sources disagree on whether the phone
 * link carries ALL FIVE gestures. MentraOS parses five; openCFW's BTSnoop capture saw only hold
 * + double-tap reach the phone, with single-tap and swipes going ring->glasses directly. Hence
 * [onRaw] -- every frame is surfaced verbatim so the live test answers this by observation
 * rather than by trusting either source. If only a subset arrives: HARD STOP, reassess.
 *
 * ── Android-specific notes ─────────────────────────────────────────────────────────────────
 * Same three platform hazards as G2Central, and one that bites harder here:
 *  - Notifications need an explicit CCCD (0x2902) write, and we subscribe to EVERY notifying
 *    characteristic the ring exposes. That is potentially a dozen descriptor writes, and
 *    Android runs exactly ONE GATT operation at a time per link -- issue them in a loop and all
 *    but the first are discarded, which would look exactly like "the ring sent nothing".
 *    Hence [pendingOps].
 *  - No MTU request. Ring frames are 1-3 bytes, so the default 23-byte MTU is ample; asking
 *    for more would add a round trip and a failure mode for no gain. (Contrast G2Central,
 *    where the request is mandatory.)
 */
@SuppressLint("MissingPermission")
class R1Central(
    private val context: Context,
    private val activityProvider: () -> Activity?
) {

    // MARK: - Protocol constants (ported from MentraOS R1.swift, MIT)

    companion object {
        /** The ring's custom service. */
        val SERVICE: UUID = UUID.fromString("bae80001-4f05-4503-8e65-3af1f7329d1f")

        /** Channel 1. */
        val WRITE_1: UUID = UUID.fromString("bae80010-4f05-4503-8e65-3af1f7329d1f")
        val NOTIFY_1: UUID = UUID.fromString("bae80011-4f05-4503-8e65-3af1f7329d1f")
        /** Channel 2 -- the channel gestures have been observed on. */
        val WRITE_2: UUID = UUID.fromString("bae80012-4f05-4503-8e65-3af1f7329d1f")
        val NOTIFY_2: UUID = UUID.fromString("bae80013-4f05-4503-8e65-3af1f7329d1f")

        /** Standard BLE battery service -- the ring MAY expose it. */
        val BATTERY_CHAR: UUID = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb")

        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /**
         * The ring does not reliably advertise its custom service, so discovery is by name
         * (MentraOS scans with no service filter for the same reason).
         */
        val NAME_FILTERS = listOf("EVEN R1", "BCL60")

        /** Init handshake: 0xFC then 0x11, 200ms apart, written to BOTH write chars. */
        val CONFIG_FC = byteArrayOf(0xFC.toByte())
        val CONFIG_11 = byteArrayOf(0x11)
        const val INIT_GAP_MS = 200L

        /** BleRing1 advStart (cmd=system 0, module=system 0, subCmd=advStart 9). */
        const val CMD_SYSTEM: Byte = 0x00
        const val MODULE_SYSTEM: Byte = 0x00
        const val SUBCMD_ADV_START: Byte = 0x09

        /** First byte of a gesture frame: [0xFF][type][param]. */
        const val GESTURE_MARKER = 0xFF

        const val SCAN_TIMEOUT_MS = 15_000L

        /**
         * Battery re-read interval. NOTE: this matches MentraOS's ACTUAL driver (a 30s battery
         * read). Our own FUT-233 spec claimed "0x11 keepalive every 5s" -- that is not what the
         * source does; corrected here and on the issue 2026-07-28.
         */
        const val HEARTBEAT_MS = 30_000L

        /**
         * How long discovery must go quiet before the init handshake runs. Discovery arrives
         * per-service, so "all subscriptions confirmed" cannot be known up front -- and a ring
         * exposing no notify characteristic at all must not hang here forever.
         */
        const val SETTLE_MS = 1200L

        /** Backoff, cap and completion timeout for the serialized GATT op queue. */
        const val OP_RETRY_MS = 20L
        const val OP_MAX_RETRIES = 50
        const val OP_TIMEOUT_MS = 3000L

        private const val PREFS = "ffs_ble"
        private const val KEY_MAC = "ffs.r1.mac"
        private const val TAG = "ffs-ble"
    }

    // MARK: - Callbacks (wired by the Expo module)

    /** (message) -- every log line, already timestamped. */
    var onLog: ((String) -> Unit)? = null
    /** (stateDescription) -- adapter transitions, in the iOS CBManagerState vocabulary. */
    var onStateChange: ((String) -> Unit)? = null
    /** (name, rssi) -- a ring seen in a scan. */
    var onDeviceFound: ((String, Int) -> Unit)? = null
    /** (name) -- the ring finished connecting AND completed its init handshake. */
    var onConnected: ((String) -> Unit)? = null
    /** (gesture, rawHex) -- a decoded gesture, with the frame that produced it. */
    var onGesture: ((String, String) -> Unit)? = null
    /**
     * (charSuffix, hex) -- EVERY inbound frame, decoded or not. This is the evidence channel
     * for the live test; do not filter it.
     */
    var onRaw: ((String, String) -> Unit)? = null
    /** (percent) */
    var onBattery: ((Int) -> Unit)? = null
    /** (reason?) */
    var onDisconnected: ((String?) -> Unit)? = null

    // MARK: - State

    private val thread = HandlerThread("FfsR1Queue", Process.THREAD_PRIORITY_FOREGROUND)
        .apply { start() }
    private val handler = Handler(thread.looper)

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter? = bluetoothManager?.adapter
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private var gatt: BluetoothGatt? = null
    private var ringName: String? = null

    private var writeChar1: BluetoothGattCharacteristic? = null
    private var writeChar2: BluetoothGattCharacteristic? = null
    private var batteryChar: BluetoothGattCharacteristic? = null

    /**
     * How many notify chars have confirmed subscription. The init handshake must not run until
     * they are up, or the ring's first replies land on an unsubscribed char and are lost --
     * which would look exactly like "the ring sent nothing".
     */
    private var notifySubscriptions = 0
    private var expectedSubscriptions = 0

    private var initSequenceRun = false
    private var isDisconnecting = false
    private var isScanning = false
    /** The current GATT link actually reached STATE_CONNECTED -- see disconnectLocked. */
    private var connectionEstablished = false

    private var scanTimeoutWork: Runnable? = null
    private var initSettleWork: Runnable? = null
    private var heartbeatWork: Runnable? = null

    /**
     * Serialized GATT operations. Android runs one per link; everything that produces a
     * callback (descriptor writes, characteristic reads, characteristic writes) goes here.
     */
    private val pendingOps = ArrayDeque<R1Op>()
    private var opInFlight: R1Op? = null
    private var opGen = 0

    /** One serialized GATT operation. [run] returns false if the stack refused to start it. */
    private class R1Op(val label: String, val run: () -> Boolean) {
        var attempts = 0
    }

    private val isoFormatter = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    // MARK: - Init

    init {
        registerAdapterStateReceiver()
    }

    /**
     * Emit the initial adapter state. Called by the module AFTER wiring the callbacks -- see the
     * identical note on G2Central.start() for why this cannot live in `init`.
     */
    fun start() = post {
        val desc = adapterStateDescription()
        log("bluetooth $desc")
        onStateChange?.invoke(desc)
    }

    fun shutdown() = post {
        stopScanLocked()
        stopHeartbeatLocked()
        closeGattLocked()
        try {
            context.unregisterReceiver(adapterReceiver)
        } catch (_: IllegalArgumentException) {
        }
        thread.quitSafely()
    }

    /**
     * See the identical helper in G2Central: an uncaught exception on a HandlerThread is a FATAL
     * EXCEPTION that kills the whole app, which on a hardware driver turns one bad frame into a
     * lost debugging session. The error is logged loudly to both logcat and the JS sink rather
     * than swallowed.
     */
    private fun guarded(what: String, block: () -> Unit): Runnable = Runnable {
        try {
            block()
        } catch (t: Throwable) {
            Log.e(TAG, "unhandled exception on the R1 queue ($what)", t)
            onLog?.invoke("[ffs-ble] EXCEPTION on the R1 queue ($what): $t")
        }
    }

    private fun post(block: () -> Unit) {
        handler.post(guarded("post", block))
    }

    private fun schedule(ms: Long, block: () -> Unit) {
        handler.postDelayed(guarded("delayed", block), ms)
    }

    private fun log(message: String) {
        val line = "[${isoFormatter.format(java.util.Date())}] R1: $message"
        Log.i(TAG, line)
        onLog?.invoke(line)
    }

    private fun hex(data: ByteArray): String =
        data.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }

    private fun shortUuid(uuid: UUID): String = uuid.toString().uppercase().take(8)

    // MARK: - Adapter state

    private val adapterReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            post {
                val desc = adapterStateDescription()
                log("bluetooth $desc")
                onStateChange?.invoke(desc)
                if (desc == "poweredOn" && gatt == null && !isDisconnecting) startScanLocked()
            }
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

    private fun requiredPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun missingPermissions(): List<String> = requiredPermissions().filter {
        context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
    }

    private fun ensurePermissionsLocked(what: String): Boolean {
        val missing = missingPermissions()
        if (missing.isEmpty()) return true
        log("$what blocked -- missing permission(s): ${missing.joinToString(", ")}")
        activityProvider()?.let { activity ->
            log("requesting BLE permissions -- tap $what again once granted")
            activity.runOnUiThread { activity.requestPermissions(missing.toTypedArray(), 4712) }
        } ?: log("cannot request BLE permissions: no foreground activity")
        onStateChange?.invoke("unauthorized")
        return false
    }

    // MARK: - Public API

    /** Begin scanning for the ring. Reconnects by stored MAC first when possible. */
    fun startScan() = post { startScanLocked() }

    private fun startScanLocked() {
        val adapter = this.adapter
        if (adapter == null || !adapter.isEnabled) {
            log("scan requested but Bluetooth is not powered on")
            return
        }
        if (!ensurePermissionsLocked("ringScan")) return
        isDisconnecting = false

        // Android MACs are stable for a bonded device and resolvable offline, so a known ring
        // can be re-bound with no scan at all -- a straight win over the iOS path, which has to
        // ask CoreBluetooth to look the identifier up.
        val savedMac = prefs.getString(KEY_MAC, null)
        if (savedMac != null && gatt == null) {
            val known = try {
                adapter.getRemoteDevice(savedMac)
            } catch (e: IllegalArgumentException) {
                log("stored ring MAC is invalid ($savedMac)")
                null
            }
            if (known != null) {
                log("reconnecting by MAC to ${known.name ?: "ring"} ($savedMac)")
                // autoConnect=true: the ring may not be advertising right now, and this is a
                // device we already know. No timeout, connects the moment it appears.
                connectLocked(known, direct = false)
                return
            }
        }

        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            log("scan failed -- no BLE scanner")
            return
        }
        if (isScanning) return
        isScanning = true
        // No service filter -- the ring does not reliably advertise its custom service.
        log("scanning (name filters: ${NAME_FILTERS.joinToString(", ")})")
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .build()
        scanner.startScan(null, settings, scanCallback)

        scanTimeoutWork?.let { handler.removeCallbacks(it) }
        // Wrapped, then STORED -- removeCallbacks matches by identity.
        val work = guarded("scanTimeout") {
            if (gatt != null) return@guarded
            log("scan timed out after ${SCAN_TIMEOUT_MS / 1000}s -- no ring found")
            stopScanLocked()
        }
        scanTimeoutWork = work
        handler.postDelayed(work, SCAN_TIMEOUT_MS)
    }

    fun stopScan() = post { stopScanLocked() }

    private fun stopScanLocked() {
        scanTimeoutWork?.let { handler.removeCallbacks(it) }
        scanTimeoutWork = null
        if (!isScanning) return
        isScanning = false
        if (missingPermissions().isNotEmpty()) return
        adapter?.bluetoothLeScanner?.stopScan(scanCallback)
    }

    fun disconnect() = post { disconnectLocked() }

    private fun disconnectLocked() {
        isDisconnecting = true
        stopHeartbeatLocked()
        stopScanLocked()
        val g = gatt
        if (g == null) {
            resetConnectionStateLocked()
            return
        }
        // For an ESTABLISHED link, disconnect() yields an onConnectionStateChange where close()
        // happens; closing straight away would suppress that callback and strand JS believing
        // the ring is still connected.
        g.disconnect()

        // For a link that never came up, that callback NEVER ARRIVES: cancelling a background
        // (autoConnect=true) connect drops the allow-list entry without a client callback, and
        // the reconnect-by-MAC path uses exactly that, pending indefinitely while the ring is
        // off the finger. Without this branch the GATT client leaks and `gatt` stays non-null,
        // so handleScanResultLocked's `if (gatt != null) return` makes every later scan a no-op
        // -- the ring can never be found again for the life of the process.
        if (!connectionEstablished) {
            log("ring never connected -- closing here (Android sends no callback for a cancelled pending connect)")
            resetConnectionStateLocked()
            onDisconnected?.invoke("cancelled before connect")
        }
    }

    /** Forget the stored ring so the next scan pairs fresh. */
    fun forget() = post {
        disconnectLocked()
        prefs.edit().remove(KEY_MAC).apply()
        log("forgot the stored ring")
    }

    fun readBattery() = post { readBatteryLocked() }

    private fun readBatteryLocked() {
        val g = gatt ?: return
        val ch = batteryChar ?: return
        enqueueOpLocked("readBattery") { g.readCharacteristic(ch) }
    }

    /**
     * Command the ring to ALSO connect to the glasses -- `advStart` with the 6-byte glasses
     * MAC, written to WRITE_2. Ported from MentraOS `R1.swift`, which RE'd it from Even's own
     * app (BleRing1CmdProto::advStart).
     *
     * This is deliberately NOT automatic. Our input path is the phone link; this exists so we
     * can drive the ring->glasses link when we want it (and so we can test whether the ring
     * will hold both links at once -- an open question).
     */
    fun connectToGlasses(mac: String): Boolean {
        val macBytes = parseMac(mac)
        if (macBytes == null) {
            post { log("connectToGlasses: could not parse MAC '$mac'") }
            return false
        }
        val wc = writeChar2 ?: writeChar1
        val g = gatt
        if (wc == null || g == null) {
            post { log("connectToGlasses: no write characteristic / not connected") }
            return false
        }
        val payload = byteArrayOf(CMD_SYSTEM, MODULE_SYSTEM, SUBCMD_ADV_START) + macBytes
        post {
            writeCharLocked(wc, payload, "advStart")
            log("advStart -> ${hex(payload)}")
        }
        return true
    }

    /**
     * Inject a synthetic ring gesture as if the R1 had sent it.
     *
     * Builds the real `[0xFF, type, param]` frame and feeds it through the REAL inbound handler,
     * so the marker check, [R1Gesture] decode, raw-hex emit and `onGesture` all run exactly as
     * they would for a finger on the ring. See the note on `G2Central.simulateGesture` for the
     * boundary: this proves everything ABOVE the radio and nothing below it. In particular it
     * cannot answer the open FUT-233 question of which gestures the phone link actually carries
     * -- only a real ring can, and pretending otherwise would answer it WRONG.
     */
    fun simulateGesture(gesture: String) = post {
        val frame = when (gesture) {
            R1Gesture.HOLD -> byteArrayOf(0xFF.toByte(), 0x03, 0x00)
            R1Gesture.SINGLE_TAP -> byteArrayOf(0xFF.toByte(), 0x04, 0x01)
            R1Gesture.DOUBLE_TAP -> byteArrayOf(0xFF.toByte(), 0x04, 0x02)
            R1Gesture.SWIPE_UP -> byteArrayOf(0xFF.toByte(), 0x05, 0x00)
            R1Gesture.SWIPE_DOWN -> byteArrayOf(0xFF.toByte(), 0x05, 0xFF.toByte())
            else -> {
                log("simulateGesture: unknown ring gesture '$gesture' " +
                    "(hold | single_tap | double_tap | swipe_up | swipe_down)")
                return@post
            }
        }
        log("SIMULATED RING GESTURE '$gesture' -- synthetic frame, NOT from the ring")
        handleLocked(frame, NOTIFY_2)
    }

    /** "AA:BB:CC:DD:EE:FF" or "AABBCCDDEEFF" -> 6 raw bytes. */
    fun parseMac(s: String): ByteArray? {
        val cleaned = s.replace(":", "").replace("-", "")
        if (cleaned.length != 12) return null
        val out = ByteArray(6)
        for (i in 0 until 6) {
            val byte = cleaned.substring(i * 2, i * 2 + 2).toIntOrNull(16) ?: return null
            out[i] = byte.toByte()
        }
        return out
    }

    // MARK: - Connect

    private fun connectLocked(device: BluetoothDevice, direct: Boolean) {
        stopScanLocked()
        if (!ensurePermissionsLocked("ringConnect")) return
        ringName = device.name
        gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            device.connectGatt(context, !direct, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
            device.connectGatt(context, !direct, gattCallback)
        }
        if (gatt == null) log("connectGatt returned null for ${device.address}")
    }

    private fun closeGattLocked() {
        try {
            gatt?.close()
        } catch (e: Exception) {
            log("gatt.close() threw: ${e.message}")
        }
        gatt = null
    }

    private fun resetConnectionStateLocked() {
        initSettleWork?.let { handler.removeCallbacks(it) }
        initSettleWork = null
        writeChar1 = null
        writeChar2 = null
        batteryChar = null
        notifySubscriptions = 0
        expectedSubscriptions = 0
        initSequenceRun = false
        connectionEstablished = false
        pendingOps.clear()
        opInFlight = null
        opGen += 1 // any in-flight op's timeout must not fire against the next link
        closeGattLocked()
    }

    // MARK: - Serialized GATT operations

    private fun enqueueOpLocked(label: String, op: () -> Boolean) {
        pendingOps.addLast(R1Op(label, op))
        startNextOpLocked()
    }

    /**
     * Run the head of the op queue. Same two rules as G2Central's queue, and for the same
     * reasons:
     *
     * 1. PEEK and RETRY on refusal. `BluetoothGatt` allows one in-flight op per link; a refusal
     *    means the slot is momentarily busy, not that the op is impossible. Discarding it here
     *    would drop a subscription, and on this device that means the gesture channel.
     * 2. Fence the timeout by GENERATION, not by label. The ring subscribes to EVERY notifying
     *    characteristic and reads EVERY readable one, so the queue is long and labels repeat
     *    (`init:FC` is enqueued twice, once per write char). With a label match, a completion
     *    arriving after its own timeout had fired would complete the NEXT op instead, silently
     *    discarding it and everything behind it -- and "the ring sent nothing" is precisely the
     *    false negative FUT-233 must not produce, because it is also what a real answer to the
     *    open gesture-coverage question would look like.
     */
    private fun startNextOpLocked() {
        if (opInFlight != null) return
        val op = pendingOps.firstOrNull() ?: return
        opInFlight = op
        val gen = ++opGen

        val started = try {
            op.run()
        } catch (e: SecurityException) {
            log("GATT op '${op.label}' refused: ${e.message}")
            false
        }
        if (!started) {
            opInFlight = null
            op.attempts += 1
            if (op.attempts > OP_MAX_RETRIES) {
                pendingOps.removeFirstOrNull()
                log("GATT op '${op.label}' refused $OP_MAX_RETRIES times -- giving up")
            }
            schedule(OP_RETRY_MS) { startNextOpLocked() }
            return
        }

        schedule(OP_TIMEOUT_MS) {
            if (opGen == gen && opInFlight === op) {
                log("GATT op '${op.label}' timed out -- continuing")
                pendingOps.removeFirstOrNull()
                opInFlight = null
                startNextOpLocked()
            }
        }
    }

    private fun completeOpLocked() {
        opGen += 1 // invalidates the in-flight op's pending timeout
        pendingOps.removeFirstOrNull()
        opInFlight = null
        startNextOpLocked()
    }

    private fun writeCharLocked(ch: BluetoothGattCharacteristic, value: ByteArray, label: String) {
        val g = gatt ?: return
        // Prefer write-without-response (what the iOS driver uses), but fall back to a plain
        // write when the characteristic does not advertise it. Android rejects a write whose
        // type the characteristic does not support; iOS quietly sends it anyway.
        val noResp =
            (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
        val type = if (noResp) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
        enqueueOpLocked(label) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(ch, value, type) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    ch.writeType = type
                    ch.value = value
                    g.writeCharacteristic(ch)
                }
            }
        }
    }

    // MARK: - Init handshake

    /**
     * Runs ONCE, only after discovery has settled: write 0xFC to both write chars -> wait 200ms
     * -> write 0x11 -> connected.
     */
    private fun runInitSequenceLocked() {
        if (initSequenceRun) return
        initSequenceRun = true

        val writeChars = listOfNotNull(writeChar1, writeChar2)
        if (writeChars.isEmpty() || gatt == null) {
            log("init: no write characteristics -- the ring will not be driveable")
            markConnectedLocked()
            return
        }

        log("init: writing 0xFC to ${writeChars.size} char(s)")
        for (wc in writeChars) writeCharLocked(wc, CONFIG_FC, "init:FC")

        schedule(INIT_GAP_MS) {
            if (gatt == null) return@schedule
            log("init: writing 0x11")
            for (wc in writeChars) writeCharLocked(wc, CONFIG_11, "init:11")
            markConnectedLocked()
        }
    }

    private fun markConnectedLocked() {
        val name = ringName ?: "ring"
        log("READY -- $name. Gestures should now arrive on ${shortUuid(NOTIFY_2)}.")
        onConnected?.invoke(name)
        readBatteryLocked()
        startHeartbeatLocked()
    }

    private fun startHeartbeatLocked() {
        stopHeartbeatLocked()
        // Self-rescheduling, so it posts ITSELF rather than a fresh wrapper -- otherwise each
        // tick would create a new object and stopHeartbeat could only ever cancel the first one.
        val work = object : Runnable {
            override fun run() {
                try {
                    if (gatt == null) return
                    readBatteryLocked()
                } catch (t: Throwable) {
                    Log.e(TAG, "unhandled exception in the R1 heartbeat", t)
                    onLog?.invoke("[ffs-ble] EXCEPTION in the R1 heartbeat: $t")
                }
                handler.postDelayed(this, HEARTBEAT_MS)
            }
        }
        heartbeatWork = work
        handler.postDelayed(work, HEARTBEAT_MS)
    }

    private fun stopHeartbeatLocked() {
        heartbeatWork?.let { handler.removeCallbacks(it) }
        heartbeatWork = null
    }

    /** Run the init handshake once discovery has stopped producing new characteristics. */
    private fun scheduleInitAfterDiscoveryLocked() {
        initSettleWork?.let { handler.removeCallbacks(it) }
        val work = guarded("initSettle") {
            if (initSequenceRun) return@guarded
            log("discovery settled -- $notifySubscriptions/$expectedSubscriptions subscriptions confirmed")
            runInitSequenceLocked()
        }
        initSettleWork = work
        handler.postDelayed(work, SETTLE_MS)
    }

    // MARK: - Scanning

    private fun matchesNameFilter(name: String?): Boolean {
        if (name == null) return false
        val upper = name.uppercase()
        return NAME_FILTERS.any { upper.contains(it) }
    }

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
                log("scan FAILED -- code $errorCode")
            }
        }
    }

    private fun handleScanResultLocked(result: ScanResult) {
        if (gatt != null) return // already connecting/connected
        val device = result.device ?: return
        val name = result.scanRecord?.deviceName ?: device.name
        if (!matchesNameFilter(name)) return
        log("found '${name ?: "?"}' rssi=${result.rssi}")
        onDeviceFound?.invoke(name ?: "ring", result.rssi)
        prefs.edit().putString(KEY_MAC, device.address).apply()
        connectLocked(device, direct = true)
    }

    // MARK: - GATT callbacks (binder thread -> serial queue immediately)

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            post {
                if (newState == BluetoothProfile.STATE_CONNECTED &&
                    status == BluetoothGatt.GATT_SUCCESS
                ) {
                    ringName = g.device.name ?: ringName
                    connectionEstablished = true
                    log("connected ${ringName ?: "ring"} -- discovering ALL services")
                    // nil/no filter = discover EVERYTHING. Do not narrow this to the services
                    // we think we need: gestures may arrive on a characteristic we haven't
                    // catalogued, and a filtered discovery makes that invisible by construction
                    // -- indistinguishable from "the ring sent nothing". (FUT-233: a filtered
                    // discovery produced exactly that false negative.)
                    g.discoverServices()
                    return@post
                }
                if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    val reason = if (status == BluetoothGatt.GATT_SUCCESS) null else "status $status"
                    log("disconnected${if (reason != null) " ($reason)" else ""}")
                    stopHeartbeatLocked()
                    resetConnectionStateLocked()
                    onDisconnected?.invoke(reason)
                    if (!isDisconnecting) startScanLocked()
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            post {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    log("service discovery failed: status=$status")
                    return@post
                }
                val services = g.services.orEmpty()
                log("services: ${services.joinToString(", ") { shortUuid(it.uuid) }}")
                for (service in services) {
                    for (c in service.characteristics.orEmpty()) catalogueLocked(g, c)
                }
                scheduleInitAfterDiscoveryLocked()
            }
        }

        override fun onDescriptorWrite(
            g: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            post {
                if (descriptor.uuid == CCCD) {
                    val ch = descriptor.characteristic.uuid
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        notifySubscriptions += 1
                        log("subscribed ${shortUuid(ch)} ($notifySubscriptions/$expectedSubscriptions)")
                    } else {
                        log("subscribe FAILED on ${shortUuid(ch)}: status=$status")
                    }
                    // Push the settle timer out on every confirmation, so the handshake waits
                    // for discovery to genuinely finish rather than firing after the first
                    // service.
                    scheduleInitAfterDiscoveryLocked()
                }
                completeOpLocked()
            }
        }

        override fun onCharacteristicWrite(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            post { completeOpLocked() }
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            val uuid = characteristic.uuid
            post {
                if (status == BluetoothGatt.GATT_SUCCESS) handleReadLocked(uuid, value)
                else log("read failed on ${shortUuid(uuid)}: status=$status")
                completeOpLocked()
            }
        }

        @Deprecated("Deprecated in API 33, still the only path below it")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            val uuid = characteristic.uuid
            val value = characteristic.value?.copyOf()
            post {
                if (status == BluetoothGatt.GATT_SUCCESS && value != null) {
                    handleReadLocked(uuid, value)
                } else if (status != BluetoothGatt.GATT_SUCCESS) {
                    log("read failed on ${shortUuid(uuid)}: status=$status")
                }
                completeOpLocked()
            }
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            val uuid = characteristic.uuid
            post { handleLocked(value, uuid) }
        }

        @Deprecated("Deprecated in API 33, still the only path below it")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            val uuid = characteristic.uuid
            // Copy: the framework reuses this buffer for the next notification.
            val value = characteristic.value?.copyOf() ?: return
            post { handleLocked(value, uuid) }
        }
    }

    /**
     * Catalogue one characteristic, subscribe to it if it notifies, and read it if it is
     * readable.
     */
    private fun catalogueLocked(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
        when (c.uuid) {
            WRITE_1 -> writeChar1 = c
            WRITE_2 -> writeChar2 = c
            BATTERY_CHAR -> batteryChar = c
        }

        val p = c.properties
        val props = buildList {
            if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) add("read")
            if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) add("write")
            if (p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) add("writeNoResp")
            if (p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) add("notify")
            if (p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) add("indicate")
        }
        log("char ${shortUuid(c.uuid)} props=[${props.joinToString(",")}]")

        // Subscribe to EVERY notifying characteristic, known or not. If the ring reports
        // gestures somewhere we didn't anticipate, this is what catches it.
        val notifies = p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0
        val indicates = p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
        if (notifies || indicates) {
            if (g.setCharacteristicNotification(c, true)) {
                val cccd = c.getDescriptor(CCCD)
                if (cccd != null) {
                    expectedSubscriptions += 1
                    val value = if (notifies) {
                        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    } else {
                        BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                    }
                    enqueueOpLocked("subscribe:${shortUuid(c.uuid)}") {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            g.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS
                        } else {
                            @Suppress("DEPRECATION")
                            run {
                                cccd.value = value
                                g.writeDescriptor(cccd)
                            }
                        }
                    }
                } else {
                    log("no CCCD on ${shortUuid(c.uuid)} -- cannot enable notifications")
                }
            }
        }

        // And READ every readable characteristic. This is not for the value: a read of an
        // encrypted characteristic is what triggers the stack to BOND. Without it, a ring that
        // was unpaired can connect and accept subscriptions while never delivering a single
        // notification -- silence that looks identical to a dead protocol.
        if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) {
            enqueueOpLocked("read:${shortUuid(c.uuid)}") { g.readCharacteristic(c) }
        }
    }

    private fun handleReadLocked(uuid: UUID, data: ByteArray) {
        if (data.isEmpty()) return
        if (uuid == BATTERY_CHAR) {
            val pct = data[0].toInt() and 0xFF
            log("battery $pct% (standard service)")
            onBattery?.invoke(pct)
            return
        }
        handleLocked(data, uuid)
    }

    // MARK: - Inbound frames

    /**
     * Every notification lands here. The raw hex is emitted FIRST and unconditionally, before
     * any interpretation -- the point of the live test is to see what the ring actually sends,
     * including frames our parser does not understand.
     */
    private fun handleLocked(data: ByteArray, uuid: UUID) {
        if (data.isEmpty()) return
        val h = hex(data)
        val ch = shortUuid(uuid)
        log("rx $ch <- $h")
        onRaw?.invoke(ch, h)

        fun b(i: Int) = data[i].toInt() and 0xFF

        // Gesture: [0xFF, type, param]
        if (data.size >= 3 && b(0) == GESTURE_MARKER) {
            val g = R1Gesture.parse(data)
            if (g != null) {
                log("GESTURE: $g  [raw $h]")
                onGesture?.invoke(g, h)
            } else {
                // Not a failure to report loudly -- an unmapped gesture code is a FINDING.
                log(
                    "UNKNOWN gesture frame type=0x%02X param=0x%02X [raw %s]"
                        .format(b(1), b(2), h)
                )
            }
            return
        }

        // Battery: 2 bytes, first is percent.
        if (data.size == 2 && b(0) <= 100) {
            log("battery ${b(0)}%")
            onBattery?.invoke(b(0))
            return
        }

        // State: 1 byte -- 0x01 ready, 0x00 menu.
        if (data.size == 1) {
            val state = when (b(0)) {
                0x01 -> "ready"
                0x00 -> "menu"
                else -> "unknown(${b(0)})"
            }
            log("state $state")
            return
        }

        // A longer frame may still carry a gesture triplet embedded in it.
        if (data.size > 3) {
            val ffIndex = data.indexOfFirst { (it.toInt() and 0xFF) == GESTURE_MARKER }
            if (ffIndex >= 0 && ffIndex + 2 < data.size) {
                val triplet = data.copyOfRange(ffIndex, ffIndex + 3)
                val g = R1Gesture.parse(triplet)
                if (g != null) {
                    log("GESTURE (embedded): $g  [raw $h]")
                    onGesture?.invoke(g, h)
                }
            }
        }
    }
}

/**
 * The five discrete gestures. ⚠️ There is NO rotary/scroll-wheel on the R1 -- an earlier claim
 * to the contrary was our own inference and was retracted.
 *
 * Names are the wire-level strings the shared TypeScript `R1GestureName` union expects; they
 * are deliberately NOT normalized here (`single_tap` stays distinct from the glasses' `tap`),
 * because `toNavGesture` in FfsBleModule.ts is the one place that collapses input vocabularies.
 */
object R1Gesture {
    const val HOLD = "hold"
    const val SINGLE_TAP = "single_tap"
    const val DOUBLE_TAP = "double_tap"
    const val SWIPE_UP = "swipe_up"
    const val SWIPE_DOWN = "swipe_down"

    /**
     * Parse `[0xFF, type, param]`.
     *
     * ⚠️ The 0x05 threshold is MentraOS's: param <0x80 up, >=0x80 down. It is possible the
     * param carries swipe MAGNITUDE rather than just direction -- which would buy us
     * proportional scrolling -- so the raw param is logged separately and not discarded.
     */
    fun parse(data: ByteArray): String? {
        if (data.size < 3) return null
        if ((data[0].toInt() and 0xFF) != R1Central.GESTURE_MARKER) return null
        val type = data[1].toInt() and 0xFF
        val param = data[2].toInt() and 0xFF
        return when (type) {
            0x03 -> HOLD
            0x04 -> when (param) {
                0x01 -> SINGLE_TAP
                0x02 -> DOUBLE_TAP
                else -> null
            }
            0x05 -> if (param < 0x80) SWIPE_UP else SWIPE_DOWN
            else -> null
        }
    }
}
