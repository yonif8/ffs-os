// The page encoder — pure TypeScript, byte-identical to the native driver.
//
// ACCEPTANCE (spec step 0): `encodeListPage` must reproduce `G2EvenHub.listPageMessage` byte for
// byte. That equivalence is what lets the SDK own encoding without a flag day: the native path and
// the SDK path emit the same wire, so they can be swapped or cross-checked at any time.

import { ProtoWriter } from "./proto";

/** EvenHub command ids (field 1 of evenhub_main_msg_ctx). */
export const Cmd = {
  CREATE_STARTUP_PAGE: 0,
  REBUILD_PAGE: 7,
} as const;

/**
 * Fixed container ids by ROLE.
 *
 * These are firmware LOOKUP KEYS — `evenhub_container_find_node_by_id(id)` at VA 0x004e5767,
 * which our CFW probes sweep 0..255. They must stay constant per role and must never carry a
 * sequence number or epoch. Identity across re-declares lives in the NAME, which is proven to echo
 * back verbatim on events (`ContainerName="ffs-list"` came off the wire unchanged).
 */
export const CONTAINER_IDS = {
  event: 0,
  text: 1,
  raster: 2,
  list: 3,
} as const;

/** The declared canvas the firmware composites into. @proven */
export const CANVAS = { width: 576, height: 288 } as const;

/**
 * Height of the header strip on a titled list page. 40px matches the proven Kotlin
 * `listWithHeaderPage`, and leaves the list a 248px viewport.
 */
export const HEADER_HEIGHT = 40;

export interface ListContainerSpec {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  containerId?: number;
  containerName?: string;
  items: readonly string[];
  isEventCapture?: boolean;
  itemWidth?: number;
  selectBorder?: boolean;
  borderWidth?: number;
  borderColor?: number;
  borderRadius?: number;
  paddingLength?: number;
}

/**
 * ListObject:
 *   f1..f4 geometry, f5 borderWidth, f6 borderColor, f7 borderRadius, f8 paddingLength,
 *   f9 containerID, f10 containerName,
 *   f11 List_ItemContainerProperty { f1 ItemCount, f2 ItemWidth, f3 IsItemSelectBorderEn,
 *                                    f4 repeated ItemName },
 *   f12 IsEventCapture
 *
 * NOTE every field is written even when zero. Proto3 would normally omit defaults, but the native
 * encoder writes them unconditionally and the firmware accepts that, so we match it exactly rather
 * than "improve" it — byte-identity with the proven path is the whole point.
 */
export function encodeListContainer(s: ListContainerSpec): Uint8Array {
  const width = s.width ?? CANVAS.width;
  const height = s.height ?? CANVAS.height;
  const itemWidth = s.itemWidth && s.itemWidth > 0 ? s.itemWidth : width;

  const item = new ProtoWriter();
  item.int32(1, s.items.length);
  item.int32(2, itemWidth);
  item.int32(3, (s.selectBorder ?? true) ? 1 : 0);
  for (const name of s.items) item.string(4, name);

  const w = new ProtoWriter();
  w.int32(1, s.x ?? 0);
  w.int32(2, s.y ?? 0);
  w.int32(3, width);
  w.int32(4, height);
  w.int32(5, s.borderWidth ?? 0);
  w.int32(6, s.borderColor ?? 0);
  w.int32(7, s.borderRadius ?? 0);
  w.int32(8, s.paddingLength ?? 0);
  w.int32(9, s.containerId ?? CONTAINER_IDS.list);
  if (s.containerName != null) w.string(10, s.containerName);
  w.message(11, item.data);
  w.int32(12, (s.isEventCapture ?? true) ? 1 : 0);
  return w.data;
}

export interface TextContainerSpec {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  containerId?: number;
  containerName?: string;
  content: string;
  /**
   * Whether this container captures gestures. Leave FALSE on any page that also carries a list:
   * the firmware binds events to exactly ONE container per page, so a capturing text container
   * would steal the swipes the list needs and freeze it.
   */
  isEventCapture?: boolean;
  borderWidth?: number;
  borderColor?: number;
  borderRadius?: number;
  paddingLength?: number;
}

/**
 * TextObject:
 *   f1..f4 geometry, f5 borderWidth, f6 borderColor, f7 borderRadius, f8 paddingLength,
 *   f9 containerID, f10 containerName, f11 IsEventCapture, f12 content
 *
 * Field-for-field identical to the Kotlin `textContainer` that is proven on hardware, including
 * writing zero-valued fields that proto3 would normally omit.
 */
export function encodeTextContainer(s: TextContainerSpec): Uint8Array {
  const w = new ProtoWriter();
  w.int32(1, s.x ?? 0);
  w.int32(2, s.y ?? 0);
  w.int32(3, s.width ?? CANVAS.width);
  w.int32(4, s.height ?? CANVAS.height);
  w.int32(5, s.borderWidth ?? 0);
  w.int32(6, s.borderColor ?? 0);
  w.int32(7, s.borderRadius ?? 0);
  w.int32(8, s.paddingLength ?? 0);
  w.int32(9, s.containerId ?? CONTAINER_IDS.text);
  if (s.containerName != null) w.string(10, s.containerName);
  w.int32(11, (s.isEventCapture ?? false) ? 1 : 0);
  w.string(12, s.content);
  return w.data;
}

/**
 * CreateStartUpPageContainer: f1 = total container count, f2 = repeated ListObject,
 * f3 = repeated TextObject, f4 = repeated ImageObject.
 *
 * ⚠️ Ordering matters and is NOT cosmetic: images are field 4 and are emitted last, so a
 * full-canvas image container declared alongside a list draws OVER it.
 */
export function encodePageContainer(parts: {
  lists?: readonly Uint8Array[];
  texts?: readonly Uint8Array[];
  images?: readonly Uint8Array[];
}): Uint8Array {
  const lists = parts.lists ?? [];
  const texts = parts.texts ?? [];
  const images = parts.images ?? [];
  const w = new ProtoWriter();
  w.int32(1, lists.length + texts.length + images.length);
  for (const b of lists) w.message(2, b);
  for (const b of texts) w.message(3, b);
  for (const b of images) w.message(4, b);
  return w.data;
}

/** evenhub_main_msg_ctx: f1 = Cmd, f2 = MagicRandom, f<sub> = payload. */
export function encodeEnvelope(
  cmd: number,
  subField: number,
  payload: Uint8Array,
  magic: number
): Uint8Array {
  const w = new ProtoWriter();
  w.int32(1, cmd);
  w.int32(2, magic);
  w.message(subField, payload);
  return w.data;
}

/**
 * A page whose whole content is one native, interactive list — the launcher primitive.
 *
 * ⚠️ THE evt-0 TRAP. The firmware binds events to exactly ONE container per page
 * ("evenhub_bind_event_container: already has event binding"). The generic page builder normally
 * prepends a full-canvas `evt-0` capture container so gestures work everywhere; doing that here
 * would STARVE the list of the very swipes it needs, and the failure mode is a list that renders
 * and then sits frozen — indistinguishable from "the firmware refuses to do this". So a capturing
 * list page carries NO evt-0. This function cannot emit one, by construction.
 *
 * `rebuild` selects Cmd 7 / sub-field 7; a second CREATE is silently ignored by the firmware,
 * which was the "stuck on the image, can't show text again" bug (FUT-153).
 */
export function encodeListPage(opts: {
  items: readonly string[];
  rebuild: boolean;
  magic: number;
  containerId?: number;
  containerName?: string;
  images?: readonly Uint8Array[];
  /**
   * Optional title drawn above the list in its own text container.
   *
   * Free, because a page CAN carry a capturing list AND a text container at once — proven
   * on-glass 2026-08-08 (docs/proof/page-mixed-list-and-text.png). Had that been false, every
   * screen would have had to spend row 0 on its own title.
   */
  header?: string;
}): Uint8Array {
  // The header takes a strip off the top and the list keeps the rest; with no header the list
  // owns the whole canvas exactly as before.
  const headerHeight = opts.header ? HEADER_HEIGHT : 0;
  const lc = encodeListContainer({
    x: 0,
    y: headerHeight,
    width: CANVAS.width,
    height: CANVAS.height - headerHeight,
    containerId: opts.containerId ?? CONTAINER_IDS.list,
    containerName: opts.containerName ?? "ffs-list",
    items: opts.items,
    isEventCapture: true,
  });
  const texts = opts.header
    ? [
        encodeTextContainer({
          x: 0,
          y: 0,
          width: CANVAS.width,
          height: HEADER_HEIGHT,
          containerId: CONTAINER_IDS.text,
          containerName: "ffs-hdr",
          content: opts.header,
          // NEVER capturing — see the evt-0 trap above; the list must keep the gestures.
          isEventCapture: false,
        }),
      ]
    : undefined;
  const page = encodePageContainer({ lists: [lc], texts, images: opts.images });
  return opts.rebuild
    ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, opts.magic)
    : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, opts.magic);
}
