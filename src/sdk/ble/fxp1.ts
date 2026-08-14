// The FXP1 CFW-push surface — how the SDK reaches NATIVE code with no reflash.
//
// The CFW loader watches the EvenHub image channel (sid 0xe0, Cmd 3). When the bytes reassembled
// from a Cmd-3 image-raw sequence begin with the magic "FXP1", `zlib_glue`'s image_dispatch routes
// them to `cfw_loader_ingest` instead of the pixel decoder: it validates magic + length + CRC-32,
// copies the body into the permanent 16 KB arena, and a 100 ms display-thread lv_timer blx's
// `payload_main`. So "phone declares once, glasses run native code" is literally: send a Cmd-3
// image-raw whose reassembled payload is an FXP1 frame. (FINDINGS-ble-command-surface §7.)
//
// Frame:  "FXP1" + u32 body_len(LE) + u32 crc32(body)(LE) + body
// The `body` is the FFSP program image from program.ts (`assemble(p).image` / `.object`).
//
// TWO fragmentation layers stack here and must not be confused:
//   1. EvenHub image-raw (this file): the FXP1 frame is split into <=4096-byte chunks, each an
//      independent Cmd-3 message (session id, totalSize, fragmentIndex). Firmware reassembles by
//      index into the full FXP1 blob before the loader ever sees it.
//   2. aa21 transport (envelope.ts): each of those Cmd-3 messages is itself chunked into 236-byte
//      BLE frames with the CRC-16 on the last one.
//
// [M] Nothing here is proven on-glass; the byte layout is pinned to the proven native image path
// (G2Central.sendAnimFrameLocked + G2EvenHub.imageRawDataUpdate) and unit-tested, no more.

import { encodeImageRawData } from "../wire";
import { crc32 } from "./crc";
import { Counters, Flag, SID, frameMessage } from "./envelope";

/** "FXP1" — the loader reads bytes 0..3 as 0x31505846 (LE) and rejects anything else. */
export const FXP1_MAGIC = [0x46, 0x58, 0x50, 0x31] as const;

/** loader.c `LDR_MAX_PAYLOAD`. A body over this is refused with REJ_CAP. */
export const LDR_MAX_PAYLOAD = 8192;

/** The proven native image-raw chunk size (`G2Central.IMG_FRAGMENT_SIZE`). */
export const IMG_FRAGMENT_SIZE = 4096;

/** The CFW loader's fixed container id / name for a payload push. */
export const FXP1_CONTAINER_ID = 2;
export const FXP1_CONTAINER_NAME = "ffs-rast";

/**
 * Wrap a raw body (an FFSP program image) in the loader's FXP1 frame.
 * Throws on an empty body or one past `LDR_MAX_PAYLOAD` — both are refusals the loader would emit,
 * caught here so the failure is a thrown error rather than a silent on-glass no-op.
 */
export function fxp1Frame(body: Uint8Array): Uint8Array {
  if (body.length === 0) throw new Error("FXP1: empty body");
  if (body.length > LDR_MAX_PAYLOAD) {
    throw new Error(
      `FXP1: body ${body.length} B exceeds LDR_MAX_PAYLOAD (${LDR_MAX_PAYLOAD}) — loader would REJ_CAP`
    );
  }
  const out = new Uint8Array(12 + body.length);
  out.set(FXP1_MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, body.length, true);
  dv.setUint32(8, crc32(body), true);
  out.set(body, 12);
  return out;
}

export interface ImageRawChunkOptions {
  containerId?: number;
  containerName?: string;
  sessionId: number;
  maxChunk?: number;
  /** first fragmentIndex; the proven native path starts at 0 and increments. */
  firstIndex?: number;
}

/**
 * Split a payload (typically an FXP1 frame) into the Cmd-3 image-raw inner-pb messages the firmware
 * reassembles. Each message carries the WHOLE payload's `totalSize`, its own `fragmentPacketSize`,
 * and an incrementing `fragmentIndex`. `magic` is per-message (caller supplies via `nextMagic`).
 *
 * Mirrors `G2Central.sendAnimFrameLocked`: 4096-byte chunks, fragmentIndex 0-based, compressMode 0.
 */
export function chunkImageRaw(
  payload: Uint8Array,
  opts: ImageRawChunkOptions,
  nextMagic: () => number
): Uint8Array[] {
  if (payload.length === 0) return [];
  const maxChunk = opts.maxChunk ?? IMG_FRAGMENT_SIZE;
  const messages: Uint8Array[] = [];
  let off = 0;
  let fragIdx = opts.firstIndex ?? 0;
  while (off < payload.length) {
    const end = Math.min(off + maxChunk, payload.length);
    const chunk = payload.subarray(off, end);
    messages.push(
      encodeImageRawData({
        containerId: opts.containerId ?? FXP1_CONTAINER_ID,
        containerName: opts.containerName ?? FXP1_CONTAINER_NAME,
        sessionId: opts.sessionId,
        totalSize: payload.length,
        fragmentIndex: fragIdx,
        data: chunk,
        magic: nextMagic(),
      })
    );
    off = end;
    fragIdx += 1;
  }
  return messages;
}

export interface Fxp1PushOptions {
  sessionId: number;
  counters?: Counters;
  containerId?: number;
  containerName?: string;
  maxChunk?: number;
  maxPayload?: number;
}

export interface Fxp1Push {
  /** the FXP1 frame ("FXP1"+len+crc32+body). */
  fxp1: Uint8Array;
  /** the Cmd-3 image-raw inner-pb messages, in order. */
  imageRawMessages: Uint8Array[];
  /** every aa21 transport frame to write, in order across all image-raw messages. */
  frames: Uint8Array[];
}

/**
 * The one-call CFW push: FFSP program image -> FXP1 frame -> Cmd-3 image-raw fragments -> aa21
 * transport frames on sid 0xe0, flag REQUEST. Hand `frames` to the transport in order.
 *
 * Each image-raw message consumes its own syncId (transport reassembly key) and its own magic
 * (ack key), exactly as the native driver does.
 */
export function buildFxp1Push(programImage: Uint8Array, opts: Fxp1PushOptions): Fxp1Push {
  const counters = opts.counters ?? new Counters();
  const fxp1 = fxp1Frame(programImage);
  const imageRawMessages = chunkImageRaw(
    fxp1,
    {
      sessionId: opts.sessionId,
      containerId: opts.containerId,
      containerName: opts.containerName,
      maxChunk: opts.maxChunk,
    },
    () => counters.nextMagic()
  );
  const frames: Uint8Array[] = [];
  for (const msg of imageRawMessages) {
    frames.push(
      ...frameMessage(msg, {
        syncId: counters.nextSyncId(),
        sid: SID.UI_BACKGROUND_EVENHUB,
        flag: Flag.REQUEST,
        maxPayload: opts.maxPayload,
      })
    );
  }
  return { fxp1, imageRawMessages, frames };
}
