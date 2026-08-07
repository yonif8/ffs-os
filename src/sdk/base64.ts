// base64 — pure, dependency-free, and deliberately in its own file.
//
// React Native has no Buffer and the SDK avoids a polyfill dependency, so this is hand-rolled.
// It lives apart from native.ts so it can be TESTED: importing the native adapter drags in
// react-native, which the test runner cannot parse, and that would leave the one codec sitting
// on every byte in and out of the glasses as the only untested thing in the SDK.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += b === undefined ? "=" : B64[(n >> 6) & 63];
    out += c === undefined ? "=" : B64[n & 63];
  }
  return out;
}

/** Ignores whitespace and padding, so a wrapped string from any encoder still decodes. */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((B64.indexOf(clean[i + 2]) & 63) << 6) |
      (B64.indexOf(clean[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (i + 2 < clean.length && o < out.length) out[o++] = (n >> 8) & 0xff;
    if (i + 3 < clean.length && o < out.length) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}
