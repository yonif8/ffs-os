// Inbound event normalization — decoded from CAPTURED BYTES, not from a schema.
//
// Every field number here was read off a frame the glasses actually sent, and the awkward parts
// below exist because the schema alone would have been wrong in ways that matter.

import { f32, parseFields, str, sub, u32 } from "./proto";

/**
 * What the firmware reports a user did. From the generated schema, cross-checked against
 * captured frames.
 *
 * ⚠️ There is NO long-press. The reference kit's prose docs claim one; the generated schema has
 * no such value and no capture has ever shown one. Do not design a gesture around it.
 */
export const EventType = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7,
  /** A head-motion sample rather than anything the user deliberately did. */
  IMU_DATA_REPORT: 8,
} as const;
export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

/**
 * WHICH input produced the event. The R1 ring is a first-class source alongside the temple pads.
 *
 * ⚠️ There is no zero member, so an ABSENT EventSource means "unknown" — NOT source 0. This is the
 * one place where absent-means-zero does not apply, and guessing here would silently attribute
 * every ring press to the right temple.
 */
export const EventSource = {
  GLASSES_R: 1,
  RING: 2,
  GLASSES_L: 3,
} as const;

export type GlassesEvent =
  | { kind: "select"; containerId: number; containerName?: string; index: number; itemName?: string; type: number; source?: number }
  | { kind: "text-click"; containerId: number; containerName?: string; type: number }
  | { kind: "sys"; type: number; source?: number }
  | { kind: "imu"; x: number; y: number; z: number }
  | { kind: "private"; containerId: number; containerName?: string; eventId: number; eventData: number };

/**
 * Decode one inbound EvenHub payload into a normalized event, or null if it is not an event.
 *
 * Envelope: Cmd=1, MagicRandom=2, DevEvent=13, DevPrivateEvent=16.
 *   Cmd 2 OS_NOITY_EVENT_TO_APP_PACKET -> DevEvent{ ListEvent=1, TextEvent=2, SysEvent=3 }
 *   List_ItemEvent: ContainerID=1, ContainerName=2, CurrentSelectItemName=3,
 *                   CurrentSelectItemIndex=4, EventType=5
 *
 * ⚠️⚠️ PROTO3 OMITS DEFAULTS, and the field that matters most is the one most often ABSENT.
 * Measured on hardware: tapping row 0 yields NO index field and NO event-type field at all,
 * because both are 0. Reading them as undefined makes "the user chose the first row with a single
 * tap" — by far the commonest event in any menu — look like a decode failure. Absent scalar means
 * ZERO here. This cost a real bug; the golden vectors in `wire.test.ts` pin it.
 *
 * ⚠️ On our firmware a list event arrives in the SAME FRAME as the gesture, not on a separate
 * event path as the reference kit implies. Callers must therefore run this decoder on the gesture
 * path too, or they will never see a selection.
 */
export function normalizeEvent(payload: Uint8Array): GlassesEvent | null {
  const f = parseFields(payload);
  if (!f) return null;
  const cmd = u32(f, 1);
  if (cmd === undefined) return null;

  const devEvent = sub(f, 13);
  if (devEvent) {
    const d = parseFields(devEvent);

    const list = sub(d, 1);
    if (list) {
      const e = parseFields(list);
      return {
        kind: "select",
        containerId: u32(e, 1) ?? 0,
        containerName: str(e, 2),
        itemName: str(e, 3), // absent in every capture we hold — do not rely on it
        index: u32(e, 4) ?? 0, // ABSENT MEANS ROW 0
        type: u32(e, 5) ?? EventType.CLICK, // ABSENT MEANS CLICK
        source: u32(e, 6), // no zero member — leave undefined when absent
      };
    }

    const text = sub(d, 2);
    if (text) {
      const e = parseFields(text);
      return {
        kind: "text-click",
        containerId: u32(e, 1) ?? 0,
        containerName: str(e, 2),
        type: u32(e, 3) ?? EventType.CLICK,
      };
    }

    const sys = sub(d, 3);
    if (sys) {
      const e = parseFields(sys);
      // IMU samples ride on a SysEvent (field 3 = IMU_Report_Data). They may arrive tagged
      // EventType 8, but the reference implementations note the payload can ride on any sys
      // event — so key off the presence of the data, not off the type.
      const imu = sub(e, 3);
      if (imu) {
        const v = parseFields(imu);
        // ⚠️ float32, NOT double. The generated schema says `double`; the firmware emits wire
        // type 5. Reading it as the schema claims yields garbage or nothing at all.
        const x = f32(v, 1);
        const y = f32(v, 2);
        const z = f32(v, 3);
        if (x !== undefined && y !== undefined && z !== undefined) {
          return { kind: "imu", x, y, z };
        }
      }
      return {
        kind: "sys",
        type: u32(e, 1) ?? EventType.CLICK,
        source: u32(e, 2),
      };
    }
  }

  const priv = sub(f, 16);
  if (priv) {
    const e = parseFields(priv);
    return {
      kind: "private",
      containerId: u32(e, 1) ?? 0,
      containerName: str(e, 2),
      eventId: u32(e, 3) ?? 0,
      eventData: u32(e, 4) ?? 0,
    };
  }

  return null;
}

export function describeEvent(e: GlassesEvent): string {
  const t = (v: number) =>
    (Object.keys(EventType) as (keyof typeof EventType)[]).find((k) => EventType[k] === v) ?? `type(${v})`;
  const s = (v?: number) =>
    v === undefined
      ? "unknown"
      : (Object.keys(EventSource) as (keyof typeof EventSource)[]).find((k) => EventSource[k] === v) ??
        `source(${v})`;
  switch (e.kind) {
    case "select":
      return `select index=${e.index} container='${e.containerName ?? e.containerId}' type=${t(e.type)} src=${s(e.source)}`;
    case "text-click":
      return `text-click container='${e.containerName ?? e.containerId}' type=${t(e.type)}`;
    case "sys":
      return `sys type=${t(e.type)} src=${s(e.source)}`;
    case "imu":
      return `imu x=${e.x.toFixed(3)} y=${e.y.toFixed(3)} z=${e.z.toFixed(3)}`;
    case "private":
      return `private container='${e.containerName ?? e.containerId}' id=${e.eventId} data=${e.eventData}`;
  }
}

/** An image-fragment acknowledgement from the glasses. */
export interface ImageAck {
  session: number;
  fragment: number;
  ok: boolean;
}

/**
 * Decode an inbound image-fragment ACK, or null if the payload is not one.
 *
 * ImgResCmd is response field 6: inner f3 = session, f6 = fragmentIndex, f8 = errorCode, where
 * SUCCESS IS 4 — not 0. That is the kind of detail worth pinning in a test, because treating 0
 * as success would make every fragment look failed and every success look like a timeout.
 *
 * This exists so the TypeScript image path can ACK-GATE its fragments the way the native driver
 * does: arm on fragment N, send it, wait for its ACK, then send N+1. Firing fragments blind with
 * a fixed delay ACKs fine and renders nothing.
 */
export function parseImageAck(payload: Uint8Array): ImageAck | null {
  const f = parseFields(payload);
  if (!f) return null;
  const body = sub(f, 6);
  if (!body) return null;
  const r = parseFields(body);
  if (!r) return null;
  const session = u32(r, 3);
  const fragment = u32(r, 6);
  if (session === undefined && fragment === undefined) return null;
  return { session: session ?? 0, fragment: fragment ?? 0, ok: (u32(r, 8) ?? 0) === 4 };
}

/**
 * EvenHub_ErrorCode_List — the firmware's verdict on what we just sent.
 *
 * ⚠️ It is ONE enum shared by every response, so the value's meaning depends on which response
 * carried it. 4 means "image data accepted", 0 means "page created" — a decoder that treats a
 * single number as universally good or bad will be wrong half the time.
 */
export const EvenHubError = {
  CREATE_PAGE_SUCCESS: 0,
  CREATE_INVALID_CONTAINER: 1,
  CREATE_OVERSIZE_CONTAINER: 2,
  CREATE_OUT_OF_MEMORY: 3,
  IMAGE_DATA_SUCCESS: 4,
  IMAGE_DATA_FAILED: 5,
  REBUILD_SUCCESS: 6,
  REBUILD_FAILED: 7,
  TEXT_UPDATE_SUCCESS: 8,
  TEXT_UPDATE_FAILED: 9,
  SHUTDOWN_SUCCESS: 10,
  SHUTDOWN_FAILED: 11,
  HEARTBEAT_SUCCESS: 12,
  AUDIO_SUCCESS: 13,
} as const;

const ERROR_NAMES: Record<number, string> = {
  0: "CREATE_PAGE_SUCCESS",
  1: "CREATE_INVALID_CONTAINER",
  2: "CREATE_OVERSIZE_CONTAINER",
  3: "CREATE_OUT_OF_MEMORY",
  4: "IMAGE_DATA_SUCCESS",
  5: "IMAGE_DATA_FAILED",
  6: "REBUILD_SUCCESS",
  7: "REBUILD_FAILED",
  8: "TEXT_UPDATE_SUCCESS",
  9: "TEXT_UPDATE_FAILED",
  10: "SHUTDOWN_SUCCESS",
  11: "SHUTDOWN_FAILED",
  12: "HEARTBEAT_SUCCESS",
  13: "AUDIO_SUCCESS",
};

export interface PageResponse {
  /** Which request this answers. */
  kind: "create" | "rebuild" | "text" | "shutdown";
  code: number;
  name: string;
  ok: boolean;
}

/**
 * Decode the firmware's verdict on a page request, or null if this frame is not one.
 *
 * THIS IS THE DIAGNOSTIC THAT WAS MISSING ALL NIGHT. Every page we sent that produced a black
 * HUD — the 5-list page, the image page — was almost certainly answered with a reason, and we
 * were not listening. `CREATE_INVALID_CONTAINER` / `OVERSIZE` / `OUT_OF_MEMORY` distinguish
 * "the page was malformed" from "the page was fine but nothing drew", which are otherwise
 * indistinguishable and cost several hardware cycles to tell apart by elimination.
 *
 * Envelope response fields: f4 create, f8 rebuild, f10 text update, f12 shutdown. Each carries
 * ResCmdMsg in its own field 1.
 */
export function parsePageResponse(payload: Uint8Array): PageResponse | null {
  const f = parseFields(payload);
  if (!f) return null;
  const slots: Array<[number, PageResponse["kind"], number]> = [
    [4, "create", EvenHubError.CREATE_PAGE_SUCCESS],
    [8, "rebuild", EvenHubError.REBUILD_SUCCESS],
    [10, "text", EvenHubError.TEXT_UPDATE_SUCCESS],
    [12, "shutdown", EvenHubError.SHUTDOWN_SUCCESS],
  ];
  for (const [field, kind, okCode] of slots) {
    const body = sub(f, field);
    if (!body) continue;
    // ResCmdMsg is field 1, and proto3 omits a zero — which for a CREATE is SUCCESS.
    const code = u32(parseFields(body), 1) ?? 0;
    return { kind, code, name: ERROR_NAMES[code] ?? `code(${code})`, ok: code === okCode };
  }
  return null;
}
