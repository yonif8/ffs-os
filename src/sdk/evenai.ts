// Even-AI service (sid 0x07, the EvenAIDataPackage subsystem) — pure TypeScript wire encoders.
//
// This is the channel that drives Even's native voice/AI session. We touch a NARROW slice of it:
// the "Hey Even" wake-word CONFIG. The AI ASK path (which submits a question to Even's cloud) is
// deliberately NOT built here — see the privacy note on `setHeyEven`.
//
// Field numbers come from the GENERATED schema
// `reference/g2-kit-unofficial/ble/gen/even_ai_pb.ts` (MIT), cross-checked against MentraOS
// `EvenAIProto.setHeyEven` (reference/MentraOS/.../sgcs/G2.kt, MIT) — the two agree byte for byte.
//
//     EvenAIDataPackage { commandId=1, magicRandom=2, ..., config=13 }
//     eEvenAICommandId  { ..., CONFIG=10, ... }
//     EvenAIConfig      { voiceSwitch=1, streamSpeed=2, errorCode=3, duplexMode=4 }
//
// The Kotlin twin lives in `modules/ffs-ble/.../G2Protocol.kt` `G2EvenAI` (which already carried
// `ctrl`/`ask`; `setHeyEven` is added there alongside this).

import { ProtoWriter } from "./proto";

/** service_id_def.SID.EVEN_AI — the Even-AI subsystem's routing id. */
export const SID_EVEN_AI = 0x07;

/** eEvenAICommandId — field 1 of an EvenAIDataPackage. Only the ones we encode are listed. */
export const EvenAiCmd = {
  /** EvenAIControl (enter/exit an AI session) — carried by the Kotlin `G2EvenAI.ctrl`. */
  CTRL: 1,
  /** EvenAIAskInfo (submit a question) — carried by the Kotlin `G2EvenAI.ask`. */
  ASK: 3,
  /** EvenAIConfig (wake-word + stream settings). */
  CONFIG: 10,
} as const;

/** EvenAIDataPackage sub-message field numbers. */
const Field = {
  ctrl: 3,
  askInfo: 5,
  config: 13,
} as const;

/** EvenAIConfig sub-fields. */
const ConfigField = {
  voiceSwitch: 1,
  streamSpeed: 2,
} as const;

/**
 * The stream-speed the Even app always sends with a CONFIG. Not a rate we chose — it is the
 * constant MentraOS mirrors from the official app (`streamSpeed = 32`). Sent whether the wake word
 * is on or off.
 */
export const HEY_EVEN_STREAM_SPEED = 32;

function evenAiEnvelope(cmd: number, subField: number, payload: Uint8Array, magic: number): Uint8Array {
  const w = new ProtoWriter();
  w.int32(1, cmd);
  w.int32(2, magic);
  w.message(subField, payload);
  return w.data;
}

/**
 * "Hey Even" WAKE WORD — enable or disable the on-glass wake-word detector (the GX8002 hot-word
 * path). `enabled=true` writes `voiceSwitch=1`; `enabled=false` OMITS `voiceSwitch` entirely,
 * matching the official app (proto3 default omission — an absent switch reads as 0/off). Either
 * way, `streamSpeed=32` is always sent.
 *
 * Byte-identical to MentraOS `EvenAIProto.setHeyEven`, which is why this is a clean wire addition:
 *
 *     EvenAIConfig { voiceSwitch = (enabled ? 1 : absent), streamSpeed = 32 }
 *     EvenAIDataPackage { commandId = 10 (CONFIG), magicRandom, config = 13 }
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────────
 * ⚠️ Enabling the wake word means the glasses LISTEN for "Hey Even" continuously. That is a very
 * different posture from our push-to-talk mic (`src/sdk/mic.ts`), and the memory `mic-opens-itself`
 * records that a self-opening mic is exactly how three unexplained audio bursts happened. This
 * builder only encodes the toggle; a caller that turns the wake word ON owns telling the wearer,
 * and nothing derived from any audio it triggers may reach `glog`.
 *
 * ⚠️ DEVICE-PROOF-OWED: encoding is schema- and MentraOS-cross-checked, but whether OUR takeover
 * firmware acts on a CONFIG the same way stock does is unproven on-glass.
 */
export function setHeyEven(magic: number, enabled: boolean): Uint8Array {
  const cfg = new ProtoWriter();
  if (enabled) cfg.int32(ConfigField.voiceSwitch, 1);
  cfg.int32(ConfigField.streamSpeed, HEY_EVEN_STREAM_SPEED);
  return evenAiEnvelope(EvenAiCmd.CONFIG, Field.config, cfg.data, magic);
}
