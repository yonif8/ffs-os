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
  /** Which lens's touchpad the gesture came from. */
  side: G2Side;
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
  addListener<E extends FfsBleEventName>(
    event: E,
    listener: (payload: FfsBleEvents[E]) => void
  ): EventSubscription;
}

const FfsBleModule = requireNativeModule<FfsBleNativeModule>("FfsBleModule");

export default FfsBleModule;
