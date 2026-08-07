// Minimal protobuf wire codec — the foundation of the pure-TypeScript encoder.
//
// WHY HAND-ROLLED. The generated schema in `reference/g2-kit-unofficial` is a MAP, not a
// dependency: this project's cardinal rule is that nothing ships unproven on our hardware, and
// pulling in a third-party 0.1.0 kit would import its assumptions (several of which its own prose
// docs get wrong) into a public repo. We encode ourselves and pin the bytes against frames
// captured off the glasses.
//
// Everything here is PURE — no I/O, no clock, no randomness. That is what lets `encodePage` be
// byte-pinned in a unit test on Windows with no glasses in the room.

/** Protobuf wire types we actually use. */
const WIRE_VARINT = 0;
const WIRE_LEN = 2;

export class ProtoWriter {
  private buf: number[] = [];

  get data(): Uint8Array {
    return Uint8Array.from(this.buf);
  }

  get length(): number {
    return this.buf.length;
  }

  private varint(v: number): void {
    // Values are non-negative on this protocol; a negative would encode as a 10-byte
    // two's-complement varint and almost certainly indicates a caller bug, so reject it.
    if (!Number.isInteger(v) || v < 0) {
      throw new RangeError(`varint expects a non-negative integer, got ${v}`);
    }
    let n = v;
    while (n > 0x7f) {
      this.buf.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.buf.push(n);
  }

  private tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  /** int32 field. Zero IS written — see the note in `encodePage` about proto3 defaults. */
  int32(field: number, value: number): this {
    this.tag(field, WIRE_VARINT);
    this.varint(value);
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, WIRE_LEN);
    this.varint(value.length);
    for (const b of value) this.buf.push(b);
    return this;
  }

  /** UTF-8 string. The G2 echoes container names back verbatim on events. */
  string(field: number, value: string): this {
    return this.bytes(field, utf8(value));
  }

  message(field: number, value: Uint8Array): this {
    return this.bytes(field, value);
  }
}

/** Decoded protobuf fields: varints as numbers, length-delimited as raw bytes. */
export type ProtoFields = Map<number, number | Uint8Array>;

/**
 * Parse one protobuf message, last-wins per field.
 *
 * Returns null on anything malformed rather than throwing: this parses bytes that arrived over a
 * radio, and a truncated or corrupt frame is an expected condition, not an exception.
 */
export function parseFields(data: Uint8Array): ProtoFields | null {
  const out: ProtoFields = new Map();
  let i = 0;
  while (i < data.length) {
    const key = readVarint(data, i);
    if (!key) return null;
    i = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0) return null;

    if (wire === WIRE_VARINT) {
      const v = readVarint(data, i);
      if (!v) return null;
      out.set(field, v.value);
      i = v.next;
    } else if (wire === WIRE_LEN) {
      const len = readVarint(data, i);
      if (!len) return null;
      const start = len.next;
      const end = start + len.value;
      if (end > data.length) return null;
      out.set(field, data.subarray(start, end));
      i = end;
    } else if (wire === 5) {
      if (i + 4 > data.length) return null;
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > data.length) return null;
      i += 8;
    } else {
      return null; // groups / unknown wire type
    }
  }
  return out;
}

function readVarint(data: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 1;
  let i = at;
  while (i < data.length) {
    const b = data[i++];
    value += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift *= 128;
    if (shift > 2 ** 56) return null;
  }
  return null;
}

export function u32(f: ProtoFields | null, field: number): number | undefined {
  const v = f?.get(field);
  return typeof v === "number" ? v : undefined;
}

export function sub(f: ProtoFields | null, field: number): Uint8Array | undefined {
  const v = f?.get(field);
  return v instanceof Uint8Array ? v : undefined;
}

export function str(f: ProtoFields | null, field: number): string | undefined {
  const v = f?.get(field);
  return v instanceof Uint8Array ? utf8Decode(v) : undefined;
}

export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) {
      s += String.fromCodePoint(c);
      i += 1;
    } else if (c < 0xe0) {
      s += String.fromCodePoint(((c & 0x1f) << 6) | (b[i + 1] & 0x3f));
      i += 2;
    } else if (c < 0xf0) {
      s += String.fromCodePoint(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f));
      i += 3;
    } else {
      s += String.fromCodePoint(
        ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f)
      );
      i += 4;
    }
  }
  return s;
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
