// FFSM — the message store the glasses' `messages` app reads.
//
// WHAT THIS IS. `g2flash/apps/messages.c` renders a conversation entirely on the glasses:
// it owns its own 5x7 face, wraps and pages the text itself, and walks ONE byte-packed blob
// in place. This module builds that blob. The phone is the brain (contacts, notification
// access, network); the glasses are the face (layout, scrolling, input) — GOAL.md §2.
//
// ★ THE LAYOUT IS DEFINED IN TWO PLACES AND MUST NOT DRIFT:
//     g2flash/apps/messages/gen_fixture.py   the reference encoder (and the app's fixture)
//     this file                              the phone's encoder
//   `g2flash/apps/messages/test_store.c` proves the C parser reads the Python encoder's
//   bytes; `__tests__/ffsm.test.ts` proves this encoder produces the same shape and
//   round-trips. If you change the layout, change all three in one commit.
//
// [M] NOTHING HERE IS PROVEN ON GLASS. It emits bytes and is unit-tested; the transport that
//     would carry them (an FFSM route in the CFW loader) does not exist yet — see
//     `g2flash/docs/S-MSG-report.md` §4. This module deliberately does no I/O, so it cannot
//     half-deliver anything.
//
// ⛔ PRIVACY: these bytes are message bodies. Never log an encoded blob or a decoded thread,
//    and never write one to a file this repo could commit — ffs_os is PUBLIC.

export const FFSM_MAGIC = "FFSM";
export const FFSM_VER = 1;

/** Caps the app's own parser and record fields enforce. Exceeding one is a bug, not a warning. */
export const FFSM_MAX_THREADS = 8;
export const FFSM_MAX_MSGS = 12;
export const FFSM_MAX_NAME = 15;
export const FFSM_MAX_BODY = 200;

/**
 * Total blob budget. The glasses' P_GLOBAL heap had ~37 KB free with the 160x64 shell canvas
 * up (S2-app-abi.md §7.10), and this buffer is resident, so it is kept small deliberately:
 * a whole inbox worth reading at a glance is well under 1 KB.
 */
export const FFSM_MAX_BYTES = 1024;

export interface FfsmMessage {
  /** true = the wearer sent it (drawn right-aligned, bar on the right edge). */
  fromMe: boolean;
  /** Age in minutes AT THE MOMENT OF THE PUSH. The glasses never advance it. */
  ageMin: number;
  body: string;
}

export interface FfsmThread {
  name: string;
  unread: boolean;
  /** OLDEST first — reading order, which is the order the app rolls through. */
  messages: FfsmMessage[];
}

// ---------------------------------------------------------------- transliteration

/**
 * Punctuation that phones emit constantly and that a 7-bit face has no glyph for. Mapped
 * rather than dropped because these carry meaning a reader would miss.
 */
const PUNCT: Record<string, string> = {
  "‘": "'", "’": "'", "‚": ",", "‛": "'",
  "“": '"', "”": '"', "„": '"',
  "–": "-", "—": "-", "−": "-", "‑": "-",
  "…": "...", " ": " ", " ": " ", " ": " ",
  "«": '"', "»": '"', "‹": "'", "›": "'",
  "·": "-", "•": "-", "×": "x", "÷": "/",
  "€": "EUR", "£": "GBP", "¥": "JPY", "™": "(TM)",
  "©": "(c)", "®": "(R)", "½": "1/2", "¼": "1/4",
};

/**
 * Reduce arbitrary text to the 0x20..0x7E the app has glyphs for.
 *
 * The app draws a visible substitute BOX for anything it cannot render — never a blank, which
 * is the failure mode Even's own text path has (`common_text_create` resolves its face from
 * the font-chain head and a missing codepoint draws nothing and reports nothing). So a
 * non-ASCII byte reaching the glasses is *safe*, just ugly. Transliterating here is about
 * READABILITY, not safety, which is why it is allowed to be lossy:
 *
 *  - accented Latin is decomposed and the marks dropped:  "café" -> "cafe"
 *  - the punctuation table above is substituted
 *  - any remaining run of unrepresentable characters (emoji, CJK, ZWJ sequences) collapses to
 *    a single "*", so "on my way 🚗💨" reads "on my way *" — the reader can see something was
 *    there without a screenful of boxes
 *  - control characters and newlines become single spaces; runs of space collapse
 */
export function toAscii(input: string): string {
  let mapped = "";
  for (const ch of input) mapped += PUNCT[ch] ?? ch;

  // NFKD splits "é" into "e" + a combining mark, which the class below then removes.
  const decomposed = mapped.normalize("NFKD").replace(/\p{M}+/gu, "");

  let out = "";
  let dropping = false;
  for (const ch of decomposed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      dropping = false;
    } else if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
      dropping = false;
    } else if (!dropping) {
      out += "*";
      dropping = true; // one marker per RUN, not per codepoint
    }
  }
  return out.replace(/ {2,}/g, " ").trim();
}

// ---------------------------------------------------------------- encoding

function ascii(s: string, max: number): Uint8Array {
  const clean = toAscii(s);
  const bytes = new Uint8Array(Math.min(clean.length, max));
  for (let i = 0; i < bytes.length; i++) bytes[i] = clean.charCodeAt(i) & 0x7f;
  return bytes;
}

function threadBytes(t: FfsmThread): number {
  const name = Math.min(toAscii(t.name).length, FFSM_MAX_NAME);
  let n = 4 + name;
  for (const m of t.messages) n += 4 + Math.min(toAscii(m.body).length, FFSM_MAX_BODY);
  return n;
}

function totalBytes(threads: FfsmThread[]): number {
  return 8 + threads.reduce((n, t) => n + threadBytes(t), 0);
}

/**
 * Trim an inbox until it fits `maxBytes`, giving up the least useful thing first:
 * the OLDEST message of whichever thread currently has the most, and only when every
 * thread is down to one message does it drop the last (least recent) thread.
 *
 * Returns a new array; the input is not mutated.
 */
export function fitFfsm(threads: FfsmThread[], maxBytes = FFSM_MAX_BYTES): FfsmThread[] {
  let out = threads
    .slice(0, FFSM_MAX_THREADS)
    .map((t) => ({ ...t, messages: t.messages.slice(-FFSM_MAX_MSGS) }))
    .filter((t) => t.messages.length > 0);

  while (out.length > 0 && totalBytes(out) > maxBytes) {
    let fattest = -1;
    let most = 1;
    for (let i = 0; i < out.length; i++) {
      if (out[i].messages.length > most) {
        most = out[i].messages.length;
        fattest = i;
      }
    }
    if (fattest >= 0) out[fattest] = { ...out[fattest], messages: out[fattest].messages.slice(1) };
    else out = out.slice(0, -1); // every thread is down to one message
  }
  return out;
}

/**
 * Build the blob. Threads must arrive NEWEST-ACTIVITY FIRST (the order the inbox lists them);
 * messages within a thread OLDEST first (reading order).
 *
 * Throws rather than truncating on a structural violation, because a malformed blob is
 * REFUSED by the app's validator on-glass and shows up as "the app won't launch" — a thrown
 * error on the phone is the same bug, found where it can be read.
 */
export function encodeFfsm(threads: FfsmThread[], maxBytes = FFSM_MAX_BYTES): Uint8Array {
  const list = fitFfsm(threads, maxBytes);
  if (list.length === 0) throw new Error("FFSM: an empty inbox is not a screen");
  if (list.length > FFSM_MAX_THREADS) throw new Error("FFSM: too many threads");

  const out: number[] = [0x46, 0x46, 0x53, 0x4d, FFSM_VER, list.length, 0, 0];
  for (const t of list) {
    const name = ascii(t.name, FFSM_MAX_NAME);
    if (name.length === 0) throw new Error("FFSM: a thread needs a name");
    if (t.messages.length === 0) throw new Error(`FFSM: thread "${t.name}" has no messages`);
    if (t.messages.length > FFSM_MAX_MSGS) throw new Error("FFSM: too many messages");
    out.push(name.length, t.messages.length, t.unread ? 1 : 0, 0, ...name);
    for (const m of t.messages) {
      const body = ascii(m.body, FFSM_MAX_BODY);
      const age = Math.max(0, Math.min(0xffff, Math.round(m.ageMin)));
      out.push(m.fromMe ? 1 : 0, body.length, age & 0xff, (age >> 8) & 0xff, ...body);
    }
  }
  const blob = Uint8Array.from(out);
  if (blob.length > maxBytes) throw new Error(`FFSM: ${blob.length} B over the ${maxBytes} B budget`);
  return blob;
}

/**
 * The inverse, for tests and for reading back what was pushed. Mirrors `ms_valid()` in
 * apps/messages.c: it refuses anything whose records do not all end inside the buffer, so a
 * round-trip test also exercises the same rejections the glasses apply.
 */
export function decodeFfsm(buf: Uint8Array): FfsmThread[] {
  const bad = (why: string): never => {
    throw new Error(`FFSM: ${why}`);
  };
  if (buf.length < 9) bad("shorter than a header");
  if (buf[0] !== 0x46 || buf[1] !== 0x46 || buf[2] !== 0x53 || buf[3] !== 0x4d) bad("bad magic");
  if (buf[4] !== FFSM_VER) bad(`unknown version ${buf[4]}`);
  if (buf[5] === 0) bad("zero threads");

  const dec = (a: Uint8Array) => String.fromCharCode(...a);
  const threads: FfsmThread[] = [];
  let o = 8;
  for (let i = 0; i < buf[5]; i++) {
    if (o + 4 > buf.length) bad("a thread header runs past the end");
    const nameLen = buf[o];
    const nMsgs = buf[o + 1];
    const unread = (buf[o + 2] & 1) === 1;
    if (nMsgs === 0) bad("a thread with no messages");
    if (o + 4 + nameLen > buf.length) bad("a thread name runs past the end");
    const name = dec(buf.subarray(o + 4, o + 4 + nameLen));
    o += 4 + nameLen;
    const messages: FfsmMessage[] = [];
    for (let j = 0; j < nMsgs; j++) {
      if (o + 4 > buf.length) bad("a message header runs past the end");
      const bodyLen = buf[o + 1];
      if (o + 4 + bodyLen > buf.length) bad("a message body runs past the end");
      messages.push({
        fromMe: buf[o] === 1,
        ageMin: buf[o + 2] | (buf[o + 3] << 8),
        body: dec(buf.subarray(o + 4, o + 4 + bodyLen)),
      });
      o += 4 + bodyLen;
    }
    threads.push({ name, unread, messages });
  }
  if (o !== buf.length) bad("trailing bytes after the last thread");
  return threads;
}
