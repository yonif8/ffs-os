// FFS Glasses OS — the React binding for the native-push acknowledgement loop (FUT-237).
//
// The state machine itself is pure and lives in pushAckController.ts (so `bun test` can load
// it without react-native). This file is the thin hook that owns the status-line state, holds
// one stable controller for the session, and wires the real side effects (FfsBle, glog,
// setTimeout) — the same split as src/data/pump.ts (pure) vs its React consumers.

import { useRef, useState } from "react";
import FfsBle from "../../modules/ffs-ble";
import { glog } from "./log";
import { PushAckController, type DeviceVersions } from "./pushAckController";

export { PushAckController } from "./pushAckController";
export type { DeviceVersions, PushAckDeps } from "./pushAckController";

/** Live session state the controller reads at call time (via App's btRef, always current). */
export interface PushAckContext {
  deviceInfo: DeviceVersions | null | undefined;
  pairReady: boolean;
}

/** The App-facing surface: a status line + the handlers App wires into its listeners. */
export interface PushAck {
  /** The push-status line (the OTA-loader verdict), rendered by the Dashboard panel. */
  status: string;
  /** DashboardPanel's onPush — guard + park/send a payload. Reads live session state. */
  guardedPush: (label: string, event: string, b64: string) => void;
  /** Feed a device-info readback (call after App's own device-info telemetry emit). */
  onDeviceInfo: (leftVersion: string | null | undefined, rightVersion: string | null | undefined) => void;
  /** Notify the machine the pair link dropped (call from the pairReady effect). */
  onLinkDropped: () => void;
  /** Is the resident OTA loader present right now? (Feeds the notification bridge.) */
  loaderPresent: () => boolean;
}

/**
 * React binding for {@link PushAckController}. Owns the status-line state, holds one stable
 * controller for the session, and wires the real side effects. `getContext` reads live
 * session state (App passes its btRef getters) so a push fired from a debug button sees the
 * current deviceInfo/pairReady, not a stale render's.
 */
export function usePushAck(getContext: () => PushAckContext): PushAck {
  const [status, setStatus] = useState<string>("");
  const controllerRef = useRef<PushAckController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new PushAckController({
      pushPayload: (b64) => FfsBle.pushPayloadViaImage(b64),
      requestDeviceInfo: () => FfsBle.requestDeviceInfo(),
      setStatus,
      schedule: (fn, ms) => {
        setTimeout(fn, ms);
      },
      // glog.emit never throws into the app (see log.ts), so calling it bare here is safe.
      log: (event, data) => glog.emit("os", event, data),
    });
  }
  const c = controllerRef.current;
  return {
    status,
    guardedPush: (label, event, b64) => {
      const { deviceInfo, pairReady } = getContext();
      c.guardedPush(label, event, b64, deviceInfo, pairReady);
    },
    onDeviceInfo: (l, r) => c.onDeviceInfo(l, r),
    onLinkDropped: () => c.onLinkDropped(),
    loaderPresent: () => c.loaderPresent(getContext().deviceInfo),
  };
}
