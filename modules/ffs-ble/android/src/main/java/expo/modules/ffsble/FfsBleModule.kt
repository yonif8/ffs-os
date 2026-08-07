package expo.modules.ffsble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * FfsBleModule -- Android side of the FFS G2 BLE driver.
 *
 * This is the Android twin of `ios/FfsBleModule.swift` and MUST expose exactly the same
 * function and event names, because `src/FfsBleModule.ts` is the single typed contract both
 * platforms satisfy and the whole `src/os` TypeScript OS is written against it. If you add a
 * capability on one platform, add its binding on the other in the same change -- a missing name
 * here is a runtime crash in shared JS, not a compile error. `scripts/check-native-parity.py`
 * enforces this.
 *
 * PHASE 1 (this file, current state): the radio is REAL. [G2Central] and [R1Central] are
 * written directly against `android.bluetooth`, and everything from `startScan` through
 * `showText`, gesture decode, the EvenHub session and the FUT-216 payload push is implemented.
 *
 * Still stubbed, and each for a specific reason rather than for lack of time:
 *   - `playAnimation` / `showDashboard` / `hideDashboard` / `dashboardInput` / `setDashboardData`
 *     need a PIXEL RASTERIZER (`G2Anim` / `FfsDashboard` are CoreGraphics on iOS and become
 *     `android.graphics.Canvas` here). That is Phase 3 -- the transport those renderers feed is
 *     already live below, so it is genuinely just the frame generator that is missing.
 *   - `startCfwFlash` is Phase 4 and LAST by design: a botched DFU over an unproven BLE stack
 *     bricks the glasses. Flash from the iOS app until the Android link is boringly stable.
 *     `flashDryRun` is real, because it is a zero-write probe of already-discovered GATT.
 *
 * `getPref`/`setPref` are SharedPreferences (UserDefaults on iOS) -- the calibration flow
 * depends on them across launches.
 *
 * Per cardinal rule 1, none of this counts as shipped until it is seen working on the glasses.
 */
class FfsBleModule : Module() {

  /**
   * The single BLE central for the whole app. Created lazily on first use so we do not spin up
   * the Bluetooth stack (or trip a permission prompt) at import time.
   */
  private var central: G2Central? = null

  /**
   * The R1 ring central (FUT-233) -- the SDK's input device. Created lazily and independently
   * of [central]: the ring is usable with the glasses powered off, which is exactly the
   * configuration the gesture-coverage test needs.
   */
  private var ring: R1Central? = null

  private val prefs by lazy {
    appContext.reactContext?.getSharedPreferences("ffs_prefs", Context.MODE_PRIVATE)
  }

  override fun definition() = ModuleDefinition {
    Name("FfsBleModule")

    // Must stay in sync with the Events(...) list in ios/FfsBleModule.swift and with
    // `FfsBleEvents` in src/FfsBleModule.ts.
    Events(
      "onLog",
      "onStateChange",
      "onDeviceFound",
      "onConnected",
      "onServicesDiscovered",
      "onPairReady",
      "onNotify",
      "onGesture",
      "onDeviceInfo",
      "onDisconnected",
      "onFlashProbe",
      "onFlashProgress",
      // FUT-253 native BLE observability (Step 3): link-level telemetry.
      "onRssi",
      "onMtu",
      "onConnectFailed",
      "onTxMeter",
      "onTxStall",
      "onTxResume",
      "onSubscribe",
      "onImgAck",
      // R1 ring (FUT-233). Ring gestures come through the shared "onGesture" event tagged
      // device:"ring"; these are the ring-specific lifecycle/raw channels.
      "onRingConnected",
      "onRingDisconnected",
      "onRingRaw",
      "onRingBattery"
    )

    // ---- persistent key/value (FUT-236) ----

    Function("getPref") { key: String ->
      prefs?.getString("ffs_pref_$key", null)
    }

    Function("setPref") { key: String, value: String ->
      prefs?.edit()?.putString("ffs_pref_$key", value)?.apply()
    }

    // ---- R1 ring (FUT-233) ----

    Function("ringScan") { ensureRing()?.startScan() }
    Function("ringStopScan") { ring?.stopScan() }
    Function("ringDisconnect") { ring?.disconnect() }
    Function("ringForget") { ring?.forget() }
    Function("ringReadBattery") { ring?.readBattery() }

    /**
     * Command the ring to ALSO connect to the glasses at `mac`. Not required for input (that
     * comes over the phone link) -- this drives the ring<->glasses link.
     */
    Function("ringConnectToGlasses") { mac: String ->
      ensureRing()?.connectToGlasses(mac) ?: false
    }

    // ---- glasses link ----

    Function("startScan") { ensureCentral()?.startScan() }
    Function("stopScan") { central?.stopScan() }

    // Connect the PAIR (both lenses). This is the primary entry point.
    Function("connect") { ensureCentral()?.connectPair() }

    // Connect a SINGLE side only (testing convenience). `side` is "L" or "R".
    Function("connectSide") { side: String -> ensureCentral()?.connectSide(G2Side.parse(side)) }

    Function("disconnect") { central?.disconnect() }

    // True once BOTH lenses are connected + required characteristics discovered.
    // No log line and no cross-thread hop: JS polls this, so it reads a volatile snapshot.
    Function("isPairReady") { central?.isPairReady() ?: false }

    Function("isSideReady") { side: String ->
      central?.isSideReady(G2Side.parse(side)) ?: false
    }

    // ---- render ----

    // Run the auth handshake if needed, then render `text` on the HUD. Connect the pair first.
    Function("showText") { text: String -> ensureCentral()?.showText(text) }

    // Render a test image through our own raw-image path (FUT-153).
    Function("showImage") { ensureCentral()?.showImage() }

    // FUT-165: toggle the firmware's NATIVE Even-AI "thinking" swirl (GPU-smooth, dual-lens)
    // via the even_ai session lifecycle.
    Function("showAiSwirl") { on: Boolean -> ensureCentral()?.aiSwirl(on) }

    // Phase 3: needs the G2Anim pixel rasterizer (android.graphics.Canvas). The mode-2
    // transport it streams into is already live -- see sendAnimFrame in G2Central.kt.
    Function("playAnimation") { _: String -> notYet("playAnimation", "Phase 3 (rasterizer)") }

    Function("stopAnimation") { central?.stopAnimation() }

    // ---- dashboards ----

    // FUT-170 PoC: push custom text into the firmware's native head-up dashboard over BLE.
    Function("pushDashboardDemo") { text: String -> ensureCentral()?.pushDashboardDemo(text) }

    // FUT-170: reveal Even's OWN native head-up dashboard by releasing our EvenHub page.
    Function("showStockDashboard") { ensureCentral()?.showStockDashboard() }

    // FUT-194: drive the firmware's own dashboard entirely from our OS over BLE. No pixels.
    Function("showNativeDashboard") { config: String ->
      ensureCentral()?.showNativeDashboard(config)
    }

    // FUT-176: our OWN dashboard, rendered as our pixels. Phase 3 -- needs FfsDashboard.render.
    Function("showDashboard") { notYet("showDashboard", "Phase 3 (rasterizer)") }
    Function("hideDashboard") { notYet("hideDashboard", "Phase 3 (rasterizer)") }
    Function("dashboardInput") { _: String -> notYet("dashboardInput", "Phase 3 (rasterizer)") }
    Function("setDashboardData") { _: String -> notYet("setDashboardData", "Phase 3 (rasterizer)") }

    // ---- session / info ----

    // FUT-169 / FUT-167: real battery %, charging, per-lens firmware version. Async via
    // `onDeviceInfo`. Connect the pair first.
    Function("requestDeviceInfo") { ensureCentral()?.requestDeviceInfo() }

    // Tear down the EvenHub session (stops the keep-alive heartbeat).
    Function("stopSession") { central?.stopSession() }

    // ---- payload delivery (FUT-216) ----

    Function("pushToService") { serviceId: Int, base64: String ->
      ensureCentral()?.pushToService(serviceId and 0xFF, base64)
    }

    Function("pushPayloadViaImage") { base64: String ->
      ensureCentral()?.pushPayloadViaImage(base64)
    }

    // ---- test affordance ----

    /**
     * Inject a synthetic gesture so the input -> render path can be driven without a finger on
     * the temple pad or the ring. `device` is "glasses" or "ring". Every injection logs
     * "SIMULATED": it exercises decode, nav and render for real, but proves nothing about
     * whether a real touch reaches us -- see the note on G2Central.simulateGesture.
     */
    Function("simulateGesture") { device: String, gesture: String ->
      when (device.lowercase()) {
        "ring" -> ensureRing()?.simulateGesture(gesture)
        "glasses" -> ensureCentral()?.simulateGesture(gesture)
        else -> sendEvent(
          "onLog",
          mapOf("message" to "[android] simulateGesture: device must be 'glasses' or 'ring', got '$device'")
        )
      }
    }

    // ---- flashing (FUT-167) ----

    // Stage 1 is a ZERO-WRITE probe of already-discovered GATT: no brick risk, so it ships now.
    Function("flashDryRun") { ensureCentral()?.flashDryRun() }

    // Stage 2 writes firmware. LIVE as of FUT-260. Everything upstream of the first write is a
    // refusal gate: SHA match, EVENOTA parse, MRAM brick-guard, known-golden lookup, and a
    // self-test that the guard still reproduces its own vector. `dryRun=true` runs that entire
    // chain and stops before any byte is written.
    Function("startCfwFlash") { url: String, sha256: String, dryRun: Boolean ->
      ensureCentral()?.startCfwFlash(url, sha256, dryRun)
    }

    OnCreate { registerSimulationReceiver() }

    OnDestroy {
      unregisterSimulationReceiver()
      central?.shutdown()
      central = null
      ring?.shutdown()
      ring = null
    }
  }

  // ---- adb-driven gesture injection (DEBUG BUILDS ONLY) ----

  private var simReceiver: BroadcastReceiver? = null

  /**
   * Register the receiver that lets `adb shell am broadcast` inject a gesture:
   *
   *   adb shell am broadcast -a com.futurefounders.ffs.SIMULATE_GESTURE \
   *     --es device glasses --es gesture tap -p com.futurefounders.glassesos
   *
   * WHY THIS EXISTS: the input->render path (FUT-249) is the project's open front, and every
   * iteration on it otherwise costs a human finger on a temple pad. This makes the whole loop
   * -- change code, build, install, fire a gesture, read the result -- runnable from the dev
   * machine with nobody holding the hardware.
   *
   * WHY IT IS SAFE: the receiver has to be EXPORTED for the shell uid to reach it, and an
   * exported "make the app think the user did something" endpoint is a genuine hole in a
   * shipped app. So it is registered ONLY when the app itself is debuggable, checked against
   * the app's own ApplicationInfo flag rather than a library BuildConfig (which does not
   * reliably track the consuming app's variant). A release build never registers it and there
   * is nothing to reach.
   */
  private fun registerSimulationReceiver() {
    val context = appContext.reactContext ?: return
    val debuggable =
      (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debuggable) return

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        when (intent?.action) {
          SIMULATE_ACTION -> {
            val device = intent.getStringExtra("device") ?: "glasses"
            val gesture = intent.getStringExtra("gesture") ?: return
            when (device.lowercase()) {
              "ring" -> ensureRing()?.simulateGesture(gesture)
              else -> ensureCentral()?.simulateGesture(gesture)
            }
          }
          // Drives the OTA flasher from adb so the flash loop needs no UI navigation. Every
          // refusal gate in G2Flasher still applies -- this only chooses WHEN to run the chain,
          // never what it is allowed to accept. `dry` defaults to TRUE: the destructive form
          // has to be asked for explicitly, so a malformed command validates instead of writes.
          FLASH_ACTION -> {
            val url = intent.getStringExtra("url") ?: return
            val sha = intent.getStringExtra("sha") ?: return
            val dry = intent.getBooleanExtra("dry", true)
            sendEvent(
              "onLog",
              mapOf("message" to "[android] debug flash request: dry=$dry sha=${sha.take(12)}... url=$url")
            )
            ensureCentral()?.startCfwFlash(url, sha, dry)
          }
          "connect" -> ensureCentral()?.connectPair()
          // LIST-1: declare a native on-glass list. `items` is comma-separated; defaults to a
          // numbered set so the probe can be fired with no arguments at all.
          LIST_ACTION -> {
            val raw = intent.getStringExtra("items")
            val items = raw?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }
              ?: (0..7).map { "Item $it" }
            ensureCentral()?.showList(items)
          }
        }
      }
    }
    val filter = IntentFilter(SIMULATE_ACTION).apply {
      addAction(FLASH_ACTION)
      addAction(LIST_ACTION)
      addAction("connect")
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(receiver, filter)
    }
    simReceiver = receiver
    sendEvent(
      "onLog",
      mapOf("message" to "[android] debug build: gesture injection listening on $SIMULATE_ACTION")
    )
  }

  private fun unregisterSimulationReceiver() {
    val r = simReceiver ?: return
    simReceiver = null
    try {
      appContext.reactContext?.unregisterReceiver(r)
    } catch (_: IllegalArgumentException) {
      // Already gone; not worth failing a teardown over.
    }
  }

  private companion object {
    const val SIMULATE_ACTION = "com.futurefounders.ffs.SIMULATE_GESTURE"
    const val FLASH_ACTION = "com.futurefounders.ffs.FLASH"
    const val LIST_ACTION = "com.futurefounders.ffs.SHOW_LIST"
  }

  /**
   * Report an unimplemented binding to the JS log sink instead of throwing. The shared UI calls
   * these from button handlers; a throw would surface as a redbox and stop the app dead.
   */
  private fun notYet(name: String, phase: String) {
    sendEvent("onLog", mapOf("message" to "[android] $name: not implemented yet -- $phase"))
  }

  /** Lazily create the RING central (FUT-233) and wire its callbacks to sendEvent. */
  private fun ensureRing(): R1Central? {
    ring?.let { return it }
    val context = appContext.reactContext ?: run {
      sendEvent("onLog", mapOf("message" to "[android] ring: no React context yet"))
      return null
    }
    val r = R1Central(context) { appContext.activityProvider?.currentActivity }

    r.onLog = { message -> sendEvent("onLog", mapOf("message" to message)) }
    r.onStateChange = { state -> sendEvent("onStateChange", mapOf("state" to state)) }
    r.onDeviceFound = { name, rssi ->
      sendEvent(
        "onDeviceFound",
        mapOf("name" to name, "side" to "ring", "rssi" to rssi, "sn" to null, "mac" to null)
      )
    }
    r.onConnected = { name -> sendEvent("onRingConnected", mapOf("name" to name)) }
    // Ring gestures ride the SHARED onGesture event tagged device:"ring", so JS treats glasses
    // and ring input through one handler (see toNavGesture in FfsBleModule.ts).
    r.onGesture = { gesture, rawHex ->
      sendEvent(
        "onGesture",
        mapOf(
          "gesture" to gesture,
          "side" to "ring",
          "source" to null,
          "device" to "ring",
          "raw" to rawHex
        )
      )
    }
    // Every inbound ring frame, decoded or not -- the evidence channel for the live
    // gesture-coverage test. Deliberately unfiltered.
    r.onRaw = { characteristic, hex ->
      sendEvent("onRingRaw", mapOf("characteristic" to characteristic, "hex" to hex))
    }
    r.onBattery = { percent -> sendEvent("onRingBattery", mapOf("battery" to percent)) }
    r.onDisconnected = { reason -> sendEvent("onRingDisconnected", mapOf("reason" to reason)) }

    ring = r
    // AFTER the callbacks are wired, never from the constructor -- the driver's queue thread is
    // already running, so anything it emitted during construction would race these assignments
    // and be dropped on the floor.
    r.start()
    return r
  }

  /** Lazily create the glasses central and wire its callbacks to sendEvent. */
  private fun ensureCentral(): G2Central? {
    central?.let { return it }
    val context = appContext.reactContext ?: run {
      sendEvent("onLog", mapOf("message" to "[android] ble: no React context yet"))
      return null
    }
    val c = G2Central(context) { appContext.activityProvider?.currentActivity }

    c.onLog = { message -> sendEvent("onLog", mapOf("message" to message)) }
    c.onStateChange = { state -> sendEvent("onStateChange", mapOf("state" to state)) }
    c.onDeviceFound = { name, side, rssi, sn, mac ->
      sendEvent(
        "onDeviceFound",
        mapOf("name" to name, "side" to side, "rssi" to rssi, "sn" to sn, "mac" to mac)
      )
    }
    c.onConnected = { name, side ->
      sendEvent("onConnected", mapOf("name" to name, "side" to side))
    }
    c.onServicesDiscovered = { side, charUUIDs ->
      sendEvent("onServicesDiscovered", mapOf("side" to side, "characteristics" to charUUIDs))
    }
    c.onPairReady = { sendEvent("onPairReady", emptyMap<String, Any>()) }
    c.onNotify = { base64, characteristic, side ->
      sendEvent(
        "onNotify",
        mapOf("base64" to base64, "characteristic" to characteristic, "side" to side)
      )
    }
    c.onGesture = { gesture, side, source ->
      // `source` may legitimately be null (text/list events carry no eventSource field).
      sendEvent(
        "onGesture",
        mapOf(
          "gesture" to gesture,
          "side" to side,
          "source" to source,
          "device" to "glasses"
        )
      )
    }
    c.onDeviceInfo = { leftVersion, rightVersion, battery, charging ->
      sendEvent(
        "onDeviceInfo",
        mapOf(
          "leftVersion" to leftVersion,
          "rightVersion" to rightVersion,
          "battery" to battery,
          "charging" to charging
        )
      )
    }
    c.onFlashProbe = { leftReady, rightReady, detail ->
      sendEvent(
        "onFlashProbe",
        mapOf("leftReady" to leftReady, "rightReady" to rightReady, "detail" to detail)
      )
    }
    c.onFlashProgress = { message, progress, done, ok ->
      sendEvent(
        "onFlashProgress",
        mapOf("message" to message, "progress" to progress, "done" to done, "ok" to ok)
      )
    }
    c.onDisconnected = { name, side, reason, code, domain ->
      sendEvent(
        "onDisconnected",
        mapOf(
          "name" to name,
          "side" to side,
          "reason" to reason,
          "code" to code,
          "domain" to domain
        )
      )
    }

    // ---- FUT-253 native BLE observability (Step 3) ----
    c.onRssi = { side, rssi -> sendEvent("onRssi", mapOf("side" to side, "rssi" to rssi)) }
    c.onMtu = { side, mtu -> sendEvent("onMtu", mapOf("side" to side, "mtu" to mtu)) }
    c.onConnectFailed = { side, code, domain, desc ->
      sendEvent(
        "onConnectFailed",
        mapOf("side" to side, "code" to code, "domain" to domain, "desc" to desc)
      )
    }
    c.onTxMeter = { side, bytes, pkts, queueDepth ->
      sendEvent(
        "onTxMeter",
        mapOf("side" to side, "bytes" to bytes, "pkts" to pkts, "queueDepth" to queueDepth)
      )
    }
    c.onTxStall = { side, queueDepth ->
      sendEvent("onTxStall", mapOf("side" to side, "queueDepth" to queueDepth))
    }
    c.onTxResume = { side, queueDepth ->
      sendEvent("onTxResume", mapOf("side" to side, "queueDepth" to queueDepth))
    }
    c.onSubscribe = { side, characteristic, on ->
      sendEvent(
        "onSubscribe",
        mapOf("side" to side, "characteristic" to characteristic, "on" to on)
      )
    }
    c.onImgAck = { session, fragment, ok, timedOut ->
      sendEvent(
        "onImgAck",
        mapOf("session" to session, "fragment" to fragment, "ok" to ok, "timedOut" to timedOut)
      )
    }

    central = c
    // AFTER the callbacks are wired -- see the note in ensureRing().
    c.start()
    return c
  }
}
