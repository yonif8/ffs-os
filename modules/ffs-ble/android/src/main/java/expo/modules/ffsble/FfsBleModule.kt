package expo.modules.ffsble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * FfsBleModule -- Android side of the FFS G2 BLE BRIDGE.
 *
 * TRIMMED 2026-08-22 (docs/APK-CLEANUP-PLAN.md): the app is now a headless BLE bridge Claude
 * drives + a thin status screen, NOT a phone-OS that renders onto the glasses. The EvenHub-page /
 * render / animation / image / dashboard machinery, the SDK page transport, and the R1 ring were
 * quarantined to `modules/ffs-ble/legacy/` (data-in retired too, see `modules/legacy/ffs-notify`).
 *
 * What this exposes now is the bridge surface: adapter/scan, connect/disconnect, per-lens
 * readiness, `pushToService` (the sid-0x90 FXP1 payload route), device-info (battery/firmware),
 * inbound gesture + `onServiceRaw` (the sid-0x30 framebuffer screenshot rides this), mic-open
 * detection, HUD-setting instruments (brightness / silent / wear / lens-offset / IMU / mic), and
 * the CFW flash hooks. Claude drives most of it over the exported adb broadcast control surface
 * (PUSH_PAYLOAD / connect / DEVICE_INFO / FLASH / SETTING); the status screen binds connect,
 * readiness, device-info and the `on*` events.
 *
 * `getPref`/`setPref` are SharedPreferences (UserDefaults on iOS).
 *
 * Per cardinal rule 1, none of this counts as shipped until it is seen working on the glasses.
 */
class FfsBleModule : Module() {

  /**
   * The single BLE central for the whole app. Created lazily on first use so we do not spin up
   * the Bluetooth stack (or trip a permission prompt) at import time.
   */
  private var central: G2Central? = null

  private val prefs by lazy {
    appContext.reactContext?.getSharedPreferences("ffs_prefs", Context.MODE_PRIVATE)
  }

  /**
   * S-VOICE. Built lazily: it opens a SQLite database and a file archive, and an app that never
   * captures should pay for neither.
   *
   * ⛔ Everything audio-shaped stops inside this object. The functions below hand JavaScript
   * COUNTS, session ids, and -- only when the wearer asks for it by typing a query -- transcript
   * text. Never a sample, never a packet, never a base64 blob.
   */
  private val voice: expo.modules.ffsble.voice.VoiceService? by lazy {
    val ctx = appContext.reactContext ?: return@lazy null
    // Named argument deliberately: the last parameter is the decoder factory, so a trailing
    // lambda here would silently bind to the wrong seam.
    expo.modules.ffsble.voice.VoiceService(
      context = ctx,
      // BOTH sinks on purpose. The JS event is what the app UI shows; the logcat line is what
      // is readable from a shell during an on-glass test, and a pipeline whose only voice is a
      // JS event is a pipeline you cannot debug when JS is not attached. Counts only, either
      // way -- VoiceService and its parts never put a transcript in a log line.
      log = { message ->
        android.util.Log.i(VOICE_TAG, message)
        sendEvent("onLog", mapOf("message" to message))
      }
    )
  }

  /**
   * LIVE TRANSCRIPTION ON GLASS. Mirrors each transcript that lands onto the on-glass reader
   * app (`g2flash/apps/livetext.c`, app_id 14) over the FFSC data channel, so the whole loop
   * is glasses -> phone -> STT -> phone -> glasses with no PC in it.
   *
   * ⛔ The sink logs COUNTS only; the words go to the face and to the index, nowhere else.
   */
  private val liveText: expo.modules.ffsble.voice.LiveTextSink by lazy {
    expo.modules.ffsble.voice.LiveTextSink(
      send = { frame ->
        ensureCentral()?.pushToService(
          expo.modules.ffsble.voice.FfscFrame.SID_FXP1,
          android.util.Base64.encodeToString(frame, android.util.Base64.NO_WRAP)
        )
      },
      log = { message ->
        android.util.Log.i(VOICE_TAG, message)
        sendEvent("onLog", mapOf("message" to message))
      }
    )
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
      "onGlassesEvent",
      // Raw inbound frames (any service) for the TypeScript SDK's own decoders.
      "onServiceRaw",
      // Debug-only: boot/stop the TypeScript mini-OS from an adb broadcast.
      "onOsCommand",
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
      // The glasses opened their own microphone. Metadata only -- never audio.
      "onMicUnexpected"
    )

    // ---- persistent key/value (FUT-236) ----

    Function("getPref") { key: String ->
      prefs?.getString("ffs_pref_$key", null)
    }

    Function("setPref") { key: String, value: String ->
      prefs?.edit()?.putString("ffs_pref_$key", value)?.apply()
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

    // ---- session / info ----

    // FUT-169 / FUT-167: real battery %, charging, per-lens firmware version. Async via
    // `onDeviceInfo`. Connect the pair first.
    Function("requestDeviceInfo") { ensureCentral()?.requestDeviceInfo() }

    // FUT-269 dual-lens telemetry: request device info from ONE lens ("L"|"R"). Answer arrives via
    // `onDeviceInfo`, and every telemetry payload self-reports its lens, so a single-lens query
    // removes the deduped "whichever answered" ambiguity. See G2Central.requestDeviceInfoSide.
    Function("requestDeviceInfoSide") { side: String ->
      ensureCentral()?.requestDeviceInfoSide(G2Side.parse(side))
    }

    // Tear down the EvenHub session (stops the keep-alive heartbeat).
    Function("stopSession") { central?.stopSession() }

    // ---- payload delivery (FUT-216) ----

    Function("pushToService") { serviceId: Int, base64: String ->
      ensureCentral()?.pushToService(serviceId and 0xFF, base64)
    }

    // HUD brightness (sid 0x09). 0-100, nonlinear. autoAdjust hands control to the ambient-light
    // sensor -- pass false to hold a level for measurement.
    Function("setBrightness") { level: Int, autoAdjust: Boolean ->
      ensureCentral()?.setBrightness(level, autoAdjust)
    }

    Function("setSilentMode") { on: Boolean -> ensureCentral()?.setSilentMode(on) }
    Function("setWearDetection") { on: Boolean -> ensureCentral()?.setWearDetection(on) }
    Function("setLensOffset") { x: Int, y: Int -> ensureCentral()?.setLensOffset(x, y) }

    Function("querySettings") { brightnessOnly: Boolean ->
      ensureCentral()?.querySettings(brightnessOnly)
    }

    // ---- S-VOICE: capture -> archive -> transcribe -> search ----
    //
    // ⛔ The ONLY audio-adjacent things that cross this bridge are counts, session ids, and
    // transcript text the wearer asked for by typing a query. See docs/S-VOICE-PIPELINE.md.

    /**
     * Start capturing. Returns the session id. This starts the PHONE side only -- opening the
     * glasses' microphone is the on-glass stream's job, and the glasses can also open it on
     * their own (`onMicUnexpected`).
     */
    Function("voiceStart") { ensureCentral(); voice?.start() ?: "" }

    /** Stop capturing. The upload queue keeps running -- the last clips are still owed. */
    Function("voiceStop") { voice?.stop() }

    /** Counts and milliseconds only. Safe to render, safe to log. */
    Function("voiceStatus") { voice?.status() ?: mapOf("running" to false) }

    /**
     * Full-text search over the permanent archive. Returns the matching transcript spans --
     * this is the wearer asking to read their own archive, which is the whole point of it.
     */
    Function("voiceSearch") { query: String, limit: Int ->
      (voice?.search(query, limit) ?: emptyList()).map { hit ->
        mapOf(
          "sessionId" to hit.segment.sessionId,
          "startMs" to hit.segment.startMs,
          "endMs" to hit.segment.endMs,
          "text" to hit.segment.text,
          "snippet" to hit.snippet,
          "provider" to hit.segment.provider,
          "confidence" to hit.segment.confidence,
          "sessionStartedAt" to hit.sessionStartedAtEpochMs
        )
      }
    }

    /** Every session ever recorded, newest first. Nothing is ever deleted. */
    Function("voiceSessions") { limit: Int ->
      (voice?.sessions(limit) ?: emptyList()).map { s ->
        mapOf(
          "id" to s.id,
          "startedAt" to s.startedAtEpochMs,
          "endedAt" to s.endedAtEpochMs,
          "packets" to s.packets,
          "durationMs" to s.durationMs
        )
      }
    }

    /**
     * Write the STT provider configuration (a JSON document -- see docs/S-VOICE-STT-PROVIDER.md).
     *
     * ⛔ This is where a credential enters the app. It is written to app-private storage and is
     * NEVER logged, never echoed back by `voiceGetSttConfig`, and never committed. Passing an
     * empty string clears the configuration back to "archive but do not transcribe".
     */
    Function("voiceSetSttConfig") { json: String ->
      val v = voice ?: return@Function false
      v.configStore.save(expo.modules.ffsble.voice.SttConfig.fromJson(json))
      true
    }

    /** The configuration in force, with every header value REDACTED. */
    Function("voiceGetSttConfig") { voice?.configStore?.load()?.toString() ?: "none" }

    /**
     * Which arm to capture from. Defaults to "L".
     *
     * ★ The RIGHT arm's encoder runs and ships ~20 packets/s of statistically pure noise
     * (`[proven]` on hardware 2026-08-23), so a right-arm capture looks perfectly healthy and
     * decodes to nothing. Read `VoiceService.DEFAULT_CAPTURE_SIDE` before setting this to "R".
     */
    Function("voiceSetCaptureSide") { side: String -> voice?.captureSide = side; side }

    /**
     * ⛔ DEBUG: copy a session's raw master (and a decoded WAV) to the app's EXTERNAL files
     * directory so it can be `adb pull`ed. This moves a RECORDING somewhere less private, on
     * purpose and only when asked. Pass "" for the most recent session. Returns the paths.
     */
    Function("voiceExport") { sessionId: String ->
      val v = voice
      val id = if (sessionId.isNotBlank()) sessionId else v?.latestSessionId()
      if (v == null || id == null) emptyList() else v.exportSession(id)
    }

    // ---- test affordance ----

    /**
     * Inject a synthetic gesture so the input -> render path can be driven without a finger on
     * the temple pad or the ring. `device` is "glasses" or "ring". Every injection logs
     * "SIMULATED": it exercises decode, nav and render for real, but proves nothing about
     * whether a real touch reaches us -- see the note on G2Central.simulateGesture.
     */
    Function("simulateGesture") { device: String, gesture: String ->
      if (device.lowercase() == "glasses") {
        ensureCentral()?.simulateGesture(gesture)
      } else {
        sendEvent(
          "onLog",
          mapOf("message" to "[android] simulateGesture: only 'glasses' supported (ring quarantined), got '$device'")
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

    // ---- fb_shot: write assembled A4 screenshot to the app's files dir ----

    /**
     * Decode `base64` of the assembled A4 framebuffer (82944 B raw) and write it to the app's
     * internal files dir as `fbshot.a4`, overwriting. The dev machine pulls it via `adb pull` and
     * reconstructs the PNG with `g2flash/tools/fb_shot.py --raw-a4`.
     *
     * This is a developer instrument — not a user-facing feature — so it writes unconditionally
     * and logs the path.
     */
    Function("writeFbShot") { base64: String ->
      val bytes = try {
        android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        sendEvent("onLog", mapOf("message" to "[android] writeFbShot: bad base64 ($e)"))
        return@Function
      }
      val ctx = appContext.reactContext ?: return@Function
      val file = java.io.File(ctx.filesDir, "fbshot.a4")
      try {
        file.writeBytes(bytes)
        sendEvent(
          "onLog",
          mapOf("message" to "[android] writeFbShot: wrote ${bytes.size} bytes to ${file.absolutePath}")
        )
      } catch (e: Exception) {
        sendEvent("onLog", mapOf("message" to "[android] writeFbShot: write failed ($e)"))
      }
    }

    OnCreate { registerSimulationReceiver() }

    OnDestroy {
      unregisterSimulationReceiver()
      central?.shutdown()
      central = null
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
  /**
   * Say something about a VOICE command, on BOTH channels.
   *
   * ⚠️ `sendEvent` alone is not enough for this one. Every other adb affordance here is fired by
   * somebody already watching the app; a VOICE capture is fired by somebody who then has to know
   * WHEN it is safe to `adb pull`, and the JS bridge is exactly the part that may not be running
   * (no React context yet, a reloading bundle, the app backgrounded). So the same line also goes
   * to logcat under a fixed tag, which needs nothing but adb:
   *
   * ```sh
   *   adb logcat -s FFSVOICE:V
   * ```
   *
   * ⛔ PRIVACY: callers pass counts, ids and paths. No audio, no PCM, no transcript text ever
   * reaches this method -- see VoiceService's logging contract.
   */
  private fun voiceReport(message: String) {
    android.util.Log.i(VOICE_TAG, message)
    try {
      sendEvent("onLog", mapOf("message" to "[android] $message"))
    } catch (_: Throwable) {
      // No React context / no listener. The logcat line above is the one that always lands.
    }
  }

  private fun registerSimulationReceiver() {
    val context = appContext.reactContext ?: return
    val debuggable =
      (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debuggable) return

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        when (intent?.action) {
          SIMULATE_ACTION -> {
            val gesture = intent.getStringExtra("gesture") ?: return
            ensureCentral()?.simulateGesture(gesture)
          }
          // Drives the OTA flasher from adb so the flash loop needs no UI navigation. Every
          // refusal gate in G2Flasher still applies -- this only chooses WHEN to run the chain,
          // never what it is allowed to accept. `dry` defaults to TRUE: the destructive form
          // has to be asked for explicitly, so a malformed command validates instead of writes.
          FLASH_ACTION -> {
            // `path` (a local file pushed via `adb push`) is the simple loop -- no HTTP server,
            // no adb reverse. `url` (http://...) still works for the legacy served path.
            val url = intent.getStringExtra("path") ?: intent.getStringExtra("url") ?: return
            val sha = intent.getStringExtra("sha") ?: return
            val dry = intent.getBooleanExtra("dry", true)
            // Convenience override: flash a SHA-verified, brick-guard-passing image whose golden
            // isn't pre-registered in G2Flash. Decouples firmware iteration from an APK rebuild.
            // SHA-match + MRAM brick-guard still apply; only the known-golden allowlist is waived.
            val allowUnknownGolden = intent.getBooleanExtra("allowUnknownGolden", false)
            sendEvent(
              "onLog",
              mapOf("message" to "[android] debug flash request: dry=$dry allowUnknownGolden=$allowUnknownGolden sha=${sha.take(12)}... src=$url")
            )
            ensureCentral()?.startCfwFlash(url, sha, dry, allowUnknownGolden)
          }
          "connect" -> ensureCentral()?.connectPair()
          // Push an FXP1-framed native payload to the resident CFW loader. This is what makes
          // payload iteration scriptable: build with `ffs-sdk pack`, broadcast the base64, read
          // the result out of the next device-info ⟨LOADER … ret=0x…⟩ line. Without it every
          // probe needs the payload baked into a JS release first.
          PUSH_ACTION -> {
            val b64 = intent.getStringExtra("b64") ?: return
            // Deliver the FXP1-framed bytes as a plain transport message on a custom service id
            // (default 0x90). The CFW's FXP1 gate (ffs_msgrx_gate) reassembles it and hands it to
            // cfw_loader_ingest BEFORE any page exists -- the page-independent route, proven
            // on-glass. The legacy EvenHub image-container route (`--es via svc` off) was retired
            // with the render machinery (2026-08-22); `sid` still overrides the service id.
            //   am broadcast -a com.futurefounders.ffs.PUSH_PAYLOAD --es b64 <b64> [--ei sid 144] -p <pkg>
            val sid = intent.getIntExtra("sid", 0x90)
            sendEvent(
              "onLog",
              mapOf("message" to "[android] debug payload push: ${b64.length} b64 chars via svc 0x${sid.toString(16)}")
            )
            ensureCentral()?.pushToService(sid, b64)
          }
          // Ask the glasses for battery/firmware/CFW-loader diagnostics. The ⟨LOADER⟩ block in
          // the reply is how a pushed payload reports its ret= value back.
          // `--es side L` (or R) addresses ONE lens, so its side-tagged answer is unambiguous.
          // Without it the request goes to BOTH and, historically, only the right lens was ever
          // seen answering -- which left the LEFT lens unobservable from this machine and is why
          // two per-lens bugs could only be found by wearing the glasses. Every field we now ride
          // in this reply (lens=, dash=, apps=, run=, src=, live=) is PER-LENS.
          //   adb shell am broadcast -a com.futurefounders.ffs.DEVICE_INFO --es side L -p <pkg>
          INFO_ACTION -> {
            val side = intent.getStringExtra("side")
            if (side.isNullOrBlank()) ensureCentral()?.requestDeviceInfo()
            else ensureCentral()?.requestDeviceInfoSide(G2Side.parse(side))
          }
          // HUD brightness. Also an INSTRUMENT control: a dimmer HUD is much easier for the
          // phone camera to focus on, so this is used to set up every visual proof.
          //   adb shell am broadcast -a com.futurefounders.ffs.BRIGHTNESS --ei level 20 -p <pkg>
          // Generic settings poke, so every sid-0x09 setter can be proven WITHOUT a camera:
          // set a non-zero value, then read the snapshot back and compare.
          //   am broadcast -a com.futurefounders.ffs.SETTING --es key silent --ei value 1
          SETTING_ACTION -> {
            val key = intent.getStringExtra("key") ?: return
            val value = intent.getIntExtra("value", 0)
            sendEvent("onLog", mapOf("message" to "[android] debug setting: $key=$value"))
            val c = ensureCentral()
            when (key.lowercase()) {
              // A read of the FULL snapshot. `--ei value 1` = APP_REQUIRE_BASIC_SETTING, which is
              // the one that carries silent / wear / head-up / lens x,y. value 0 is
              // APP_REQUIRE_BRIGHTNESS_INFO and returns only the brightness block -- asking for
              // that and then wondering why `silent` reads null costs a whole verification cycle.
              "query" -> c?.querySettings(value == 0)
              // (render probes image/geo/header/swirl retired 2026-08-22 with the render machinery)
              // Start/stop the head-motion (IMU) stream -- EvenHub Cmd 19, the one message that
              // opens the sensor hub. value 1 = start, 0 = stop. `--ei hz <pace>` overrides the
              // report pace; it is an ImuReportPace CODE (100..1000 step 100), NOT literal Hz,
              // so the default is 100 rather than a plausible-looking 50.
              //   am broadcast -a com.futurefounders.ffs.SETTING --es key imu --ei value 1
              "imu" -> c?.setImuStream(value != 0, intent.getIntExtra("hz", 100))
              // ⛔ START/STOP THE MICROPHONE. value 1 = open, 0 = close.
              //   am broadcast -a com.futurefounders.ffs.SETTING --es key mic --ei value 1
              // `--ei cmd15 1` ALSO sends EvenHub Cmd 15/field 18 alongside, for comparing the
              // secondary route; leave it off unless that is what you are testing.
              // The proven opener is the even_ai CTRL ENTER this sends by default -- see
              // G2Central.setMicStream for the log evidence.
              // ⚠️ ALWAYS follow with value 0. The DMIC pair stays powered otherwise.
              // `--ei noai 1` SKIPS the EvenAI CTRL ENTER (the on-glass swirl popup) and relies on
              // AudioControl alone (use with cmd15 1) -- the no-swirl acquisition test.
              "mic" -> c?.setMicStream(
                value != 0,
                intent.getIntExtra("cmd15", 0) != 0,
                evenAi = intent.getIntExtra("noai", 0) == 0
              )
              // Mic packet counters -- COUNTS AND MILLISECONDS ONLY, never audio. This is the
              // whole instrument for "did packets flow?", and it is numeric on purpose.
              //   am broadcast -a com.futurefounders.ffs.SETTING --es key micstats
              "micstats" -> c?.micLogStats()
              "micreset" -> c?.micResetStats()
              // In-place text update (Cmd 5). `text` is the new content; `value` the container id
              // (default 1 = the SDK's header container).
              "uptext" -> c?.updateTextContainer(
                if (value == 0) 1 else value,
                intent.getStringExtra("text") ?: "UPDATED"
              )
              // PANIC RESET -- reboot the glasses when the BLE receive path is too starved to
              // accept anything else, including a reboot payload. Costs the device nothing but
              // volatile state; it re-pairs on its own in ~30-40 s. See G2Setting.panicReset.
              //   am broadcast -a com.futurefounders.ffs.SETTING --es key panic --ei value 1
              // `--es token <12 chars>` overrides the marker. A WRONG marker is the negative
              // control for the recovery drill: it must reach the device and do nothing, which
              // is what proves a reset seen after the real marker came from our gate and not
              // from a coincidental reboot. Do not "simplify" it away.
              "panic" -> c?.panicReset(intent.getStringExtra("token") ?: G2Setting.PANIC_TOKEN)
              "silent" -> c?.setSilentMode(value != 0)
              "wear" -> c?.setWearDetection(value != 0)
              "lensx" -> c?.setLensOffset(value, null)
              "lensy" -> c?.setLensOffset(null, value)
              else -> sendEvent("onLog", mapOf("message" to "[android] unknown setting key: $key"))
            }
          }
          BRIGHTNESS_ACTION -> {
            val level = intent.getIntExtra("level", -1)
            if (level < 0) {
              ensureCentral()?.querySettings(true)
            } else {
              val auto = intent.getBooleanExtra("auto", false)
              sendEvent("onLog", mapOf("message" to "[android] debug brightness: level=$level auto=$auto"))
              ensureCentral()?.setBrightness(level, auto)
            }
          }
          // Drive the TypeScript mini-OS. Unlike every other action here this one does NOT touch
          // the driver -- it just forwards the command to JS, because the OS lives entirely in
          // the SDK and the driver is only its transport.
          OS_ACTION -> {
            val cmd = intent.getStringExtra("cmd") ?: "boot"
            sendEvent("onOsCommand", mapOf("cmd" to cmd))
          }
          // ⛔ S-VOICE CAPTURE. THIS TURNS ON A MICROPHONE. Debug builds only, off by default,
          // and every sub-command has to be asked for by name.
          //
          //   adb shell am broadcast -a com.futurefounders.ffs.VOICE --es cmd start \
          //     -p com.futurefounders.glassesos
          //   adb shell am broadcast -a com.futurefounders.ffs.VOICE --es cmd status ...
          //   adb shell am broadcast -a com.futurefounders.ffs.VOICE --es cmd stop ...
          //   adb shell am broadcast -a com.futurefounders.ffs.VOICE --es cmd export ...
          //   adb pull /sdcard/Android/data/com.futurefounders.glassesos/files/voice-export/
          //
          // `--es side R` on `start` overrides the left-arm default -- read
          // VoiceService.DEFAULT_CAPTURE_SIDE before you do, because the right arm ships
          // healthy-looking noise and it will read as a decoder bug.
          VOICE_ACTION -> {
            val v = voice
            if (v == null) {
              voiceReport("VOICE: no React context yet")
            } else when (intent.getStringExtra("cmd") ?: "status") {
              "start" -> {
                intent.getStringExtra("side")?.let { v.captureSide = it }
                ensureCentral()
                // `--es live 0` captures and archives without painting the words on the face.
                if (intent.getStringExtra("live") == "0") {
                  v.onTranscript = null
                  v.onLiveText = null
                } else {
                  liveText.reset()
                  liveText.start()
                  // WORD-BY-WORD when a streaming endpoint is configured: revisions replace the
                  // tail, settled text appends. Fired on the websocket thread -- the sink only
                  // sets state and wakes its own pusher, so this never blocks the socket.
                  v.onLiveText = { text, settled ->
                    if (settled) liveText.commit(text) else liveText.setPending(text)
                  }
                  // The durable path still feeds the face when streaming is NOT configured, so
                  // a phone with only a batch endpoint still shows the words -- a sentence at a
                  // time instead of a word at a time. With streaming on, the socket has already
                  // committed the same text and the sink's identical-bytes check drops it.
                  v.onTranscript = { _, text ->
                    if (!v.streamingConfigured) liveText.commit(text)
                  }
                }
                val id = v.start()
                voiceReport("VOICE capture STARTED session=$id side=${v.captureSide} live=${v.onLiveText != null} streaming=${v.streamingConfigured}")
              }
              // Wipe the face without touching the archive.
              "clear" -> {
                liveText.reset()
                voiceReport("VOICE livetext cleared")
              }
              "stop" -> {
                v.stop()
                // After v.stop(), so the socket's last words are on the face before it parks.
                liveText.stop()
                voiceReport("VOICE capture stopped -- ${v.status()}")
              }
              "status" -> voiceReport("VOICE ${v.status()}")
              "export" -> {
                val id = intent.getStringExtra("session") ?: v.latestSessionId()
                if (id == null) {
                  voiceReport("VOICE export: no session on disk")
                } else {
                  val paths = v.exportSession(id)
                  voiceReport("VOICE exported ${paths.size} file(s): ${paths.joinToString(" ")}")
                }
              }
              else -> voiceReport("VOICE: cmd must be start|stop|status|export|clear")
            }
          }
          // Replay a captured inbound event vector. Synthetic INPUT, real RENDER -- see
          // G2Central.injectInboundEvenHub for exactly what that does and does not prove.
          INJECT_ACTION -> {
            val b64 = intent.getStringExtra("b64")
            if (b64 == null) {
              sendEvent("onLog", mapOf("message" to "[android] INJECT needs --es b64 <payload>"))
            } else {
              ensureCentral()?.injectInboundEvenHub(b64)
            }
          }
        }
      }
    }
    val filter = IntentFilter(SIMULATE_ACTION).apply {
      addAction(FLASH_ACTION)
      addAction(PUSH_ACTION)
      addAction(INFO_ACTION)
      addAction(BRIGHTNESS_ACTION)
      addAction(SETTING_ACTION)
      addAction(OS_ACTION)
      addAction(INJECT_ACTION)
      addAction(VOICE_ACTION)
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
    const val BRIGHTNESS_ACTION = "com.futurefounders.ffs.BRIGHTNESS"
    const val SETTING_ACTION = "com.futurefounders.ffs.SETTING"
    /** Boot/stop the TypeScript mini-OS: `--es cmd boot|stop`. */
    const val OS_ACTION = "com.futurefounders.ffs.OS"
    /** Replay a captured inbound event vector: `--es b64 <payload>`. */
    const val INJECT_ACTION = "com.futurefounders.ffs.INJECT"

    /**
     * S-VOICE capture control from adb. ⛔ DEBUG BUILDS ONLY (the receiver is only registered
     * when the app is debuggable) and capture is OFF until this asks for it -- this is a
     * microphone. See `docs/S-VOICE-PIPELINE.md`.
     */
    const val VOICE_ACTION = "com.futurefounders.ffs.VOICE"

    /** Fixed logcat tag for VOICE command feedback -- `adb logcat -s FFSVOICE:V`. */
    const val VOICE_TAG = "FFSVOICE"
    const val PUSH_ACTION = "com.futurefounders.ffs.PUSH_PAYLOAD"
    const val INFO_ACTION = "com.futurefounders.ffs.DEVICE_INFO"
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

    // S-VOICE. ⛔ THE ONE PLACE MICROPHONE AUDIO IS ALLOWED TO GO, and it goes there in NATIVE
    // code only: never base64, never a log line, never the JS bridge. `submit` is non-blocking
    // and hands the packet to the decode and archive threads. See G2Central.onAudioPacket and
    // docs/S-VOICE-PIPELINE.md.
    c.onAudioPacket = { raw, side -> voice?.submit(raw, side) }
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
    // THE RETURN PATH: a natively-owned on-glass screen reporting what the user chose.
    // eventType: 0 click, 1 scroll-top, 2 scroll-bottom, 3 double-click, 4/5 fg enter/exit,
    // 6 abnormal-exit, 7 system-exit.  eventSource: 1 glasses-R, 2 ring, 3 glasses-L.
    c.onGlassesEvent = { kind, containerId, containerName, itemIndex, itemName, eventType, eventSource ->
      sendEvent(
        "onGlassesEvent",
        mapOf(
          "kind" to kind,
          "containerId" to containerId,
          "containerName" to containerName,
          "itemIndex" to itemIndex,
          "itemName" to itemName,
          "eventType" to eventType,
          "eventSource" to eventSource
        )
      )
    }
    // The SDK's inbound half: raw, uninterpreted payloads, tagged with their service id.
    c.onServiceRaw = { serviceId, base64 ->
      sendEvent("onServiceRaw", mapOf("serviceId" to serviceId, "payload" to base64))
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
    c.onMicUnexpected = { side, gapMs, requestedByUs ->
      sendEvent(
        "onMicUnexpected",
        mapOf("side" to side, "gapMs" to gapMs, "requestedByUs" to requestedByUs)
      )
    }
    c.onSubscribe = { side, characteristic, on ->
      sendEvent(
        "onSubscribe",
        mapOf("side" to side, "characteristic" to characteristic, "on" to on)
      )
    }

    central = c
    // AFTER the callbacks are wired, never from the constructor -- the driver's queue thread is
    // already running, so anything emitted during construction would race these assignments.
    c.start()
    return c
  }
}
