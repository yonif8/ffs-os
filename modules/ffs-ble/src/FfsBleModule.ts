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

export interface OnDisconnectedEvent {
  name: string;
  /** Which lens dropped. The other lens's state is unaffected. */
  side: G2Side;
  reason: string | null;
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
  onDisconnected: OnDisconnectedEvent;
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
  /** P3: tear down the EvenHub session (stops the keep-alive heartbeat). */
  stopSession(): void;
  addListener<E extends FfsBleEventName>(
    event: E,
    listener: (payload: FfsBleEvents[E]) => void
  ): EventSubscription;
}

const FfsBleModule = requireNativeModule<FfsBleNativeModule>("FfsBleModule");

export default FfsBleModule;
