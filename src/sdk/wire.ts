// The page encoder — pure TypeScript, byte-identical to the native driver.
//
// ACCEPTANCE (spec step 0): `encodeListPage` must reproduce `G2EvenHub.listPageMessage` byte for
// byte. That equivalence is what lets the SDK own encoding without a flag day: the native path and
// the SDK path emit the same wire, so they can be swapped or cross-checked at any time.

import { ProtoWriter } from "./proto";

/** EvenHub command ids (field 1 of evenhub_main_msg_ctx). */
export const Cmd = {
  CREATE_STARTUP_PAGE: 0,
  /** ImageRawDataUpdate — stream pixels into an image container. */
  UPDATE_IMAGE_RAW_DATA: 3,
  /** TextContainerUpgrade — change a live container's text WITHOUT rebuilding the page. */
  UPDATE_TEXT_DATA: 5,
  /** APP_REQUEST_OPEN_IMU_PACKET — start/stop the head-motion stream. */
  IMU_CONTROL: 19,
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
  // A titled page gets the launcher's visual language: the title LETTERSPACED (the only
  // hierarchy lever this device has — there is no font size or weight field) and a hairline
  // under it. The rule is literal underscores because text containers ignore every border
  // field, proven on-glass.
  //
  // Only when a header is present: a header-less page must stay byte-identical to the native
  // list page, which a golden test pins.
  const texts = opts.header
    ? [
        encodeTextContainer({
          x: 0,
          y: 0,
          width: CANVAS.width,
          height: HEADER_HEIGHT,
          containerId: CONTAINER_IDS.text,
          containerName: "ffs-hdr",
          content: opts.header.split("").join(" "),
          // NEVER capturing — see the evt-0 trap above; the list must keep the gestures.
          isEventCapture: false,
        }),
        encodeTextContainer({
          x: 8,
          y: HEADER_HEIGHT - 6,
          width: CANVAS.width - 16,
          height: 22,
          containerId: 11,
          containerName: "ffs-hrule",
          content: "_".repeat(44),
          isEventCapture: false,
        }),
      ]
    : undefined;
  const page = encodePageContainer({ lists: [lc], texts, images: opts.images });
  return opts.rebuild
    ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, opts.magic)
    : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, opts.magic);
}

/**
 * Change the text of a container that is ALREADY on screen, without rebuilding the page.
 *
 * Why this matters beyond saving bytes: a REBUILD re-declares the whole page, which resets the
 * list's focus back to row 0. So anything that ticks — a clock, a timer, a battery readout —
 * cannot be done with a rebuild without yanking the user's selection out from under them. This
 * is the only way to have a live value on a screen the user is also navigating.
 *
 * `contentOffset` is 0 and `contentLength` is the UTF-8 byte length, matching the Kotlin
 * encoder exactly.
 */
export function encodeUpdateText(opts: {
  containerId: number;
  content: string;
  magic: number;
}): Uint8Array {
  const bytes = new TextEncoder().encode(opts.content);
  const u = new ProtoWriter();
  u.int32(1, opts.containerId);
  u.int32(3, 0);
  u.int32(4, bytes.length);
  u.string(5, opts.content);
  return encodeEnvelope(Cmd.UPDATE_TEXT_DATA, 9, u.data, opts.magic);
}

/**
 * Valid IMU report paces. NOT literal Hz — the firmware takes an ImuReportPace CODE, and the
 * documented range is 100..1000 in steps of 100.
 */
export const IMU_PACES = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] as const;

/**
 * The wrapper field `IMU_CtrlCmd` occupies in evenhub_main_msg_ctx.
 *
 * ⚠️ 22, NOT 20 — and this is now SETTLED rather than a majority vote. The number is read
 * straight out of the generated FileDescriptorProto in
 * `reference/g2-kit-unofficial/ble/gen/EvenHub_pb.ts`, which assigns:
 *
 *     field 20 -> MenuStartEv (MenuStartUpEvent)
 *     field 22 -> ImuCtrl     (IMU_CtrlCmd)
 *
 * So MentraOS's 20 (`reference/MentraOS/.../sgcs/G2.kt:503` and `G2.swift:519`) does not merely
 * disagree — it names a DIFFERENT message. faceclaw's independent Java driver
 * (`reference/faceclaw/.../g2protocol/BleProtocol.java:290`) uses 22, matching the descriptor.
 *
 * Why the mistake is expensive: a wrong wrapper field is SILENT. Protobuf skips fields it does
 * not recognise, so the glasses accept the frame, open nothing, and are indistinguishable from
 * hardware whose IMU does not work.
 */
export const IMU_CTRL_FIELD = 22;

/**
 * Start or stop the IMU (head-motion) stream — the one message that opens the sensor hub.
 *
 * `IMU_CtrlCmd { uint32 IMUReportEn = 1; uint32 reportFrq = 2; }`, per the generated descriptor.
 * Both fields are uint32, so a plain varint is correct for each.
 *
 * `pace` is omitted entirely when disabling, and when non-positive — both reference drivers only
 * encode it when turning the stream ON, and inventing a field neither has ever put on the wire is
 * exactly the kind of guess that produces an unexplainable refusal.
 */
export function encodeImuControl(opts: {
  enable: boolean;
  magic: number;
  pace?: number;
  /**
   * Override the wrapper field. Retained only as an escape hatch — the default is proven by the
   * descriptor above and there is no longer a 22-vs-20 question to resolve empirically.
   */
  field?: number;
}): Uint8Array {
  const pace = opts.pace ?? 100;
  const c = new ProtoWriter();
  c.int32(1, opts.enable ? 1 : 0);
  if (opts.enable && pace > 0) c.int32(2, pace);
  return encodeEnvelope(Cmd.IMU_CONTROL, opts.field ?? IMU_CTRL_FIELD, c.data, opts.magic);
}

/**
 * A style probe page — the empirical answer to "what do the border fields actually DO?".
 *
 * Every container encoder has carried borderWidth / borderColor / borderRadius / paddingLength
 * since the beginning and NOTHING has ever set them to a non-zero value, so their visual effect
 * on a monochrome emissive panel is pure assumption. A launcher made of rounded tiles is built
 * entirely on that assumption, so it gets tested before it gets designed around.
 *
 * Also answers the load-bearing question for an icon column: when a LIST is made NARROW with
 * single-character rows, is its native selected-row highlight a rounded SQUARE? If so, the
 * firmware itself draws the iPhone-style tile and the phone never has to.
 */
export function encodeStyleProbePage(opts: { rebuild: boolean; magic: number }): Uint8Array {
  // A narrow list: if the highlight tracks the container width, this makes it a rounded square.
  const list = encodeListContainer({
    x: 12, y: 40, width: 56, height: 232,
    containerId: CONTAINER_IDS.list,
    containerName: "ffs-list",
    items: ["A", "B", "C", "D"],
    itemWidth: 56,
    selectBorder: true,
    isEventCapture: true,
  });

  // A radius/width sweep. Same box, different border settings, so any difference IS the field.
  const boxes: Uint8Array[] = [];
  const sweep = [
    { r: 0, w: 1, label: "r0" },
    { r: 6, w: 1, label: "r6" },
    { r: 14, w: 2, label: "r14" },
    { r: 28, w: 3, label: "r28" },
  ];
  sweep.forEach((s, i) => {
    boxes.push(
      encodeTextContainer({
        x: 96 + i * 116, y: 40, width: 104, height: 72,
        containerId: 20 + i,
        containerName: `sty-${s.label}`,
        content: s.label,
        borderWidth: s.w,
        borderRadius: s.r,
        paddingLength: 8,
        isEventCapture: false,      // the list must keep the events
      })
    );
  });

  // A padding sweep on a fixed radius, to separate "radius does nothing" from "padding does".
  [0, 12].forEach((p, i) => {
    boxes.push(
      encodeTextContainer({
        x: 96 + i * 232, y: 132, width: 220, height: 60,
        containerId: 30 + i,
        containerName: `pad-${p}`,
        content: `padding ${p}`,
        borderWidth: 2,
        borderRadius: 14,
        paddingLength: p,
        isEventCapture: false,
      })
    );
  });

  // A title, unbordered, as the control: proves text renders identically without borders.
  boxes.push(
    encodeTextContainer({
      x: 96, y: 208, width: 460, height: 40,
      containerId: 40,
      containerName: "sty-title",
      content: "border + radius probe",
      isEventCapture: false,
    })
  );

  const page = encodePageContainer({ lists: [list], texts: boxes });
  return opts.rebuild
    ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, opts.magic)
    : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, opts.magic);
}

/**
 * THE TILE PROBE — can we draw more than ONE rounded tile at a time?
 *
 * The style probe established two things: a LIST's selected item is drawn as a rounded tile by
 * the firmware, and TEXT containers ignore borderWidth/borderRadius entirely. So the only native
 * rounded rect available is a list's selection highlight — and a page has only one list, whose
 * highlight is on one item. That would cap a launcher at a single tile.
 *
 * Unless a page may carry SEVERAL lists. This probe puts four single-item lists in a column, all
 * NON-capturing, beside one capturing list. If the decorative lists still draw their highlight,
 * each becomes a permanent rounded tile and an icon column is possible with no bitmaps at all.
 * If they do not, the fallback is a pushed 4-bit BMP, which the user explicitly did not want.
 *
 * The one-capturing-container rule is respected: exactly one list captures.
 */
export function encodeTileProbePage(opts: { rebuild: boolean; magic: number }): Uint8Array {
  const lists: Uint8Array[] = [];

  // Four DECORATIVE single-item lists down the left. Each should draw a tile around its only item.
  const glyphs = ["C", "S", "D", "A"];
  glyphs.forEach((g, i) => {
    lists.push(
      encodeListContainer({
        x: 16, y: 16 + i * 64, width: 52, height: 52,
        containerId: 50 + i,
        containerName: `tile-${i}`,
        items: [g],
        itemWidth: 52,
        selectBorder: true,
        isEventCapture: false,     // decorative only — the capturing list is below
      })
    );
  });

  // The ONE capturing list, to the right, carrying the real navigation.
  lists.push(
    encodeListContainer({
      x: 96, y: 16, width: 300, height: 256,
      containerId: CONTAINER_IDS.list,
      containerName: "ffs-list",
      items: ["Clock", "Settings", "Device", "Apps"],
      selectBorder: true,
      isEventCapture: true,
    })
  );

  const texts = [
    encodeTextContainer({
      x: 410, y: 16, width: 150, height: 40,
      containerId: 60, containerName: "tp-title",
      content: "TILES", isEventCapture: false,
    }),
  ];

  const page = encodePageContainer({ lists, texts });
  return opts.rebuild
    ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, opts.magic)
    : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, opts.magic);
}

/**
 * PROBE 3 — two questions the launcher design hangs on, in one page.
 *
 * Q1: does a page accept TWO list containers? A five-list page was REJECTED outright: nothing
 *     rendered, and the page slot was left EMPTY so every later REBUILD also drew nothing (the
 *     HUD only came back after a fresh CREATE on a new link). That is a nasty failure mode —
 *     an over-ambitious page does not just fail, it takes the display with it — so the limit
 *     needs finding rather than guessing. If two render, the cap is somewhere in between.
 *
 * Q2: does a LIST container's OWN borderWidth/borderRadius draw a frame? Text containers ignore
 *     both (proven: r0/r6/r14/r28 rendered identically). But the list is the one container the
 *     firmware demonstrably CAN draw a rounded rect for — it does exactly that for the selected
 *     item. If the container border draws too, panel chrome is free and native. If not, the UI
 *     must be built from type and negative space alone.
 */
export function encodeProbe3Page(opts: { rebuild: boolean; magic: number }): Uint8Array {
  const lists: Uint8Array[] = [];

  // The capturing icon column, WITH a container border+radius set (Q2).
  lists.push(
    encodeListContainer({
      x: 12, y: 40, width: 56, height: 200,
      containerId: CONTAINER_IDS.list,
      containerName: "ffs-list",
      items: ["C", "S", "D", "A"],
      itemWidth: 56,
      selectBorder: true,
      isEventCapture: true,
      borderWidth: 2,
      borderRadius: 12,
    })
  );

  // A SECOND, decorative list (Q1). If the page renders at all, two lists are accepted.
  lists.push(
    encodeListContainer({
      x: 96, y: 40, width: 56, height: 56,
      containerId: 51,
      containerName: "tile-2",
      items: ["2"],
      itemWidth: 56,
      selectBorder: true,
      isEventCapture: false,
    })
  );

  const texts = [
    encodeTextContainer({
      x: 170, y: 40, width: 380, height: 40,
      containerId: 61, containerName: "p3-a",
      content: "2 lists + list border", isEventCapture: false,
    }),
    encodeTextContainer({
      x: 170, y: 96, width: 380, height: 40,
      containerId: 62, containerName: "p3-b",
      content: "if you see this, 2 lists OK", isEventCapture: false,
    }),
  ];

  const page = encodePageContainer({ lists, texts });
  return opts.rebuild
    ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, opts.magic)
    : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, opts.magic);
}


/**
 * ImageObject: f1..f4 geometry, f5 containerID, f6 containerName.
 *
 * Note the field numbering is NOT the same as list/text containers — image containers have no
 * border/padding/capture fields at all. They also cannot capture events, which is convenient:
 * an image page never competes with a list for the one event binding.
 */
export function encodeImageContainer(s: {
  x?: number; y?: number; width: number; height: number;
  containerId?: number; containerName?: string;
}): Uint8Array {
  const w = new ProtoWriter();
  w.int32(1, s.x ?? 0);
  w.int32(2, s.y ?? 0);
  w.int32(3, s.width);
  w.int32(4, s.height);
  w.int32(5, s.containerId ?? CONTAINER_IDS.raster);
  if (s.containerName != null) w.string(6, s.containerName);
  return w.data;
}

/**
 * ImageRawDataUpdate (Cmd 3, sub-field 5):
 *   f1 containerID, f2 name, f3 sessionId, f4 totalSize,
 *   f5 compressMode, f6 fragmentIndex, f7 fragmentPacketSize, f8 rawData
 *
 * The firmware reassembles fragments by index and, once totalSize bytes have arrived, hands the
 * whole buffer to the image decoder — which is where our mode byte is read. So the MODE lives in
 * the reassembled payload, not in this envelope; `compressMode` stays 0.
 */
export function encodeImageRawData(s: {
  containerId: number;
  containerName?: string;
  sessionId: number;
  totalSize: number;
  fragmentIndex: number;
  data: Uint8Array;
  magic: number;
}): Uint8Array {
  const u = new ProtoWriter();
  u.int32(1, s.containerId);
  if (s.containerName != null) u.string(2, s.containerName);
  u.int32(3, s.sessionId);
  u.int32(4, s.totalSize);
  u.int32(5, 0);
  u.int32(6, s.fragmentIndex);
  u.int32(7, s.data.length);
  u.bytes(8, s.data);
  return encodeEnvelope(Cmd.UPDATE_IMAGE_RAW_DATA, 5, u.data, s.magic);
}

/**
 * The full-canvas gesture-capture container the firmware expects on any page that has no
 * capturing LIST.
 *
 * Every native page carries this, and an image page built WITHOUT it did not render at all —
 * not even through the already-proven BMP decode path. A page missing it appears to be rejected
 * silently, which is indistinguishable from a dark HUD.
 *
 * ⚠️ Never add this to a page that already has a capturing list: the firmware binds events to
 * exactly ONE container, so evt-0 would starve the list of the swipes it needs and leave it
 * rendered but frozen.
 */
export function encodeEventCaptureContainer(): Uint8Array {
  return encodeTextContainer({
    x: 0, y: 0, width: CANVAS.width, height: CANVAS.height,
    containerId: CONTAINER_IDS.event, containerName: "evt-0",
    content: "", isEventCapture: true,
  });
}

/** A page whose only content is one image container — the surface a raster frame is drawn into. */
export function encodeImagePage(o: {
  x?: number; y?: number; width: number; height: number;
  containerId?: number; containerName?: string;
  rebuild: boolean; magic: number;
}): Uint8Array {
  const ic = encodeImageContainer(o);
  // evt-0 FIRST, exactly as the native page builder does — an image container cannot capture,
  // so without it the page has no event binding at all and does not render.
  const page = encodePageContainer({ texts: [encodeEventCaptureContainer()], images: [ic] });
  return o.rebuild
    ? encodeEnvelope(Cmd.REBUILD_PAGE, 7, page, o.magic)
    : encodeEnvelope(Cmd.CREATE_STARTUP_PAGE, 3, page, o.magic);
}
