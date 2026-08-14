// Typed, frame-level command builders — the top of the pure-TS BLE stack.
//
// The SDK already has INNER-pb encoders (wire.ts for EvenHub Cmds, settings.ts for sid 0x09). What
// was missing was anything that turned one of those into ready-to-write aa21 frames without going
// through the native module. These builders close that gap: each returns the transport frames AND
// the `magic`/`syncId` it consumed, so a caller can match the firmware's ack and nothing has to
// reach into the envelope layer by hand.
//
// Everything is a thin composition of an existing inner-pb encoder + `frameMessage`; the two genuine
// additions are the heartbeat (Cmd 12) and shutdown (Cmd 9) inner encoders, which wire.ts lacked.

import { ProtoWriter } from "../proto";
import {
  encodeEnvelope,
  encodeImuControl,
  encodeListPage,
  encodeUpdateText,
} from "../wire";

// EvenHub Cmd ids not carried by wire.ts's `Cmd` enum (which covers only the encoders it ships).
// Defined here rather than by editing wire.ts, to keep this module strictly additive.
const CMD_SHUTDOWN_PAGE = 9;
const CMD_HEARTBEAT = 12;
import {
  querySettings,
  setBrightness,
  setHeadUpSwitch,
  setSilentMode,
  setWearDetection,
  RequestType,
  SID_G2_SETTING,
} from "../settings";
import { Counters, Flag, SID, frameMessage } from "./envelope";

export interface FramedMessage {
  /** aa21 transport frames to write, in order. */
  frames: Uint8Array[];
  /** the inner protobuf, pre-framing (handy for tests / logging). */
  pb: Uint8Array;
  /** the MagicRandom (EvenHub) or magic (settings) this message carries; matches its ack. */
  magic: number;
  /** the transport reassembly syncId consumed. */
  syncId: number;
}

/** EvenHub HEARTBEAT (Cmd 12) inner pb: wrapper field 14 = HeartBeatPacket{ Cnt=1 }. */
export function encodeHeartbeat(magic: number, cnt = 0): Uint8Array {
  const hb = new ProtoWriter();
  hb.int32(1, cnt);
  return encodeEnvelope(CMD_HEARTBEAT, 14, hb.data, magic);
}

/** EvenHub SHUTDOWN (Cmd 9) inner pb: wrapper field 11 = ShutDownContaniner{ exitMode=1 }. */
export function encodeShutdown(magic: number, exitMode = 0): Uint8Array {
  const sd = new ProtoWriter();
  sd.int32(1, exitMode);
  return encodeEnvelope(CMD_SHUTDOWN_PAGE, 11, sd.data, magic);
}

/** Frame any pre-built EvenHub inner pb (sid 0xe0, flag REQUEST). */
export function frameEvenHub(pb: Uint8Array, counters: Counters, magic: number): FramedMessage {
  const syncId = counters.nextSyncId();
  return {
    frames: frameMessage(pb, { syncId, sid: SID.UI_BACKGROUND_EVENHUB, flag: Flag.REQUEST }),
    pb,
    magic,
    syncId,
  };
}

/** Frame any pre-built sid-0x09 settings inner pb (flag REQUEST). */
export function frameSetting(pb: Uint8Array, counters: Counters, magic: number): FramedMessage {
  const syncId = counters.nextSyncId();
  return {
    frames: frameMessage(pb, { syncId, sid: SID_G2_SETTING, flag: Flag.REQUEST }),
    pb,
    magic,
    syncId,
  };
}

// ── EvenHub render channel (sid 0xe0) ─────────────────────────────────────────

/** CREATE or REBUILD a native list page. `rebuild=false` is only valid as a session's first page. */
export function listPage(
  counters: Counters,
  opts: { items: readonly string[]; rebuild: boolean; header?: string; containerId?: number; containerName?: string }
): FramedMessage {
  const magic = counters.nextMagic();
  return frameEvenHub(encodeListPage({ ...opts, magic }), counters, magic);
}

/** In-place text update (Cmd 5) — flicker-free, does not reset list focus. */
export function updateText(
  counters: Counters,
  opts: { containerId: number; content: string }
): FramedMessage {
  const magic = counters.nextMagic();
  return frameEvenHub(encodeUpdateText({ ...opts, magic }), counters, magic);
}

/** HEARTBEAT (Cmd 12) — mandatory ~5 s keepalive or CREATE/REBUILD are silently dropped. */
export function heartbeat(counters: Counters, cnt = 0): FramedMessage {
  const magic = counters.nextMagic();
  return frameEvenHub(encodeHeartbeat(magic, cnt), counters, magic);
}

/** SHUTDOWN (Cmd 9) — tear down the foreground container before swapping page shapes. */
export function shutdown(counters: Counters, exitMode = 0): FramedMessage {
  const magic = counters.nextMagic();
  return frameEvenHub(encodeShutdown(magic, exitMode), counters, magic);
}

/** OPEN/CLOSE the IMU + compass stream (Cmd 19, wrapper field 22). */
export function imuControl(
  counters: Counters,
  opts: { enable: boolean; pace?: number }
): FramedMessage {
  const magic = counters.nextMagic();
  return frameEvenHub(encodeImuControl({ ...opts, magic }), counters, magic);
}

// ── Settings / status channel (sid 0x09) ──────────────────────────────────────

/** HUD brightness (0-100, nonlinear). `autoAdjust` hands the level to the ambient sensor. */
export function brightness(
  counters: Counters,
  level: number,
  autoAdjust = false
): FramedMessage {
  const magic = counters.nextMagic();
  return frameSetting(setBrightness(magic, level, autoAdjust), counters, magic);
}

/** Silent mode — suppress the audio cue on pushes/notifications. */
export function silentMode(counters: Counters, on: boolean): FramedMessage {
  const magic = counters.nextMagic();
  return frameSetting(setSilentMode(magic, on), counters, magic);
}

/** Wear detection (nose-bridge proximity). */
export function wearDetection(counters: Counters, on: boolean): FramedMessage {
  const magic = counters.nextMagic();
  return frameSetting(setWearDetection(magic, on), counters, magic);
}

/** Firmware's own head-up dashboard — turn OFF so it cannot pop over our screens. */
export function headUp(counters: Counters, on: boolean): FramedMessage {
  const magic = counters.nextMagic();
  return frameSetting(setHeadUpSwitch(magic, on), counters, magic);
}

/** Ask the device for a settings/status snapshot (battery, FW, brightness, ...). */
export function readStatus(
  counters: Counters,
  type: number = RequestType.BASIC_SETTING
): FramedMessage {
  const magic = counters.nextMagic();
  return frameSetting(querySettings(magic, type), counters, magic);
}
