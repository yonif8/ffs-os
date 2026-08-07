// Settings encoder/parser tests.
//
// The envelope is cross-validated against the Kotlin driver's setHeadUpSwitch, which was written
// independently and is proven on hardware — so matching it byte for byte is real evidence, not
// this file agreeing with itself.

import {
  RequestType,
  SettingCmd,
  parseSettingsSnapshot,
  querySettings,
  setBrightness,
  setHeadUpSwitch,
  setLensX,
  setLensY,
  setSilentMode,
  setWearDetection,
} from "../settings";
import { ProtoWriter, parseFields, sub, u32 } from "../proto";

/** Pull DeviceReceiveInfoFromAPP (field 3) out of an app->device mutation. */
const info = (bytes: Uint8Array) => parseFields(sub(parseFields(bytes), 3)!)!;

describe("settings — envelope", () => {
  it("mutations use commandId 1 in field 3", () => {
    const f = parseFields(setSilentMode(101, true))!;
    expect(u32(f, 1)).toBe(SettingCmd.DEVICE_RECEIVE_INFO);
    expect(u32(f, 2)).toBe(101);
    expect(sub(f, 3)).toBeDefined();
  });

  it("reads use commandId 2 in field 4", () => {
    const f = parseFields(querySettings(102))!;
    expect(u32(f, 1)).toBe(SettingCmd.DEVICE_RECEIVE_REQUEST);
    expect(sub(f, 4)).toBeDefined();
    expect(u32(parseFields(sub(f, 4)!), 1)).toBe(RequestType.BASIC_SETTING);
  });

  /**
   * CROSS-CHECK against the proven Kotlin path. G2Setting.setHeadUpSwitch builds
   * headUp{1=on} inside info{4=...} inside {1=cmd, 2=magic, 3=info} — and it works on hardware.
   */
  it("head-up matches the byte layout the Kotlin driver proved on-glass", () => {
    const headUp = new ProtoWriter().int32(1, 0).data;
    const inf = new ProtoWriter().message(4, headUp).data;
    const expected = new ProtoWriter().int32(1, 1).int32(2, 77).message(3, inf).data;
    expect(Array.from(setHeadUpSwitch(77, false))).toEqual(Array.from(expected));
  });
});

describe("settings — sub-field routing", () => {
  it("each setter populates its own sub-field and no other", () => {
    expect(sub(info(setBrightness(1, 15)), 1)).toBeDefined();       // brightness
    expect(sub(info(setLensY(1, 3)), 2)).toBeDefined();             // y
    expect(sub(info(setLensX(1, 4)), 3)).toBeDefined();             // x
    expect(sub(info(setHeadUpSwitch(1, true)), 4)).toBeDefined();   // head-up
    expect(sub(info(setWearDetection(1, true)), 5)).toBeDefined();  // wear
    expect(sub(info(setSilentMode(1, true)), 6)).toBeDefined();     // silent
    // and a setter must not accidentally fill a neighbour
    expect(sub(info(setSilentMode(1, true)), 5)).toBeUndefined();
  });

  it("brightness carries autoAdjust and the clamped level", () => {
    const b = parseFields(sub(info(setBrightness(1, 15, false)), 1)!)!;
    expect(u32(b, 1)).toBe(0);      // autoAdjust off
    expect(u32(b, 2)).toBe(15);
    expect(u32(parseFields(sub(info(setBrightness(1, 999)), 1)!), 2)).toBe(100); // clamped
    expect(u32(parseFields(sub(info(setBrightness(1, -5)), 1)!), 2)).toBe(0);
  });
});

describe("settings — snapshot", () => {
  /** Build a deviceReceiveRequestFromApp (envelope field 4) with the given fields. */
  function snapshot(fields: Record<number, number | string>) {
    const body = new ProtoWriter();
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "string") body.string(Number(k), v);
      else body.int32(Number(k), v);
    }
    return new ProtoWriter().int32(1, 2).int32(2, 1).message(4, body.data).data;
  }

  it("decodes the fields observed on hardware", () => {
    const s = parseSettingsSnapshot(
      snapshot({ 12: 57, 5: "2.2.7.14", 6: "2.2.7.14", 2: 14, 18: 1, 8: 30, 10: 1, 14: 1 })
    )!;
    expect(s.battery).toBe(57);
    expect(s.leftFirmware).toBe("2.2.7.14");
    expect(s.brightness).toBe(14);
    expect(s.headUpAngle).toBe(30);
    expect(s.wearDetection).toBe(1);   // proven on-glass
    expect(s.silentMode).toBe(1);      // proven on-glass
  });

  /**
   * REGRESSION. x is field 4 and y is field 3. Fields 15/16 are left/rightCalibrationRestored —
   * BRIGHTNESS calibration. Reading 15/16 as the lens offset reported one setting under another's
   * name, and the only reason it surfaced is that a non-zero lensX set on hardware stubbornly
   * read back absent.
   */
  it("reads lens x/y from fields 4/3 — NOT 15/16, which are brightness calibration", () => {
    const s = parseSettingsSnapshot(snapshot({ 4: 7, 3: 9, 15: 111, 16: 222 }))!;
    expect(s.lensX).toBe(7);
    expect(s.lensY).toBe(9);
    expect(s.leftBrightnessCalibration).toBe(111);
    expect(s.rightBrightnessCalibration).toBe(222);
  });

  it("absent means zero — a switch that is off is simply not encoded", () => {
    const s = parseSettingsSnapshot(snapshot({ 12: 50 }))!;
    expect(s.battery).toBe(50);
    expect(s.silentMode).toBeUndefined();  // i.e. off
    expect(s.wearDetection).toBeUndefined();
  });

  it("returns null for a payload that is not a snapshot", () => {
    expect(parseSettingsSnapshot(new ProtoWriter().int32(1, 1).data)).toBeNull();
  });
});
