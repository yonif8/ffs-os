// Device settings — sid 0x09, the G2SettingPackage subsystem.
//
// Field numbers come from reference/g2-kit-unofficial/ble/gen/g2_setting_pb.ts (the GENERATED
// schema). Its prose docs describe a completely different shape
// (`G2SettingPackage{battery=1, brightness=2, ...}`) which does not exist — that file is one of
// the clearest cases of the kit's docs contradicting its own protos, so only gen/ is trusted here.
//
// The envelope is cross-validated: our Kotlin setHeadUpSwitch, written independently and proven
// on hardware, encodes byte-for-byte the same way.
//
// ⛔ NEVER write sid 0x80 (dev_config). It looks like a settings service but holds developer
// knobs, and poking them is recorded as having bricked a pair during early RE. Everything an app
// needs is here on 0x09.

import { ProtoWriter, parseFields, str, sub, u32 } from "./proto";

export const SID_G2_SETTING = 0x09;

/** G2SettingCommandId. */
export const SettingCmd = {
  /** app -> device mutation */
  DEVICE_RECEIVE_INFO: 1,
  /** app -> device read (and device push) */
  DEVICE_RECEIVE_REQUEST: 2,
} as const;

/** APPRequestSettingType — WHICH snapshot the device should send back. */
export const RequestType = {
  /** Only the brightness block. Asking for this and expecting `silent` costs a cycle. */
  BRIGHTNESS_INFO: 0,
  /** The full snapshot: silent, wear, head-up, lens x/y, battery, firmware. */
  BASIC_SETTING: 1,
} as const;

/** DeviceReceiveInfoFromAPP sub-field numbers. */
const Sub = {
  brightness: 1,
  yCoordinate: 2,
  xCoordinate: 3,
  headUp: 4,
  wearDetection: 5,
  silentMode: 6,
} as const;

function envelope(cmd: number, magic: number, field: number, payload: Uint8Array): Uint8Array {
  const w = new ProtoWriter();
  w.int32(1, cmd);
  w.int32(2, magic);
  w.message(field, payload);
  return w.data;
}

function infoEnvelope(magic: number, subField: number, sub: Uint8Array): Uint8Array {
  const info = new ProtoWriter();
  info.message(subField, sub);
  return envelope(SettingCmd.DEVICE_RECEIVE_INFO, magic, 3, info.data);
}

const one = (field: number, value: number) => new ProtoWriter().int32(field, value).data;

/**
 * HUD brightness. 0-100, but the mapping to actual lens output is NONLINEAR — the firmware
 * converts level -> luminance -> drive current.
 *
 * MEASURED THROUGH THE CAMERA RIG on a 4-row list: 100 blows the selected row out to an
 * unreadable white block, 20 is readable, **15 is the working value**, 10 leaves the lower rows
 * dim, and 5 makes the unselected rows nearly invisible. Judge the WHOLE screen, not the
 * highlighted row.
 *
 * `autoAdjust` hands control to the ambient-light sensor; leave it OFF while measuring anything
 * or the ALS moves the level mid-observation.
 *
 * `level = 0` blanks the lens visually but does NOT enter any power-saving state.
 */
export function setBrightness(
  magic: number,
  level: number,
  autoAdjust = false,
  leftCalibration = 0,
  rightCalibration = 0
): Uint8Array {
  const b = new ProtoWriter();
  b.int32(1, autoAdjust ? 1 : 0);
  b.int32(2, Math.max(0, Math.min(100, Math.round(level))));
  if (leftCalibration) b.int32(3, leftCalibration);
  if (rightCalibration) b.int32(4, rightCalibration);
  return infoEnvelope(magic, Sub.brightness, b.data);
}

/** Suppress the audio cue on container pushes and notifications. */
export const setSilentMode = (magic: number, on: boolean) =>
  infoEnvelope(magic, Sub.silentMode, one(1, on ? 1 : 0));

/**
 * Wear detection — the nose-bridge proximity sensor. Worn/unworn transitions emit an async
 * state-change event on sid 0x0d, so prefer subscribing over polling.
 */
export const setWearDetection = (magic: number, on: boolean) =>
  infoEnvelope(magic, Sub.wearDetection, one(1, on ? 1 : 0));

/** The firmware's own head-up dashboard. Turn it OFF so it cannot pop over our screens. */
export const setHeadUpSwitch = (magic: number, on: boolean) =>
  infoEnvelope(magic, Sub.headUp, one(1, on ? 1 : 0));

/**
 * Head-up TILT ANGLE — how far up the wearer must look before the firmware's head-up dashboard
 * appears. This is the SAME `deviceReceiveHeadUpSetting` sub-message (field 4) as
 * {@link setHeadUpSwitch}, but populates `headUpAngle` (sub-field 2) instead of the switch.
 *
 *     DeviceReceive_Head_UP_Setting { headUpSwitch=1, headUpAngle=2, ... }   (g2_setting_pb.ts)
 *
 * Cross-checked against MentraOS `G2SettingProto.setHeadUpAngle` (reference/MentraOS/.../sgcs/G2.kt,
 * MIT), which writes ONLY field 2 in the head-up sub-message and clamps the angle to 0..60 — its
 * high-level `setHeadUpAngle` enables the head-up switch first, then sends the angle. We keep the
 * wire encoder pure (angle only); the enable-first sequencing belongs to the caller.
 *
 * ⚠️ DEVICE-PROOF-OWED: the encoding is byte-checked against the schema + MentraOS, but the visible
 * effect on the HUD trigger has not been seen on our glasses. The angle is a device UX code, not
 * degrees in any obvious unit — 0..60 is the range both the schema-derived driver and MentraOS use.
 */
export const setHeadUpAngle = (magic: number, angle: number) =>
  infoEnvelope(magic, Sub.headUp, one(2, Math.max(0, Math.min(60, Math.round(angle)))));

/**
 * SCREEN HEIGHT — the vertical position of the rendered image in the lens. This is wire-identical
 * to {@link setLensY}: MentraOS's `setScreenHeight` and our `setLensY` both populate
 * `deviceReceiveYCoordinate` (sub-field 2) with `yCoordinateLevel` (field 1). The two names are
 * the same knob seen from two angles — MentraOS frames it as a user-facing "screen height" slider,
 * we framed it as an IPD/rig-framing offset. Provided under the reference name for parity; prefer
 * whichever reads better at the call site.
 *
 * Cross-check: MentraOS `G2SettingProto.setScreenHeight` (reference/MentraOS/.../sgcs/G2.kt, MIT).
 */
export const setScreenHeight = (magic: number, level: number) =>
  infoEnvelope(magic, Sub.yCoordinate, one(1, level));

/**
 * SCREEN DEPTH — the horizontal position of the rendered image in the lens (the binocular-depth /
 * IPD axis). Wire-identical to {@link setLensX}: both populate `deviceReceiveXCoordinate`
 * (sub-field 3) with `xCoordinateLevel` (field 1).
 *
 * Cross-check: MentraOS `G2SettingProto.setScreenDepth` (reference/MentraOS/.../sgcs/G2.kt, MIT).
 */
export const setScreenDepth = (magic: number, level: number) =>
  infoEnvelope(magic, Sub.xCoordinate, one(1, level));

/**
 * Lens x/y offset — fine IPD centering, applied by the firmware to EVERY rendered frame, per arm.
 *
 * Also the only way to improve the camera rig's FRAMING without a human physically re-aiming the
 * phone, which makes it the one instrument control that can recover from rig drift unattended.
 */
export const setLensX = (magic: number, level: number) =>
  infoEnvelope(magic, Sub.xCoordinate, one(1, level));
export const setLensY = (magic: number, level: number) =>
  infoEnvelope(magic, Sub.yCoordinate, one(1, level));

/**
 * Ask the device for a settings snapshot.
 *
 * ⚠️ Use BASIC_SETTING for anything except brightness. BRIGHTNESS_INFO returns only the
 * brightness block, so `silent`/`wear`/`lens` read back as absent and it looks like the SETTER
 * failed when in fact the QUERY was wrong. That misdiagnosis cost a verification cycle.
 */
export function querySettings(magic: number, type: number = RequestType.BASIC_SETTING): Uint8Array {
  const req = new ProtoWriter();
  req.int32(1, type);
  return envelope(SettingCmd.DEVICE_RECEIVE_REQUEST, magic, 4, req.data);
}

export interface SettingsSnapshot {
  battery?: number;
  chargingStatus?: number;
  leftFirmware?: string;
  rightFirmware?: string;
  brightness?: number;
  autoBrightness?: number;
  headUpSwitch?: number;
  headUpAngle?: number;
  wearDetection?: number;
  silentMode?: number;
  lensX?: number;
  lensY?: number;
  leftBrightnessCalibration?: number;
  rightBrightnessCalibration?: number;
}

/**
 * Decode `deviceReceiveRequestFromApp` (envelope field 4).
 *
 * ⚠️ Absent means ZERO here, per proto3 — a switch that is off simply is not encoded. So
 * `silentMode === undefined` and `silentMode === 0` mean the same thing, and the only way to
 * PROVE a setter worked is to set it NON-zero and watch the field appear.
 *
 * ⚠️ chargingStatus (13) is what the generated schema says, but Even-G2-RE decoded a real packet
 * on the much older 2.0.7.16 with charging at f18. Treat it as unverified on 2.2.7.14.
 */
export function parseSettingsSnapshot(payload: Uint8Array): SettingsSnapshot | null {
  const f = parseFields(payload);
  const body = sub(f, 4);
  if (!body) return null;
  const r = parseFields(body);
  if (!r) return null;
  return {
    battery: u32(r, 12),
    chargingStatus: u32(r, 13),
    leftFirmware: str(r, 5),
    rightFirmware: str(r, 6),
    brightness: u32(r, 2),
    autoBrightness: u32(r, 18),
    headUpSwitch: u32(r, 7),
    headUpAngle: u32(r, 8),
    wearDetection: u32(r, 10),
    silentMode: u32(r, 14),
    // ⚠️ x is field 4 and y is field 3 (xCoordinateLevelRestored / yCoordinateLevelRestored).
    // Fields 15/16 are leftCalibrationRestored / rightCalibrationRestored — BRIGHTNESS
    // calibration, not lens position. Guessing 15/16 here read the wrong values entirely and
    // would have reported one setting under another's name; caught only by setting lensX
    // non-zero on hardware and watching it stay absent.
    lensX: u32(r, 4),
    lensY: u32(r, 3),
    leftBrightnessCalibration: u32(r, 15),
    rightBrightnessCalibration: u32(r, 16),
  };
}
