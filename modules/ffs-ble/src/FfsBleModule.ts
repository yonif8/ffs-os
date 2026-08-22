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
  /** Advertised name, e.g. "Even G2_XX_L_XXXXXX". */
  name: string;
  /** Which lens side. */
  side: G2Side;
  rssi: number;
  /** 14-char serial from manufacturer data, if present. */
  sn: string | null;
  /** "AA:BB:CC:DD:EE:FF" big-endian, if present. */
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

export interface OnGestureEvent {
  gesture: G2GestureName;
  /** Which lens's touchpad it came from. */
  side: G2Side;
  /** Which physical device produced it (always the glasses now; the R1 ring was quarantined). */
  device: "glasses";
  /**
   * Often null: the firmware's `eventSource` — 1 and 3 are the temple touchpads.
   * ALWAYS null for taps on text/list containers, which carry no such field.
   */
  source: number | null;
}

/**
 * Collapse a glasses touchpad event into the single nav vocabulary the OS navigates
 * with, or null if it has no navigation meaning.
 *
 * ⚠️ `double_tap` is BACK (Yoni, 2026-07-28) — verified, it routes to `back()` in every
 * branch of `nav.handleGesture`.
 */
export function toNavGesture(g: OnGestureEvent): G2GestureName | null {
  switch (g.gesture) {
    case "tap":
      return "tap";
    case "double_tap":
      return "double_tap";
    case "swipe_up":
      return "swipe_up";
    case "swipe_down":
      return "swipe_down";
    default:
      return null;
  }
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

/**
 * The microphone started streaming. Fired once per BURST, not per packet.
 *
 * ⚠️ `requestedByUs === false` means **the glasses opened their own microphone** — the GX8002
 * wake word, or a temple long-press into Even's stock voice flow. Three of the eighteen audio
 * bursts in the 08-18/08-20 archive looked like that, so this is an observed behaviour, not a
 * theoretical one. Surface it to the wearer; never treat an idle mic as a closed one.
 *
 * Carries no audio and nothing derived from audio.
 */
export interface OnMicUnexpectedEvent {
  side: G2Side;
  /** Silence before this burst, ms. `-1` = first burst since the app started. */
  gapMs: number;
  /** true = our own setMicStream/aiSwirl opened it. false = the glasses did. */
  requestedByUs: boolean;
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
  onMicUnexpected: OnMicUnexpectedEvent;
  onGlassesEvent: OnGlassesEvent;
  onServiceRaw: OnServiceRawEvent;
  onOsCommand: OnOsCommandEvent;
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
   * FUT-269 dual-lens telemetry: request device info from ONE lens ("L" | "R"). The answer
   * arrives via `onDeviceInfo` and every telemetry payload self-reports its lens, so a single-lens
   * query removes the deduped "whichever answered" ambiguity. ⚠️ Whether the LEFT lens answers a
   * direct service-0x09 query is unverified on-glass (FUT-159: the left arm is silent on async
   * events) — treat a left reply as the proof, its absence as the (documented) limit.
   */
  requestDeviceInfoSide(side: "L" | "R"): void;
  /**
   * FUT-216: push an arbitrary base64 payload to a raw service id (e.g. 0x90 = resident CFW
   * OTA loader), framed + chunked through the standard 0xAA transport, to both lenses.
   */
  pushToService(serviceId: number, base64: string): void;

  // ---- fb_shot: developer screenshot ----

  /** Write assembled A4 framebuffer bytes (base64) to the app's files dir as `fbshot.a4`. */
  writeFbShot(base64: string): void;

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
  /** Tear down the EvenHub session (stops the keep-alive heartbeat). */
  stopSession(): void;
  /**
   * TEST AFFORDANCE — inject a synthetic gesture as if the hardware had sent it, so the
   * inbound gesture path can be driven without a finger on the temple pad.
   *
   * The native side builds the REAL wire frame and pushes it through the REAL decode, so it
   * arrives as an ordinary `onGesture` event. ⚠️ It proves NOTHING about whether a real touch
   * reaches the phone; every injection logs "SIMULATED" (cardinal rule 1).
   *
   * `device` must be "glasses" (the R1 ring was quarantined); accepts
   * tap | double_tap | swipe_up | swipe_down.
   */
  simulateGesture(device: "glasses", gesture: string): void;

  /**
   * Tiny persistent key/value store (FUT-236) — used so the calibration run knows
   * whether it has already been completed. Returns null if never set.
   */
  getPref(key: string): string | null;
  setPref(key: string, value: string): void;

  addListener<E extends FfsBleEventName>(
    event: E,
    listener: (payload: FfsBleEvents[E]) => void
  ): EventSubscription;
}

const FfsBleModule = requireNativeModule<FfsBleNativeModule>("FfsBleModule");

export default FfsBleModule;
