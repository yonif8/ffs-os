package expo.modules.ffsble

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * FfsBleModule — Android side of the FFS G2 BLE driver.
 *
 * This is the Android twin of `ios/FfsBleModule.swift` and MUST expose exactly the same
 * function and event names, because `src/FfsBleModule.ts` is the single typed contract
 * both platforms satisfy and the whole `src/os` TypeScript OS is written against it.
 * If you add a capability on one platform, add its binding on the other in the same
 * change — a missing name here is a runtime crash in shared JS, not a compile error.
 *
 * PHASE 0 (this file, current state): every binding exists and is safe to call, but the
 * radio is not implemented. Calls emit an `onLog` line saying so instead of throwing, so
 * the shared UI boots and is fully navigable on Android with a dead BLE layer. That is
 * deliberate: it proves the toolchain, the module registration and the JS contract before
 * any of the hard work, and it keeps `scripts/check-reachable.py`-style "the screen exists
 * but does nothing" failures visible rather than silent.
 *
 * `getPref`/`setPref` are real from day one — they are just SharedPreferences (the iOS side
 * uses UserDefaults), the calibration flow depends on them across launches, and there is no
 * reason to stub something this cheap.
 *
 * PHASE 1 (next): a real `G2Central` written directly against android.bluetooth, replacing
 * these stubs from `startScan` down through `showText`. Notes for whoever writes it — the
 * places where Android genuinely differs from the proven CoreBluetooth driver:
 *   - MTU is explicit here (`BluetoothGatt.requestMtu`); iOS negotiates it for you.
 *   - There is no `canSendWriteWithoutResponse` back-pressure signal. On API 33+ the new
 *     `writeCharacteristic(char, value, writeType)` overload returns a status int instead.
 *     G2Central.swift's 6 ms paced FIFO drain was tuned against the iOS signal and will
 *     need re-tuning against whatever Android actually gives us.
 *   - Two simultaneous GATT links (L + R lenses) are scheduled differently here.
 * Per cardinal rule #1, none of that counts until it is seen working on the glasses.
 */
class FfsBleModule : Module() {

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
      // R1 ring (FUT-233).
      "onRingConnected",
      "onRingDisconnected",
      "onRingRaw",
      "onRingBattery"
    )

    // ---- persistent key/value (real) ----

    Function("getPref") { key: String ->
      prefs?.getString("ffs_pref_$key", null)
    }

    Function("setPref") { key: String, value: String ->
      prefs?.edit()?.putString("ffs_pref_$key", value)?.apply()
    }

    // ---- R1 ring (FUT-233) — Phase 3 ----

    Function("ringScan") { notYet("ringScan") }
    Function("ringStopScan") { notYet("ringStopScan") }
    Function("ringDisconnect") { notYet("ringDisconnect") }
    Function("ringForget") { notYet("ringForget") }
    Function("ringReadBattery") { notYet("ringReadBattery") }
    Function("ringConnectToGlasses") { _: String ->
      notYet("ringConnectToGlasses")
      false
    }

    // ---- glasses link (Phase 1) ----

    Function("startScan") { notYet("startScan") }
    Function("stopScan") { notYet("stopScan") }
    Function("connect") { notYet("connect") }
    Function("connectSide") { _: String -> notYet("connectSide") }
    Function("disconnect") { notYet("disconnect") }

    Function("isPairReady") {
      // No log line: the JS polls this, and logging every poll would flood the sink.
      false
    }
    Function("isSideReady") { _: String -> false }

    // ---- render (Phase 1 for text, Phase 2/3 for pixels) ----

    Function("showText") { _: String -> notYet("showText") }
    Function("showImage") { notYet("showImage") }
    Function("showAiSwirl") { _: Boolean -> notYet("showAiSwirl") }
    Function("playAnimation") { _: String -> notYet("playAnimation") }
    Function("stopAnimation") { notYet("stopAnimation") }

    // ---- dashboards (Phase 3) ----

    Function("pushDashboardDemo") { _: String -> notYet("pushDashboardDemo") }
    Function("showStockDashboard") { notYet("showStockDashboard") }
    Function("showNativeDashboard") { _: String -> notYet("showNativeDashboard") }
    Function("showDashboard") { notYet("showDashboard") }
    Function("hideDashboard") { notYet("hideDashboard") }
    Function("dashboardInput") { _: String -> notYet("dashboardInput") }
    Function("setDashboardData") { _: String -> notYet("setDashboardData") }

    // ---- session / info ----

    Function("requestDeviceInfo") { notYet("requestDeviceInfo") }
    Function("stopSession") { notYet("stopSession") }

    // ---- payload delivery (FUT-216) — Phase 2 ----

    Function("pushToService") { _: Int, _: String -> notYet("pushToService") }
    Function("pushPayloadViaImage") { _: String -> notYet("pushPayloadViaImage") }

    // ---- flashing (FUT-167) — Phase 4, deliberately LAST ----
    //
    // A botched DFU over an unproven BLE stack bricks the glasses. These stay stubbed
    // until the Phase 1-3 link is boringly stable; flash from the iOS app until then.

    Function("flashDryRun") { notYet("flashDryRun") }
    Function("startCfwFlash") { _: String, _: String, _: Boolean -> notYet("startCfwFlash") }
  }

  /**
   * Report an unimplemented binding to the JS log sink instead of throwing. The shared UI
   * calls these from button handlers; a throw would surface as a redbox and stop the
   * Phase 0 goal (a fully navigable app on Android) dead.
   */
  private fun notYet(name: String) {
    sendEvent("onLog", mapOf("message" to "[android] $name: not implemented yet (Phase 0 stub)"))
  }
}
