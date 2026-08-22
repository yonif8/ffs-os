// Carrier-A + Carrier-B telemetry decoder tests (g2flash/docs/ONGLASS-TELEMETRY.md).
//
// This decoder sits on a diagnostic channel we use to debug the OS without a camera, so a bit
// slip here would silently mis-report memory/page/error state and send a debugging session the
// wrong way. Check the exact bit/byte layouts the payload + loader emit.

import {
  decodeTelemetryA,
  decodeTelemetryB,
  decodeTelemetryField104,
  decodeTelemetryFromVersionString,
  telemetryFromDeviceFrame,
  groupByLens,
  TELEMETRY_TAG_A,
  activePageLabel,
} from "../telemetry";

/** Pack a Carrier-A return value exactly as payloads/ffs_telemetry.c does. */
function packA(pool: number, aid6: number, vm: number, vmPresent: number, lens: number): number {
  return (
    ((0x7d << 24) |
      (pool & 0x3ff) |
      ((aid6 & 0x3f) << 10) |
      ((vm & 0x7) << 16) |
      ((vmPresent & 0x1) << 19) |
      ((lens & 0x3) << 22)) >>>
    0
  );
}

describe("telemetry Carrier A (tag 0x7D)", () => {
  it("decodes the frozen golden vector 0x7D48D434 (vm_present set)", () => {
    // pool=52 KB, active id 0x0FF5 (overlay) -> low6 0x35, vm_status OK(0), vm_present=1, lens right(1).
    const ret = packA(52, 0x35, 0, 1, 1);
    expect(ret >>> 0).toBe(0x7d48d434);
    const t = decodeTelemetryA(ret);
    expect(t.valid).toBe(true);
    expect(t.source).toBe("A");
    expect(t.pool_free_kb).toBe(52);
    expect(t.active_id).toBe(0x35);
    expect(t.vm_status).toBe(0);
    expect(t.vm_present).toBe(true);
    expect(t.lens).toBe(1);
    expect(t.labels.active).toBe("overlay(0x0FF5)");
    expect(t.labels.lens).toBe("right");
    expect(t.labels.vmStatus).toBe("OK");
  });

  it("distinguishes vm_status=7 with vm_present=0 (no VM) from a real DATUM", () => {
    const noVm = decodeTelemetryA(packA(40, 3, 7, 0, 1));
    expect(noVm.vm_present).toBe(false); // 7 here means 'no resident VM', not DATUM
    const datum = decodeTelemetryA(packA(40, 3, 7, 1, 1));
    expect(datum.vm_present).toBe(true);
    expect(datum.labels.vmStatus).toBe("DATUM");
  });

  it("round-trips every field across its range", () => {
    for (const pool of [0, 1, 40, 57, 1023]) {
      for (const aid of [0x35, 0x36, 3, 0x3f]) {
        for (const vm of [0, 6, 7]) {
          for (const vmp of [0, 1]) {
            for (const lens of [0, 1, 2]) {
              const t = decodeTelemetryA(packA(pool, aid, vm, vmp, lens));
              expect(t.pool_free_kb).toBe(pool);
              expect(t.active_id).toBe(aid);
              expect(t.vm_status).toBe(vm);
              expect(t.vm_present).toBe(vmp === 1);
              expect(t.lens).toBe(lens);
            }
          }
        }
      }
    }
  });

  it("flags a non-0x7D return (e.g. an FFSP 0x7E mask) as invalid", () => {
    const t = decodeTelemetryA(0x7e8ffe7f >>> 0);
    expect(t.valid).toBe(false);
    expect((0x7e8ffe7f >>> 24) & 0xff).not.toBe(TELEMETRY_TAG_A);
  });

  it("labels the known page ids", () => {
    expect(activePageLabel(0x0ff5 & 0x3f)).toBe("overlay(0x0FF5)");
    expect(activePageLabel(0x0ff6 & 0x3f)).toBe("base(0x0FF6)");
    expect(activePageLabel(3)).toBe("even-menu(3)");
    expect(activePageLabel(0x3f)).toBe("none/unknown");
    expect(activePageLabel(0x0ff5)).toBe("overlay(0x0FF5)"); // full 16-bit id (Carrier B)
  });
});

/** Little-endian u32 writer for building test records. */
function put(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

describe("telemetry from field 104 (LD04 Carrier A)", () => {
  function ld04(lastRet: number, rejCode: number): Uint8Array {
    const b = new Uint8Array(68);
    b.set([0x4c, 0x44, 0x30, 0x34], 0); // "LD04"
    put(b, 12, lastRet >>> 0);
    put(b, 56, rejCode >>> 0);
    return b;
  }

  it("pulls last_ret from +12 and rej_code from +56", () => {
    const t = decodeTelemetryField104(ld04(packA(52, 0x35, 0, 1, 1), 5))!;
    expect(t).not.toBeNull();
    expect(t.source).toBe("A");
    expect(t.pool_free_kb).toBe(52);
    expect(t.rej_code).toBe(5);
    expect(t.labels.rejCode).toBe("CRC(payload CORRUPT)");
  });

  it("returns null for a non-loader body", () => {
    const junk = new Uint8Array(68);
    junk.set([0x52, 0x58, 0x30, 0x31], 0); // "RX01" (the RAM-exec probe, not us)
    expect(decodeTelemetryField104(junk)).toBeNull();
  });
});

describe("telemetry from field 104 (LD05 Carrier B, always-on)", () => {
  function ld05(o: {
    freeBytes: number;
    node: number;
    id: number;
    gates: number;
    lens: number;
    vmStatus: number;
    vmGen: number;
    rejCode?: number;
  }): Uint8Array {
    const b = new Uint8Array(88);
    b.set([0x4c, 0x44, 0x30, 0x35], 0); // "LD05"
    put(b, 56, o.rejCode ?? 0);
    put(b, 68, o.freeBytes);
    put(b, 72, o.node);
    b[76] = o.id & 0xff;
    b[77] = (o.id >>> 8) & 0xff;
    b[78] = o.gates;
    b[79] = o.lens;
    put(b, 80, o.vmStatus);
    put(b, 84, o.vmGen);
    return b;
  }

  it("decodes the appended block with no push (source B)", () => {
    const t = decodeTelemetryField104(
      ld05({
        freeBytes: 46 * 1024,
        node: 0x20074abc,
        id: 0x0ff6,
        gates: 0b0001_1111, // sane|root|overlay|base|vm_present
        lens: 2,
        vmStatus: 0,
        vmGen: 7,
      }),
    )!;
    expect(t).not.toBeNull();
    expect(t.source).toBe("B");
    expect(t.pool_free_kb).toBe(46);
    expect(t.active_id).toBe(0x0ff6);
    expect(t.labels.active).toBe("base(0x0FF6)");
    expect(t.active_node).toBe(0x20074abc);
    expect(t.lens).toBe(2);
    expect(t.labels.lens).toBe("left");
    expect(t.vm_present).toBe(true);
    expect(t.vm_gen).toBe(7);
  });

  it("reports vm_present=false when the gate bit is clear or status is 0xFFFFFFFF", () => {
    const noVmByStatus = decodeTelemetryB(
      ld05({ freeBytes: 1024, node: 0, id: 3, gates: 0b0000_1111, lens: 1, vmStatus: 0xffffffff, vmGen: 0 }),
    );
    expect(noVmByStatus.vm_present).toBe(false);
    const noVmByGate = decodeTelemetryB(
      ld05({ freeBytes: 1024, node: 0, id: 3, gates: 0b0000_1111, lens: 1, vmStatus: 6, vmGen: 0 }),
    );
    expect(noVmByGate.vm_present).toBe(false);
  });
});

describe("version-string extraction (no native change needed)", () => {
  it("pulls a 0x7D ret and the rej code out of the ⟨LOADER⟩ string", () => {
    const ret = packA(57, 0x36, 0, 1, 2) >>> 0;
    const ver =
      "EVENCFW/1  ⟨LOADER gen=3 ran=3 ret=0x" +
      ret.toString(16).toUpperCase() +
      " len=186 rej=1/OOM⟩";
    const t = decodeTelemetryFromVersionString(ver)!;
    expect(t).not.toBeNull();
    expect(t.pool_free_kb).toBe(57);
    expect(t.active_id).toBe(0x36);
    expect(t.lens).toBe(2);
    expect(t.rej_code).toBe(6); // OOM
  });

  it("returns null when the ret is not telemetry (e.g. an FFSP mask)", () => {
    expect(decodeTelemetryFromVersionString("… ret=0x7E8FFE7F …")).toBeNull();
    expect(decodeTelemetryFromVersionString("no ret here")).toBeNull();
    expect(decodeTelemetryFromVersionString(null)).toBeNull();
  });
});

describe("telemetryFromDeviceFrame (raw service-0x09 frame)", () => {
  /** Wrap an LD0x record as protobuf field 104 (tag 0xC2 0x06, per settings_ext.c). */
  function frameWithField104(ld: Uint8Array): Uint8Array {
    // length fits one byte for LD04/LD05 (<=88), matching the firmware's single-byte length.
    return Uint8Array.from([0xc2, 0x06, ld.length, ...ld]);
  }
  function ld04(lastRet: number): Uint8Array {
    const b = new Uint8Array(68);
    b.set([0x4c, 0x44, 0x30, 0x34], 0);
    put(b, 12, lastRet >>> 0);
    return b;
  }

  it("pulls field 104 out of a device frame and decodes Carrier A", () => {
    const frame = frameWithField104(ld04(packA(52, 0x35, 0, 1, 1)));
    const t = telemetryFromDeviceFrame(frame)!;
    expect(t).not.toBeNull();
    expect(t.source).toBe("A");
    expect(t.pool_free_kb).toBe(52);
    expect(t.lens).toBe(1);
  });

  it("returns null for a frame with no field 104", () => {
    // field 12 (battery) varint, no field 104
    expect(telemetryFromDeviceFrame(Uint8Array.from([0x60, 0x5a]))).toBeNull();
  });
});

describe("groupByLens", () => {
  it("separates readings by their self-reported lens stamp", () => {
    const mk = (lens: number) => decodeTelemetryA(packA(40, 3, 0, 1, lens));
    const g = groupByLens([mk(1), mk(2), mk(1), mk(0)]);
    expect(g.right).toHaveLength(2);
    expect(g.left).toHaveLength(1);
    expect(g.unknown).toHaveLength(1);
  });
});
