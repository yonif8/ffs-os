// FFS Glasses OS — React session hook over the ffs-ble driver (Phase 1, FUT-163).
//
// The OS shell (connection supervisor, HUD, launcher) needs a React-friendly view of
// the dual-radio G2 link. This hook subscribes to the native FfsBle event stream and
// derives one connection session — replacing the old @mentra `useMentraBluetooth`
// with our own driver, no third-party pipes.
//
// The G2 is TWO peripherals (left + right lens). "connected" here means BOTH lenses
// are up with their characteristics bound (driver's onPairReady / isPairReady). Async
// protocol traffic (gestures, ACKs) rides the RIGHT lens.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FfsBle, {
  type G2Side,
  type G2ConnectSide,
  type G2GestureName,
  type OnDeviceFoundEvent,
} from "../../modules/ffs-ble";

/** Underlying link state, coarse-grained (the finest JS can observe). */
export type FfsLinkState =
  | "idle" //        not scanning, nothing connected
  | "scanning" //    looking for lenses
  | "connecting" //  at least one lens connecting, pair not yet ready
  | "pairReady"; //  both lenses connected + characteristics bound

export interface FfsGlassesSession {
  /** Both lenses connected + bound (the "good" link). */
  pairReady: boolean;
  /** Coarse link state for the UI. */
  state: FfsLinkState;
  /** Per-side connected flags. */
  sides: { L: boolean; R: boolean };
  /** Discovered lenses (deduped by side), newest RSSI wins. */
  devices: OnDeviceFoundEvent[];
  /** Most recent decoded gesture (for the launcher's input routing). */
  lastGesture: { gesture: G2GestureName; side: G2Side; at: number } | null;

  // --- actions (thin pass-throughs to the driver) ---
  startScan: () => void;
  stopScan: () => void;
  connect: () => void;
  connectSide: (side: G2ConnectSide) => void;
  disconnect: () => void;
  showText: (text: string) => void;
  showImage: () => void;
}

/**
 * Subscribe to the ffs-ble driver and expose one connection session. Starts a scan on
 * mount and tears every listener down on unmount. Pure observer — it drives no reconnect
 * loop of its own (native auto-reconnect is tracked separately, FUT-162).
 */
export function useFfsBluetooth(options: { autoScan?: boolean } = {}): FfsGlassesSession {
  const autoScan = options.autoScan ?? true;

  const [sides, setSides] = useState<{ L: boolean; R: boolean }>({ L: false, R: false });
  const [pairReady, setPairReady] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<OnDeviceFoundEvent[]>([]);
  const [lastGesture, setLastGesture] =
    useState<{ gesture: G2GestureName; side: G2Side; at: number } | null>(null);

  useEffect(() => {
    const subs = [
      FfsBle.addListener("onDeviceFound", (d) => {
        setDevices((prev) => {
          const next = prev.filter((p) => p.side !== d.side);
          next.push(d);
          return next;
        });
      }),
      FfsBle.addListener("onConnected", (e) => {
        if (e.side === "L" || e.side === "R") {
          setSides((prev) => ({ ...prev, [e.side]: true }));
        }
      }),
      FfsBle.addListener("onDisconnected", (e) => {
        if (e.side === "L" || e.side === "R") {
          setSides((prev) => ({ ...prev, [e.side]: false }));
        }
        setPairReady(false);
      }),
      FfsBle.addListener("onPairReady", () => {
        setPairReady(true);
        setScanning(false);
      }),
      FfsBle.addListener("onGesture", (g) => {
        setLastGesture({ gesture: g.gesture, side: g.side, at: Date.now() });
      }),
    ];
    if (autoScan) {
      FfsBle.startScan();
      setScanning(true);
    }
    return () => {
      for (const s of subs) s.remove();
    };
  }, [autoScan]);

  const startScan = useCallback(() => {
    FfsBle.startScan();
    setScanning(true);
  }, []);
  const stopScan = useCallback(() => {
    FfsBle.stopScan();
    setScanning(false);
  }, []);
  const connect = useCallback(() => FfsBle.connect(), []);
  const connectSide = useCallback((side: G2ConnectSide) => FfsBle.connectSide(side), []);
  const disconnect = useCallback(() => {
    FfsBle.disconnect();
    setPairReady(false);
    setSides({ L: false, R: false });
  }, []);
  const showText = useCallback((text: string) => FfsBle.showText(text), []);
  const showImage = useCallback(() => FfsBle.showImage(), []);

  const state = useMemo<FfsLinkState>(() => {
    if (pairReady) return "pairReady";
    if (sides.L || sides.R) return "connecting";
    if (scanning) return "scanning";
    return "idle";
  }, [pairReady, sides.L, sides.R, scanning]);

  return {
    pairReady,
    state,
    sides,
    devices,
    lastGesture,
    startScan,
    stopScan,
    connect,
    connectSide,
    disconnect,
    showText,
    showImage,
  };
}
