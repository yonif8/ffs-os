import { base64ByteLength, corruptFxp1CrcBase64, loaderRecordFromVersions, verifyPushAck } from "../pushAck";
import { fromBase64, toBase64 } from "../../sdk/base64";

describe("native push acknowledgement", () => {
  const line = (o: Partial<{ gen: number; ran: number; len: number; rxlen: number; rej: number }> = {}) =>
    `2.2.7.14 ⟨LOADER gen=${o.gen ?? 8} ran=${o.ran ?? 8} ret=0x7E8000FF ` +
    `len=${o.len ?? 618} calls=9 rxlen=${o.rxlen ?? 630} first4=0x31505846 ` +
    `rej=${o.rej ?? 0}/NONE(accepted)⟩`;

  it("parses the complete numeric loader attribution block from either lens", () => {
    expect(loaderRecordFromVersions(null, line())).toEqual({
      gen: 8, ran: 8, ret: 0x7e8000ff, len: 618, rxlen: 630, rej: 0,
    });
  });

  it("accepts only a fresh exact frame", () => {
    const record = loaderRecordFromVersions(line())!;
    expect(verifyPushAck({ gen: 7, ran: 7 }, record, 630).state).toBe("accepted");
    expect(verifyPushAck({ gen: 8, ran: 8 }, record, 630).state).toBe("pending");
    expect(verifyPushAck(null, record, 630).state).toBe("pending");
  });

  it("fails rejected, foreign, and wrong-body records", () => {
    expect(verifyPushAck({ gen: 7, ran: 7 }, loaderRecordFromVersions(line({ rej: 6 }))!, 630).state).toBe("failed");
    expect(verifyPushAck({ gen: 7, ran: 7 }, loaderRecordFromVersions(line({ rxlen: 629 }))!, 630).state).toBe("failed");
    expect(verifyPushAck({ gen: 7, ran: 7 }, loaderRecordFromVersions(line({ len: 617 }))!, 630).state).toBe("failed");
  });

  it("does not blame a new push for sticky fields from an old rejected frame", () => {
    const oldReject = loaderRecordFromVersions(line({ gen: 7, ran: 6, rej: 6, rxlen: 99, len: 87 }))!;
    expect(verifyPushAck({ gen: 7, ran: 6 }, oldReject, 630).state).toBe("pending");
    const newReject = loaderRecordFromVersions(line({ gen: 8, ran: 6, rej: 6, rxlen: 630, len: 618 }))!;
    expect(verifyPushAck({ gen: 7, ran: 6 }, newReject, 630).state).toBe("failed");
  });

  it("handles u32 generation wrap without treating old telemetry as new", () => {
    const wrapped = loaderRecordFromVersions(line({ gen: 1, ran: 1 }))!;
    expect(verifyPushAck({ gen: 0xfffffffe, ran: 0xfffffffe }, wrapped, 630).state).toBe("accepted");
    expect(verifyPushAck({ gen: 5, ran: 5 }, wrapped, 630).state).toBe("pending");
  });

  it("computes canonical base64 lengths without runtime-specific decoders", () => {
    expect(base64ByteLength("RlhQMQ==")).toBe(4);
    expect(base64ByteLength("AQID")).toBe(3);
    expect(() => base64ByteLength("abc")).toThrow(/canonical base64/);
    expect(() => base64ByteLength("ab=c")).toThrow(/canonical base64/);
  });

  it("builds a same-length rejection probe by changing only the CRC header", () => {
    const frame = Uint8Array.from([
      0x46, 0x58, 0x50, 0x31, 1, 0, 0, 0, 0x12, 0x34, 0x56, 0x78, 0xaa,
    ]);
    const bad = fromBase64(corruptFxp1CrcBase64(toBase64(frame)));
    expect(bad.length).toBe(frame.length);
    expect(Array.from(bad.slice(0, 8))).toEqual(Array.from(frame.slice(0, 8)));
    expect(bad[8]).not.toBe(frame[8]);
    expect(Array.from(bad.slice(9))).toEqual(Array.from(frame.slice(9)));
  });
});
