// Byte-level checks on the image path.
//
// These exist because the image path FAILS SILENTLY on hardware: fragments are acknowledged and
// nothing renders, which is indistinguishable from a page that was never accepted. The only way
// to make progress offline is to pin every field against the native encoder that is proven to
// render, so a future hardware cycle tests ONE hypothesis instead of the whole stack.
//
// Field layouts transcribed from G2Protocol.kt:
//   imageContainer:      f1 x, f2 y, f3 w, f4 h, f5 containerID, f6 name
//   createStartupPage:   f1 totalCount, f2 lists, f3 texts, f4 images
//   imageRawDataUpdate:  f1 id, f2 name, f3 session, f4 totalSize, f5 compressMode,
//                        f6 fragmentIndex, f7 fragmentPacketSize, f8 rawData
//   envelope:            f1 cmd, f2 magic, f<sub> payload  (image data => cmd 3, sub 5)

import {
  Cmd,
  encodeEventCaptureContainer,
  encodeImageContainer,
  encodeImagePage,
  encodeImageRawData,
} from "../wire";
import { parseFields, str, sub, u32 } from "../proto";

describe("image container", () => {
  it("uses the native field numbering", () => {
    const f = parseFields(
      encodeImageContainer({ x: 188, y: 94, width: 200, height: 100, containerId: 2, containerName: "ffs-rast" })
    )!;
    expect(u32(f, 1)).toBe(188);
    expect(u32(f, 2)).toBe(94);
    expect(u32(f, 3)).toBe(200);
    expect(u32(f, 4)).toBe(100);
    expect(u32(f, 5)).toBe(2);
    expect(str(f, 6)).toBe("ffs-rast");
  });
});

describe("image page", () => {
  const page = () =>
    parseFields(
      sub(
        parseFields(encodeImagePage({
          x: 188, y: 94, width: 200, height: 100,
          containerId: 2, containerName: "ffs-rast",
          rebuild: false, magic: 7,
        }))!,
        3 // CREATE puts the page in sub-field 3
      )!
    )!;

  it("counts EVERY container, image included", () => {
    // evt-0 (text) + the image container.
    expect(u32(page(), 1)).toBe(2);
  });

  it("puts the image in field 4 and evt-0 in field 3", () => {
    const p = page();
    expect(sub(p, 4)).toBeDefined();          // image container
    expect(sub(p, 3)).toBeDefined();          // evt-0 text container
    expect(sub(p, 2)).toBeUndefined();        // no list on an image page
  });

  /**
   * evt-0 must be FULL CANVAS. A 1x1 hit target at the origin misses most gestures — the arm
   * touchpad maps to a screen region, which is the documented "30% detection" bug.
   */
  it("evt-0 is full-canvas, capturing, empty and at containerId 0", () => {
    const e = parseFields(encodeEventCaptureContainer())!;
    expect(u32(e, 3)).toBe(576);
    expect(u32(e, 4)).toBe(288);
    expect(u32(e, 9)).toBe(0);                // containerId
    expect(str(e, 10)).toBe("evt-0");
    expect(u32(e, 11)).toBe(1);               // isEventCapture
    expect(str(e, 12)).toBe("");
  });
});

describe("image raw data", () => {
  const msg = encodeImageRawData({
    containerId: 2, containerName: "ffs-rast",
    sessionId: 129, totalSize: 10118, fragmentIndex: 1,
    data: Uint8Array.from([9, 8, 7]), magic: 42,
  });

  it("is cmd 3 in sub-field 5", () => {
    const f = parseFields(msg)!;
    expect(u32(f, 1)).toBe(Cmd.UPDATE_IMAGE_RAW_DATA);
    expect(u32(f, 1)).toBe(3);
    expect(u32(f, 2)).toBe(42);
    expect(sub(f, 5)).toBeDefined();
  });

  it("carries every field the native encoder sends, in the same slots", () => {
    const u = parseFields(sub(parseFields(msg)!, 5)!)!;
    expect(u32(u, 1)).toBe(2);          // containerID
    expect(str(u, 2)).toBe("ffs-rast");
    expect(u32(u, 3)).toBe(129);        // session
    expect(u32(u, 4)).toBe(10118);      // total size
    expect(u32(u, 5)).toBe(0);          // compressMode — the MODE lives in the payload, not here
    expect(u32(u, 6)).toBe(1);          // fragment index
    expect(u32(u, 7)).toBe(3);          // this fragment's byte count
    expect(Array.from(sub(u, 8)!)).toEqual([9, 8, 7]);
  });

  /** fragmentPacketSize must describe THIS fragment, not the whole image. */
  it("fragmentPacketSize tracks the chunk, not the total", () => {
    const big = encodeImageRawData({
      containerId: 1, sessionId: 1, totalSize: 9999, fragmentIndex: 0,
      data: new Uint8Array(4096), magic: 1,
    });
    const u = parseFields(sub(parseFields(big)!, 5)!)!;
    expect(u32(u, 7)).toBe(4096);
    expect(u32(u, 4)).toBe(9999);
  });
});
