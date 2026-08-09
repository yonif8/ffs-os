// Typed wrapper around the native FfsBleModule (Phase 2 dual-radio G2 BLE driver).
//
// The G2 is TWO independent BLE peripherals (left + right lens). This driver
// connects BOTH and coordinates them. Events are side-aware; `onPairReady`
// fires when both lenses are up with their required characteristics.
//
// Portions of the BLE protocol this binds to are derived from MentraOS (MIT).
// This TS layer is original FFS code.

import { requireNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

// ---- Event payload types --------------------------------------------------

/** A physical lens side, as identified from the peripheral name. */
export type G2Side = "L" | "R" | "?";

export interface OnLogEvent {
  /** Already timestamped (ISO8601 + millis) by the native layer. */
  message: string;
}

export interface OnStateChangeEvent {
  /** CBManagerState description, e.g. "poweredOn" | "poweredOff" | ... */
  state: string;
}

export interface OnDeviceFoundEvent {
  /** Advertised name, e.g. "Even G2_XX_L_XXXXXX" or "EVEN R1_XXXXXX". */
  name: string;
  /** A lens side, or "ring" for an R1 discovered by the ring scan (FUT-233). */
  side: G2Side | "ring";
  rssi: number;
  /** 14-char serial from manufacturer data, if present. Always null for the ring. */
  sn: string | null;
  /** "AA:BB:CC:DD:EE:FF" big-endian, if present. Always null for the ring. */
  mac: string | null;
}

export interface OnConnectedEvent {
  name: string;
  /** Which lens finished connecting. */
  side: G2Side;
}

export interface OnServicesDiscoveredEvent {
  /** Which lens's characteristics these are. */
  side: G2Side;
  /** Full UUIDs of the write/notify/audio characteristics we matched. */
  characteristics: string[];
}

/**
 * Both lenses are connected AND their required characteristics are bound.
 * Carries no payload — call `isPairReady()` / `isSideReady()` for detail.
 */
export type OnPairReadyEvent = Record<string, never>;

export interface OnNotifyEvent {
  /** Base64-encoded notification payload. */
  base64: string;
  /** Full UUID of the characteristic that fired. */
  characteristic: string;
  /**
   * Which lens the notification came from. Protocol/ACK notifications arrive on
   * the RIGHT lens; the LEFT arm is silent on async events (FUT-159).
   */
  side: G2Side;
}

/** A decoded touch gesture from the glasses. */
export type G2GestureName = "tap" | "double_tap" | "swipe_up" | "swipe_down";

/**
 * The R1 ring's five discrete gestures (FUT-233).
 * ⚠️ There is NO rotary/scroll wheel on the ring — do not design a scroll-wheel UX.
 */
export type R1GestureName =
  | "hold"
  | "single_tap"
  | "double_tap"
  | "swipe_up"
  | "swipe_down";

export interface OnGestureEvent {
  gesture: G2GestureName | R1GestureName;
  /** Which lens's touchpad it came from, or "ring". */
  side: G2Side | "ring";
  /** Which physical device produced it. The ring is the SDK's input device. */
  device: "glasses" | "ring";
  /**
   * Glasses only, and often null: the firmware's `eventSource` — 1 and 3 are the
   * temple touchpads, 2 is believed to be the ring but has never been observed.
   * ALWAYS null for taps on text/list containers, which carry no such field, and
   * always null for ring events (they don't traverse the firmware at all).
   */
  source: number | null;
  /** Ring only: the raw `FF tt pp` frame that produced this gesture. */
  raw?: string;
}

/**
 * Collapse any input event — glasses touchpad OR R1 ring — into the single nav
 * vocabulary the OS navigates with, or null if it has no navigation meaning.
 *
 * This is the seam that makes the input-route pivot invisible to the UI: the ring
 * became the input device, but navigation code keeps speaking one language. The
 * ring's `single_tap` IS the glasses' `tap`.
 *
 * ⚠️ `hold` returns null BY DESIGN, and must stay that way (Yoni, 2026-07-28):
 * **`double_tap` is BACK** — verified, it routes to `back()` in every branch of
 * `nav.handleGesture` — so hold is NOT a back button and must not be mapped to one.
 * Hold is deliberately RESERVED for special, context-dependent actions per screen,
 * which is why it is kept out of the global nav vocabulary rather than given a
 * default. A screen that wants hold should handle the raw `onGesture` itself.
 */
export function toNavGesture(g: OnGestureEvent): G2GestureName | null {
  switch (g.gesture) {
    case "tap":
    case "single_tap":
      return "tap";
    case "double_tap":
      return "double_tap";
    case "swipe_up":
      return "swipe_up";
    case "swipe_down":
      return "swipe_down";
    case "hold":
      return null;
    default:
      return null;
  }
}

export interface OnRingConnectedEvent {
  name: string;
}

export interface OnRingDisconnectedEvent {
  reason: string | null;
}

/**
 * EVERY inbound ring frame, decoded or not — deliberately unfiltered, because the
 * open question is which gestures the phone link actually carries (MentraOS parses
 * all five; openCFW's capture saw only hold + double-tap reach the phone).
 */
export interface OnRingRawEvent {
  /** First 8 chars of the characteristic UUID that fired. */
  characteristic: string;
  /** Space-separated uppercase hex. */
  hex: string;
}

export interface OnRingBatteryEvent {
  /** 0–100. */
  battery: number;
}

/**
 * Real device info read back from the glasses (FUT-169 battery + FUT-167 canary
 * firmware-version read-back). Any field may be null if the glasses omitted it. Battery
 * is an aggregate 0–100; versions are per-lens firmware strings (e.g. "2.2.6.10").
 */
export interface OnDeviceInfoEvent {
  leftVersion: string | null;
  rightVersion: string | null;
  battery: number | null;
  charging: boolean | null;
}

export interface OnDisconnectedEvent {
  name: string;
  /** Which lens dropped. The other lens's state is unaffected. */
  side: G2Side;
  reason: string | null;
  /**
   * FUT-253: the raw CBError/NSError code (0 = a clean, error-free disconnect;
   * nonzero = involuntary drop, e.g. 0x06 supervision-timeout vs 0x13 remote-terminated).
   */
  code: number;
  /** FUT-253: the NSError domain the code belongs to (e.g. "CBErrorDomain"). */
  domain: string;
}

// ---- FUT-253 native BLE observability (Step 3) ---------------------------

/** Live connected-RSSI reading, polled per side in the 5s heartbeat. */
export interface OnRssiEvent {
  side: G2Side;
  /** dBm; more negative = weaker. */
  rssi: number;
}

/** The ATT write-without-response payload ceiling for a side, read once at char-bind. */
export interface OnMtuEvent {
  side: G2Side;
  /** Max bytes per write-without-response packet. */
  mtu: number;
}

/** A connect ATTEMPT failed (distinct from a drop of an established link). */
export interface OnConnectFailedEvent {
  side: G2Side;
  /** Raw CBError/NSError code (-1 if the error was absent). */
  code: number;
  /** NSError domain (e.g. "CBErrorDomain"). */
  domain: string;
  /** Human-readable localizedDescription. */
  desc: string;
}

/**
 * Write-drain throughput meter, emitted per side on a fixed ~1s interval (never per
 * write) while a side has traffic or a backlog. Idle sides emit nothing.
 */
export interface OnTxMeterEvent {
  side: G2Side;
  /** Bytes written in this interval. */
  bytes: number;
  /** Packets written in this interval. */
  pkts: number;
  /** Current write-queue depth at tick time (backpressure indicator). */
  queueDepth: number;
}

/** The write-without-response buffer saturated; the paced drain has paused. */
export interface OnTxStallEvent {
  side: G2Side;
  queueDepth: number;
}

/** The write buffer drained and the paused drain resumed. */
export interface OnTxResumeEvent {
  side: G2Side;
  queueDepth: number;
}

/** A notify-subscription state change (promoted from the free-text log). */
export interface OnSubscribeEvent {
  side: G2Side;
  /** Full UUID of the characteristic whose notify state changed. */
  characteristic: string;
  /** true = subscribed (notifying), false = unsubscribed. */
  on: boolean;
}

/** An image-fragment ACK resolved or timed out (render-pipeline signal, FUT-249). */
export interface OnImgAckEvent {
  session: number;
  fragment: number;
  /** Whether the fragment was acknowledged successfully. */
  ok: boolean;
  /** true if this fired from the ACK timeout rather than a real ack. */
  timedOut: boolean;
}

/** Result of the zero-write flash-channel probe (FUT-167 Stage 1). */
export interface OnFlashProbeEvent {
  /** All 4 OTA flash characteristics present on the LEFT lens. */
  leftReady: boolean;
  /** All 4 OTA flash characteristics present on the RIGHT lens. */
  rightReady: boolean;
  /** Human-readable per-lens detail. */
  detail: string;
}

/** CFW flash / validate progress (FUT-167 Stage 2). */
export interface OnFlashProgressEvent {
  message: string;
  /** 0…1. */
  progress: number;
  /** Terminal event (success or failure). */
  done: boolean;
  /** Whether the (terminal) result was a success. */
  ok: boolean;
}

/**
 * THE RETURN PATH: a natively-owned on-glass screen reporting what the user chose.
 * Fires without the phone driving the interaction — the firmware's own list engine
 * handles the scroll and only reports the outcome.
 */
export interface OnGlassesEvent {
  /** Which shape of report this is (the container/event family). */
  kind: string;
  containerId: number | null;
  containerName: string | null;
  /** Index of the selected row within its container. */
  itemIndex: number | null;
  itemName: string | null;
  /** 0 click, 1 scroll-top, 2 scroll-bottom, 3 double-click, 4/5 fg enter/exit, 6 abnormal-exit, 7 system-exit. */
  eventType: number | null;
  /** 1 glasses-R, 2 ring, 3 glasses-L. */
  eventSource: number | null;
}

/**
 * A raw, uninterpreted inbound payload — the TypeScript SDK's inbound transport.
 *
 * Every reassembled frame from EVERY service arrives here regardless of what the native decoders
 * made of it, so the SDK's own decoders (unit-tested against captured byte vectors) run against
 * live hardware bytes rather than trusting the Kotlin ones.
 *
 * ⚠️ Filter on `serviceId`. The SDK needs more than one: pages and events are EvenHub (0xE0)
 * while settings snapshots are 0x09. Listening to everything and assuming EvenHub is how the
 * settings reader silently starved and the Device screen showed "--" forever.
 */
export interface OnServiceRawEvent {
  /** 0xE0 EvenHub, 0x09 settings, … */
  serviceId: number;
  /** base64, NO_WRAP. */
  payload: string;
}

/** Debug-only: drive the TypeScript mini-OS from an adb broadcast. */
export interface OnOsCommandEvent {
  /** "boot" | "stop". */
  cmd: string;
}

/** Map of event name → payload type. */
export interface FfsBleEvents {
  onLog: OnLogEvent;
  onStateChange: OnStateChangeEvent;
  onDeviceFound: OnDeviceFoundEvent;
  onConnected: OnConnectedEvent;
  onServicesDiscovered: OnServicesDiscoveredEvent;
  onPairReady: OnPairReadyEvent;
  onNotify: OnNotifyEvent;
  onGesture: OnGestureEvent;
  onDeviceInfo: OnDeviceInfoEvent;
  onDisconnected: OnDisconnectedEvent;
  onFlashProbe: OnFlashProbeEvent;
  onFlashProgress: OnFlashProgressEvent;
  // FUT-253 native BLE observability (Step 3).
  onRssi: OnRssiEvent;
  onMtu: OnMtuEvent;
  onConnectFailed: OnConnectFailedEvent;
  onTxMeter: OnTxMeterEvent;
  onTxStall: OnTxStallEvent;
  onTxResume: OnTxResumeEvent;
  onSubscribe: OnSubscribeEvent;
  onImgAck: OnImgAckEvent;
  onGlassesEvent: OnGlassesEvent;
  onServiceRaw: OnServiceRawEvent;
  onOsCommand: OnOsCommandEvent;
  onRingConnected: OnRingConnectedEvent;
  onRingDisconnected: OnRingDisconnectedEvent;
  onRingRaw: OnRingRawEvent;
  onRingBattery: OnRingBatteryEvent;
}

export type FfsBleEventName = keyof FfsBleEvents;

/** A connectable lens side (never "?"). */
export type G2ConnectSide = "L" | "R";

// ---- Native module shape --------------------------------------------------

interface FfsBleNativeModule {
  startScan(): void;
  stopScan(): void;
  /** Connect the PAIR — both lenses. Primary entry point. */
  connect(): void;
  /** Connect a SINGLE side only (testing convenience). */
  connectSide(side: G2ConnectSide): void;
  /** Disconnect both lenses. */
  disconnect(): void;
  /** True once BOTH lenses are connected + required characteristics discovered. */
  isPairReady(): boolean;
  /** Per-side readiness: connected + that side's required characteristics bound. */
  isSideReady(side: G2ConnectSide): boolean;
  /**
   * P3: run the auth handshake (if needed) then render `text` on the HUD — our
   * "first pixel" path. Connect the pair first (isPairReady() === true).
   */
  showText(text: string): void;
  /**
   * P4: render a test image on the HUD through our own raw-image path (FUT-153) —
   * creates an image container, waits ~700ms, streams a 4-bit BMP as ACK-gated
   * fragments. Connect the pair first (isPairReady() === true).
   */
  showImage(): void;
  /**
   * FUT-165: toggle the firmware's NATIVE "Even AI" swirl (GPU-smooth, dual-lens) by
   * driving the even_ai session lifecycle over BLE — no pixel streaming. `on` starts the
   * animation (CTRL ENTER + ASK), false stops it (CTRL EXIT). Connect the pair first.
   */
  showAiSwirl(on: boolean): void;
  /**
   * FUT-167 Stage 1: zero-write flash-channel probe. Confirms the OTA flash
   * characteristics are discoverable on both lenses (no writes). Result arrives via the
   * `onFlashProbe` event. Connect the pair first.
   */
  flashDryRun(): void;
  /**
   * FUT-167 Stage 2: CFW OTA flash. Downloads `url`, verifies `sha256`, runs the MRAM
   * brick-guard + golden-vector self-test, then flashes (dryRun=false) or stops before
   * any write (dryRun=true). Progress via `onFlashProgress`. The real write (dryRun
   * false) MUST be gated behind the warranty confirmation in the UI.
   */
  startCfwFlash(url: string, sha256: string, dryRun: boolean): void;
  /**
   * FUT-169 / FUT-167: request real device info (battery %, charging, per-lens firmware
   * version) from the glasses. The answer arrives via the `onDeviceInfo` event. Connect
   * the pair first. This is the real battery source (the HUD 82% was a stub) and the
   * canary flash's firmware-version read-back.
   */
  requestDeviceInfo(): void;
  /**
   * FUT-216: push an arbitrary base64 payload to a raw service id (e.g. 0x90 = resident CFW
   * OTA loader), framed + chunked through the standard 0xAA transport, to both lenses.
   */
  pushToService(serviceId: number, base64: string): void;

  // ---- the TypeScript SDK's transport (src/sdk) ----

  /**
   * Send one SDK-encoded EvenHub payload to the RIGHT lens, inside a session.
   *
   * NOT `pushToService(0xE0, …)`: that fans out to BOTH arms, whereas an EvenHub page belongs to
   * the right lens only. Pairs with the `onEvenHubRaw` event to form the SDK's whole transport.
   */
  sendEvenHub(base64: string): void;
  /**
   * Hand page ownership to the SDK and report whether the firmware ALREADY holds a page.
   *
   * The SDK must seed its PageSlot with this: the firmware has one page slot and silently
   * ignores a second CREATE, so booting the OS on a link where anything already rendered would
   * otherwise leave the HUD unchanged with no error anywhere. Also stops any animation loop,
   * which would rebuild the page out from under the SDK.
   */
  sdkTakeoverPage(): boolean;
  /**
   * HUD brightness (sid 0x09). `level` is 0–100 and nonlinear. `autoAdjust` hands control
   * back to the ambient-light sensor — pass false to HOLD a level, which is what every
   * visual proof needs (see docs/VERIFICATION-RIG.md; the rig default is 15).
   */
  setBrightness(level: number, autoAdjust: boolean): void;
  /**
   * Silent mode (sid 0x09). Suppresses the glasses' own notification behaviour.
   */
  setSilentMode(on: boolean): void;
  /**
   * Wear detection (sid 0x09) — whether the glasses react to being put on and taken off.
   */
  setWearDetection(on: boolean): void;
  /**
   * Nudge the rendered image within the lens (sid 0x09 `deviceReceiveXCoordinate` /
   * `deviceReceiveYCoordinate`, roughly ±20 px, per-arm).
   *
   * Worth knowing for visual proofs: this is the ONLY way to change the camera rig's FRAMING
   * without a human moving the phone, since focus, zoom and exposure are all software-adjustable
   * but aim is not (docs/VERIFICATION-RIG.md).
   */
  setLensOffset(x: number, y: number): void;
  /**
   * Read the sid-0x09 settings snapshot back off the glasses. Pass true to ask for
   * brightness only. The reply arrives as a log/settings event, not a return value —
   * this is how a setter is proven WITHOUT pointing a camera at the HUD.
   */
  querySettings(brightnessOnly: boolean): void;
  /**
   * FUT-216 (LIVE OTA delivery): push a base64 native-code payload to the resident CFW loader
   * over the evenHub image channel (service 0xE0), "FXP1"-magic framed. Replaces pushToService
   * 0x90 (proven dead on-glass — the dispatch table keys on inner command codes, not the
   * transport serviceId). Connect the pair first (isPairReady() === true).
   */
  pushPayloadViaImage(base64: string): void;
  /**
   * FUT-165: play an on-glass pixel animation by id (one of: "image", "ball", "spinner",
   * "rings", "plasma", "starfield", "marquee", "video"). Streams CFW mode-2 frames to a
   * persistent 576×288 container. Connect the pair first (isPairReady() === true).
   */
  playAnimation(id: string): void;
  /** FUT-165: stop the running animation. */
  stopAnimation(): void;
  /**
   * FUT-170 PoC: push custom text into the firmware's native head-up dashboard over BLE
   * (into the Schedule widget). Re-enables the head-up trigger + orders Schedule first.
   * Look UP on the glasses to see it. Connect the pair first.
   */
  pushDashboardDemo(text: string): void;
  /**
   * FUT-170: reveal Even's OWN native head-up dashboard (their real LVGL UI) by RELEASING
   * our EvenHub page — the firmware dashboard can't surface while our OS holds a page. Also
   * re-enables the head-up trigger and applies our widget layout over BLE (no firmware patch).
   * Look UP to see it; any touchpad gesture repaints our OS (re-creating the page). Connect first.
   */
  showStockDashboard(): void;
  /**
   * FUT-194: App #1 native-first — show the firmware's OWN dashboard driven by our OS over
   * BLE (widget layout + 12/24h + °C/°F + our Schedule events); no pixels, no firmware flash.
   * config = JSON { halfDay?:boolean, celsius?:boolean, widgetOrder?:number[],
   * schedule?:{ id:number, title:string, location?:string, time?:string, endTs?:number }[] }.
   */
  showNativeDashboard(config: string): void;
  /**
   * FUT-176: show OUR own dashboard (app #1) — rendered as our pixels via the mode-2
   * pipeline (tileview: header + swipeable widget tiles + expand). Connect the pair first.
   */
  showDashboard(): void;
  /** FUT-176: stop rendering our dashboard (e.g. when navigating away). */
  hideDashboard(): void;
  /** FUT-176: navigate the dashboard — "next" | "prev" | "select" | "back". */
  dashboardInput(action: string): void;
  /** FUT-176: feed the dashboard JSON data (time/date/battery + widget fields), then re-render. */
  setDashboardData(json: string): void;
  /** P3: tear down the EvenHub session (stops the keep-alive heartbeat). */
  stopSession(): void;
  /**
   * TEST AFFORDANCE — inject a synthetic gesture as if the hardware had sent it, so the
   * input→render path can be driven without a finger on the temple pad or the ring.
   *
   * The native side builds the REAL wire frame and pushes it through the REAL decode, so
   * everything from the protocol up through nav and rendering is genuinely exercised — and it
   * arrives as an ordinary `onGesture` event, indistinguishable to this layer on purpose.
   *
   * ⚠️ It proves NOTHING about whether a real touch reaches the phone. That is the open
   * FUT-249 / FUT-233 question and only real hardware answers it; every injection logs
   * "SIMULATED" so a green run here can never be mistaken for on-glass proof (cardinal rule 1).
   *
   * `device: "glasses"` accepts tap | double_tap | swipe_up | swipe_down.
   * `device: "ring"` accepts hold | single_tap | double_tap | swipe_up | swipe_down.
   */
  simulateGesture(device: "glasses" | "ring", gesture: string): void;

  /**
   * Tiny persistent key/value store (FUT-236) — used so the calibration run knows
   * whether it has already been completed. Returns null if never set.
   */
  getPref(key: string): string | null;
  setPref(key: string, value: string): void;

  // ---- R1 ring — the SDK's input device (FUT-233) --------------------------
  // The ring is a SEPARATE BLE peripheral the phone connects to directly, so none
  // of these require the glasses to be connected — or even powered on, which is
  // exactly the configuration the gesture-coverage test needs. Gestures arrive on
  // the shared `onGesture` event tagged `device: "ring"`; raw frames on `onRingRaw`.

  /** Scan for and connect the R1 ring (reconnects by stored UUID when known). */
  ringScan(): void;
  ringStopScan(): void;
  ringDisconnect(): void;
  /** Forget the paired ring so the next scan pairs fresh. */
  ringForget(): void;
  ringReadBattery(): void;
  /**
   * Command the ring to ALSO hold a link to the glasses at `mac` (advStart). NOT
   * needed for input — that comes over the phone link. Returns false if the ring
   * isn't connected or the MAC won't parse.
   */
  ringConnectToGlasses(mac: string): boolean;
  addListener<E extends FfsBleEventName>(
    event: E,
    listener: (payload: FfsBleEvents[E]) => void
  ): EventSubscription;
}

const FfsBleModule = requireNativeModule<FfsBleNativeModule>("FfsBleModule");

export default FfsBleModule;
