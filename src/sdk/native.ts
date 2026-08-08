// The ONLY file in the SDK that knows the native module exists.
//
// Everything else in src/sdk is pure: encoders, decoders, the screen stack, the provenance
// ledger. That is what makes the SDK testable without glasses, and it is why this adapter is
// small and boring by design — it moves bytes and nothing else. If logic starts accumulating
// here, it belongs in the pure layer where a test can reach it.

import FfsBle from "../../modules/ffs-ble";
import { fromBase64, toBase64 } from "./base64";
import type { Transport } from "./screen";
import type { OsHost } from "./os";
import {
  parseSettingsSnapshot,
  querySettings,
  setBrightness,
  setSilentMode,
  setWearDetection,
  SID_G2_SETTING,
  type SettingsSnapshot,
} from "./settings";

/**
 * The SDK's transport over the native driver.
 *
 * Outbound goes through `sendEvenHub` (RIGHT lens, inside a session) rather than
 * `pushToService`, which fans out to both arms. Inbound is the raw `onEvenHubRaw` stream, so the
 * SDK's own decoder does the interpreting.
 */
export function nativeTransport(): Transport {
  return {
    async sendEvenHub(bytes: Uint8Array): Promise<void> {
      FfsBle.sendEvenHub(toBase64(bytes));
    },
    onInbound(handler: (payload: Uint8Array) => void): () => void {
      const sub = FfsBle.addListener("onEvenHubRaw", ({ payload }) => {
        handler(fromBase64(payload));
      });
      return () => sub.remove();
    },
  };
}

/**
 * Take page ownership from the native driver, returning whether the firmware already holds a
 * page. Feed the result into the Session's PageSlot or the first declare may be a silent no-op.
 */
export function takeoverPage(): boolean {
  return FfsBle.sdkTakeoverPage();
}

/**
 * The OS's view of the device.
 *
 * Settings are fire-and-forget writes plus an async snapshot push, so this keeps the last
 * snapshot it saw and hands it over on request. The OS renders what is known and never blocks a
 * screen on a device round trip — a menu that waits for the glasses to answer is a menu that
 * hangs when the link is busy.
 */
export function nativeHost(): OsHost & { dispose(): void } {
  let latest: SettingsSnapshot = {};
  let magic = 200;
  const nextMagic = () => {
    magic = magic >= 255 ? 200 : magic + 1;
    return magic;
  };
  const send = (bytes: Uint8Array) =>
    FfsBle.pushToService(SID_G2_SETTING, toBase64(bytes));

  // Settings snapshots come back on the same raw channel; keep the freshest one.
  const sub = FfsBle.addListener("onEvenHubRaw", ({ payload }) => {
    const snap = parseSettingsSnapshot(fromBase64(payload));
    if (snap) latest = snap;
  });

  return {
    setBrightness(level: number, autoAdjust: boolean) {
      send(setBrightness(nextMagic(), level, autoAdjust));
    },
    setSilentMode(on: boolean) {
      send(setSilentMode(nextMagic(), on));
    },
    setWearDetection(on: boolean) {
      send(setWearDetection(nextMagic(), on));
    },
    async readSettings() {
      // Ask, then answer from cache: the reply is asynchronous and the caller must not stall.
      send(querySettings(nextMagic()));
      return {
        battery: latest.battery,
        brightness: latest.brightness,
        silentMode: latest.silentMode,
        wearDetection: latest.wearDetection,
        leftFirmware: latest.leftFirmware,
        rightFirmware: latest.rightFirmware,
      };
    },
    setSwirl(on: boolean) {
      // even_ai service, driven by the native module — not an EvenHub page.
      FfsBle.showAiSwirl(on);
    },
    now: () => new Date(),
    dispose: () => sub.remove(),
  };
}
