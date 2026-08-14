// program.test.ts — the per-opcode byte goldens, written BEFORE the opcodes are trusted.
//
// ★ WHY THESE EXIST AND WHY THEY ARE HAND-DERIVED.
// Three implementations must agree on every byte of FFSP:
//     g2flash/payloads/ffs_prog.c   the interpreter + the input hook   (on-glass)
//     g2flash/tools/patch_prog.py   the assembler + patcher + framer   (the dev box)
//     src/sdk/program.ts            the lowering compiler              (the phone)
// A drift between any two of them is INVISIBLE. `code_crc` cannot catch it, because the same tool
// computes both sides of the CRC — it proves the encoder and the hole agree, not that the encoder
// and the interpreter agree. ONLY per-opcode byte goldens catch that, and they must be written
// before an opcode is trusted (design §7 item 8).
//
// So every hex string below was written out BY HAND from the table in `g2flash/patches/ffs_prog.h`
// §3 — op, len, vmask, then the scalars little-endian and byte-packed with NO alignment padding —
// and NOT by printing what program.ts produced. A golden copied from the implementation tests
// nothing at all.
//
// describe/it/expect are `bun test` globals, as everywhere else in src/sdk/__tests__; tsconfig.json
// excludes this directory from tsc for exactly that reason.

import {
  Op, OP, assemble, crc16, insBytes, required, varRef,
  screen, dashboard, park, readback, echoProgram, field,
  text, list, obj, watchface, bigClock, dateTemp, worldClock, listFace,
  listNext, listPrev, notify, set, add, move, inlineOp, listFocus, listCount, evtCount, evtCode, evtDev,
  programLength, dashboardGeometry, ECHO_LEN_DEFAULT,
  FFSP_MAGIC, FFSP_ABI, FFSP_SYMGEN, FFSP_FW_BUILD, FFSP_FLAG, FFSP_SLOT_PARENT,
  FFSP_PROG_SIZE, FFSP_HDR_SIZE, NOTIFY_VAR, FFSP_NOTIFY_VAR, STYLE_PROP, WHICH, NEED, DEV,
  EMIT_SRC, FFSP_DEF_PAD_TEXT, FFSP_DEF_PAD_LIST, FFSP_STYLE_PROP_MAX, FFSP_GEO_MIN, FFSP_GEO_MAX,
  STYLE_PTR_PROPS, GIF_MODE,
} from "../program";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ihex = (i: ReturnType<typeof Op.end>) => hex(insBytes(i));

// ══════════════════════════════════════════════════════════════════════════════════════
// CRC-16/CCITT-FALSE — the four vectors ffs_prog.h §9 names as the goldens
// ══════════════════════════════════════════════════════════════════════════════════════

describe("crc16 (CCITT-FALSE)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("reproduces all four vectors from ffs_prog.h §9", () => {
    expect(crc16(new Uint8Array(0))).toBe(0xffff);
    expect(crc16(enc("A"))).toBe(0xb915);
    expect(crc16(enc("123456789"))).toBe(0x29b1);
    // Sixteen 0x00 bytes: the one vector that catches an implementation which short-circuits on a
    // zero input byte instead of shifting through it.
    expect(crc16(new Uint8Array(16))).toBe(0x6a0a);
  });

  it("is not the zlib CRC-32 used for the FXP1 frame", () => {
    // Separate concerns, separate polynomials: the frame CRC proves TRANSPORT and is computed
    // after patching; this one proves the ENCODER AND THE HOLE AGREE.
    expect(crc16(enc("123456789"))).not.toBe(0xcbf43926 & 0xffff);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// PER-OPCODE GOLDENS — `op len vmask args…`, hand-derived from §3's table
// ══════════════════════════════════════════════════════════════════════════════════════

describe("opcode encoders", () => {
  it("0x00 END", () => {
    expect(ihex(Op.end())).toBe("000000");
  });

  it("0x01 IFOP op_id:u8, skip:u16", () => {
    expect(ihex(Op.ifOp(OP.LISTEV, 5))).toBe("010300" + "33" + "0500");
  });

  it("0x02 IFVAR var:u8, cmp:u8, imm:i16, skip:u16", () => {
    expect(ihex(Op.ifVar(2, 0, 7, 9))).toBe("020600" + "02" + "00" + "0700" + "0900");
  });

  it("0x03 SET var:u8, imm:i16 — negative immediates are two's complement LE", () => {
    expect(ihex(Op.set(3, -2))).toBe("030300" + "03" + "feff");
  });

  it("0x04 ADD var:u8, delta:i16, lo:i16, hi:i16, mode:u8", () => {
    expect(ihex(Op.add(1, 1, 0, 4, 1))).toBe("040800" + "01" + "0100" + "0000" + "0400" + "01");
  });

  it("0x05 EMIT src:u8, arg:u8, shift:u8, width:u8", () => {
    expect(ihex(Op.emit(1, 1, 0, 4))).toBe("050400" + "01" + "01" + "00" + "04");
  });

  it("0x06 NEED datum:u8", () => {
    expect(ihex(Op.need(NEED.PAGEMGR))).toBe("060100" + "01");
  });

  it("0x07 LOAD var:u8, src:u8, arg:u8 — EMIT's source enum, written into var[]", () => {
    // ★ The opcode slice 1 could not do without. `LOAD var15 <- LISTFOCUS(slot 1)`: src is the
    // FFSP_EMIT_* id, arg indexes the SAME space EMIT's arg does for that source (here, a slot).
    expect(ihex(Op.load(NOTIFY_VAR, EMIT_SRC.LISTFOCUS, 1))).toBe("070300" + "0f" + "01" + "01");
    expect(ihex(Op.load(0, EMIT_SRC.EVT_CODE, 0xff))).toBe("070300" + "00" + "04" + "ff");
  });

  it("0x07 LOAD binds `arg` at vmask slot 2 — (var, src, arg) in DECLARED ORDER", () => {
    // ⚠️ NOT slot 1. EMIT's identically-named `arg` is operand 1 of (src, arg, shift, width); LOAD's
    // is operand 2 of (var, src, arg). Same enum, same arg spaces, DIFFERENT operand order — which
    // is exactly the kind of near-miss a shared source reader tempts an encoder into getting wrong.
    expect(ihex(Op.load(0, EMIT_SRC.LISTFOCUS, varRef(3)))).toBe("070304" + "00" + "01" + "03");
    expect(ihex(Op.emit(EMIT_SRC.LISTFOCUS, varRef(3), 0, 4))).toBe("050402" + "01" + "03" + "00" + "04");
  });

  it("0x07 LOAD takes EMIT's per-source `arg` guard, from the SAME validator", () => {
    // The glasses MASK rather than check: slots by >= FFSP_MAX_SLOTS, vars by & 0x0F, events by
    // & 15. A second copy of that table under LOAD would eventually disagree with EMIT's, and a
    // program would then read one thing into a variable and report another.
    expect(() => Op.load(0, EMIT_SRC.LISTFOCUS, 9)).toThrow(/indexes a SLOT/);
    expect(() => Op.load(0, EMIT_SRC.EVT_CODE, 20)).toThrow(/indexes the 16-entry event ring/);
    expect(() => Op.load(0, EMIT_SRC.VAR, 16)).toThrow(/indexes var\[\]/);
    expect(() => Op.load(0, 11, 0)).toThrow(/defined sources/);
    expect(() => Op.load(16, EMIT_SRC.GEN, 0)).toThrow(/out of range 0\.\.15/);
    // …and the message names LOAD, not EMIT, so the author is told which instruction refused.
    expect(() => Op.load(0, EMIT_SRC.LISTFOCUS, 9)).toThrow(/^LOAD: /);
  });

  it("0x10 PARENT target:u8", () => {
    expect(ihex(Op.parent(1))).toBe("100100" + "01");
  });

  it("0x11 CLEAR", () => {
    expect(ihex(Op.clear())).toBe("110000");
  });

  it("0x12 MOVE slot:u8, x:i16, y:i16", () => {
    expect(ihex(Op.move(1, 40, -8))).toBe("120500" + "01" + "2800" + "f8ff");
  });

  it("0x13 SIZE slot:u8, w:i16, h:i16", () => {
    expect(ihex(Op.size(0, 496, 46))).toBe("130500" + "00" + "f001" + "2e00");
  });

  it("0x14 STYLE slot:u8, prop:u8, value:i32 — with the parent sentinel", () => {
    // ⚠️ BG_OPA(29)=0 on the page root is the FUT-198 guard. Without it the root is a filled
    // bright rectangle over the whole HUD.
    expect(ihex(Op.style(FFSP_SLOT_PARENT, STYLE_PROP.BG_OPA, 0)))
      .toBe("140600" + "fe" + "1d" + "00000000");
  });

  it("0x15 FLAG slot:u8, flag:u32, on:u8", () => {
    expect(ihex(Op.flag(0, 1, 1))).toBe("150600" + "00" + "01000000" + "01");
  });

  it("0x20 TEXT dst:u8, x,y,w,h:i16, bw,bc,rad,pad,font:u8, str (NUL-terminated)", () => {
    const i = Op.text({
      dst: 0, x: 40, y: 18, w: 496, h: 46,
      bw: 2, bc: 15, rad: 10, pad: 6, font: 1,
      str: new TextEncoder().encode("FFS OS\0"),
    });
    expect(ihex(i)).toBe(
      "201500" +          // op, len = 14 + 7, vmask
      "00" +              // dst
      "2800" + "1200" + "f001" + "2e00" +   // 40, 18, 496, 46
      "02" + "0f" + "0a" + "06" + "01" +    // bw bc rad pad font
      "464653204f5300",   // "FFS OS\0"
    );
  });

  it("0x21 LIST dst:u8, x,y,w,h:i16, bw,bc,rad,pad:u8, n:u8, n NUL-terminated strings", () => {
    const items = new TextEncoder().encode("CLOCK\0CAMERA\0SETTINGS\0");
    const i = Op.list({
      dst: 1, x: 40, y: 78, w: 496, h: 150,
      bw: 2, bc: 15, rad: 10, pad: 8, n: 3, items,
    });
    expect(ihex(i)).toBe(
      "212400" +          // op, len = 14 + 22, vmask
      "01" +
      "2800" + "4e00" + "f001" + "9600" +
      "02" + "0f" + "0a" + "08" +
      "03" +
      "434c4f434b00" + "43414d45524100" + "53455454494e475300",
    );
  });

  it("0x22 OBJ dst:u8", () => {
    expect(ihex(Op.obj(2))).toBe("220100" + "02");
  });

  it("0x23 BOUNCE slot:u8, base_y:i16, dir:u8", () => {
    expect(ihex(Op.bounce(1, 78, 0))).toBe("230400" + "01" + "4e00" + "00");
  });

  // ── newgfx family (0x24–0x27), hand-derived from §3's table — must equal ffsp_goldens.json ──
  it("0x24 FONT slot:u8, font_id:u8 — a SMALL ENUM, never a pointer", () => {
    expect(ihex(Op.font(0, 0))).toBe("240200" + "00" + "00");        // FONT (default+icons)
    expect(ihex(Op.font(1, 5))).toBe("240200" + "01" + "05");        // FONT_CLOCK (num62 face)
  });

  it("0x25 IMAGE dst:u8, x,y:i16, w,h:u16, bw,bc,rad:u8 — len 12, w/h are u16", () => {
    expect(ihex(Op.image({ dst: 3, x: 40, y: 60, w: 288, h: 144, bw: 2, bc: 15, rad: 10 }))).toBe(
      "250c00" +          // op, len = 12, vmask
      "03" +              // dst
      "2800" + "3c00" +   // x=40, y=60 (i16)
      "2001" + "9000" +   // w=288, h=144 (u16)
      "02" + "0f" + "0a", // bw bc rad
    );
  });

  it("0x26 ANIM slot, dur,delay:u16, x0,x1,y0,y1,w0,w1,h0,h1:i16 — START,END per channel", () => {
    expect(ihex(Op.anim({
      slot: 1, x0: -496, x1: 40, y0: 78, y1: 78, w0: 496, w1: 496, h0: 150, h1: 150,
      durMs: 300, delayMs: 0,
    }))).toBe(
      "261500" +          // op, len = 21, vmask
      "01" +              // slot
      "2c01" + "0000" +   // dur_ms=300, delay_ms=0 (u16)
      "10fe" + "2800" + "4e00" + "4e00" +   // x0=-496, x1=40, y0=78, y1=78
      "f001" + "f001" + "9600" + "9600",    // w0=496, w1=496, h0=150, h1=150
    );
    // x0 is [V3], y1 is [V6] — binding both sets vmask 0x08 | 0x40 = 0x48; the var index rides in
    // the operand's own bytes (x0->var[0]=0000, y1->var[6]=0600).
    expect(ihex(Op.anim({
      slot: 1, x0: varRef(0), x1: 40, y0: 78, y1: varRef(6), w0: 496, w1: 496, h0: 150, h1: 150,
      durMs: 300, delayMs: 0,
    }))).toBe("261548" + "01" + "2c01" + "0000" + "0000" + "2800" + "4e00" + "0600" +
      "f001" + "f001" + "9600" + "9600");
  });

  it("0x27 INK slot, prim, a..f:i16, w,lvl:u8 — len 16, coords are WHOLE PIXELS", () => {
    // SEG: reads a,b,c,d (ax,ay,bx,by); e,f default 0. w=halfwidth, lvl=grey index 0..15.
    expect(ihex(Op.ink({ slot: 3, prim: 1, a: 4, b: 4, c: 60, d: 40, w: 2, lvl: 15 }))).toBe(
      "271000" + "03" + "01" +
      "0400" + "0400" + "3c00" + "2800" + "0000" + "0000" +   // a b c d e f
      "02" + "0f",                                            // w lvl
    );
    // RING: reads a,b,c (cx,cy,r); w defaults nothing-specific here but is 1 unless given.
    expect(ihex(Op.ink({ slot: 1, prim: 3, a: 44, b: 44, c: 36, w: 1, lvl: 12 }))).toBe(
      "271000" + "01" + "03" + "2c00" + "2c00" + "2400" + "0000" + "0000" + "0000" + "01" + "0c");
    // TRI: reads a..f (three points); a FILLED primitive with no halfwidth, so `w` defaults to 1.
    expect(ihex(Op.ink({ slot: 2, prim: 5, a: -8, b: -8, c: 8, d: -8, e: 0, f: 12, lvl: 15 }))).toBe(
      "271000" + "02" + "05" + "f8ff" + "f8ff" + "0800" + "f8ff" + "0000" + "0c00" + "01" + "0f");
  });

  // ★ GIF (0x28) — native frame cycling over three IMAGE slots, ping-pong at 100 ms/frame.
  // len must be 5 + n = 8 (dst + period:u16 + mode + n + 3 slots); `len` is the field the
  // zero-knowledge `pc += 3 + len` skip rule depends on, so an off-by-one is status=LEN or an
  // interpreter walking into the next instruction. period is LITTLE-ENDIAN (100 => 64 00), n is
  // DERIVED from srcSlots.length, and vmask is 0 because GIF has no [V] operands. Hand-derived
  // from ffs_prog.h §3 — must equal tools/ffsp_goldens.json's "GIF" entry.
  it("0x28 GIF dst:u8, period_ms:u16, mode:u8, n:u8, src_slots[n]:u8", () => {
    expect(ihex(Op.gif(4, [1, 2, 3], 100, GIF_MODE.PINGPONG))).toBe(
      "280800" +          // op, len = 5 + 3, vmask (no [V] operands)
      "04" +              // dst
      "6400" +            // period_ms = 100, little-endian
      "02" +              // mode = PINGPONG
      "03" +              // n (derived)
      "01" + "02" + "03", // src slots
    );
    // period 0 => the firmware's own 50 ms default is a legal wire value, not a refusal.
    // n=2 => len = 5 + 2 = 7 (0x07); the minimum-frame GIF.
    expect(ihex(Op.gif(0, [5, 6], 0, GIF_MODE.LOOP))).toBe("280700" + "00" + "0000" + "00" + "02" + "05" + "06");
  });

  it("0x30 WFCREATE kind:u8, x:i16, cfg[c]", () => {
    const cfg = bigClock({ clock: 0, left: 1, right: 4 }).cfg;
    expect(ihex(Op.wfCreate(1, 40, cfg))).toBe("300b00" + "01" + "2800" + "0100000000010400");
  });

  it("0x31 WFCALL kind:u8, slot:u8, a,b,c,d:i32", () => {
    // Kind 4's set_time, called the way it actually READS: hour in arg2, minute in arg1.
    // Through Even's own manager it takes the h24 flag as the hour and shows "0:MM"/"1:MM".
    expect(ihex(Op.wfCall(4, 3, 0, 20, 17, 0))).toBe(
      "311200" + "04" + "03" + "00000000" + "14000000" + "11000000" + "00000000",
    );
  });

  it("0x32 DASH base_pos, wcount, order[5], wf_kind, wf_a/b/c:u32, wf_n:u16, wf_items:u16", () => {
    expect(ihex(Op.dash({
      basePos: 2, wcount: 5, order: [0, 1, 2, 4, 3], wfKind: 1,
      wfA: 0, wfB: 1, wfC: 4, wfN: 0, wfItems: 0,
    }))).toBe(
      "321800" + "02" + "05" + "0001020403" + "01" +
      "00000000" + "01000000" + "04000000" + "0000" + "0000",
    );
  });

  it("0x33 LISTEV slot:u8, ev:u8", () => {
    expect(ihex(Op.listEv(1, 0))).toBe("330200" + "01" + "00");
    expect(ihex(Op.listEv(1, 1))).toBe("330200" + "01" + "01");
  });

  it("0x40 PAGE which:u8, rest_pct:u8, anim_ms:u16, prio:u8", () => {
    expect(ihex(Op.page(WHICH.OVERLAY, 100, 120, 255)))
      .toBe("400500" + "00" + "64" + "7800" + "ff");
  });

  it("0x41 SHOW / 0x42 HIDE which:u8", () => {
    expect(ihex(Op.show(0))).toBe("410100" + "00");
    expect(ihex(Op.hide(0))).toBe("420100" + "00");
  });

  it("0x43 ON class:u8, dev:u8, div:u8, raw:u8, block_len:u16", () => {
    expect(ihex(Op.on(2, DEV.ANY, 4, 0, 5)))
      .toBe("430600" + "02" + "ff" + "04" + "00" + "0500");
  });

  it("0x44 PDESC sys_id:u16, field:u8, value:i32", () => {
    expect(ihex(Op.pdesc(3, 1, 200))).toBe("440700" + "0300" + "01" + "c8000000");
  });

  it("0x46 SHOWSYS sys_id:u16", () => {
    expect(ihex(Op.showSys(1))).toBe("460200" + "0100");
  });

  it("0x70 CALL addr:u32, a,b,c,d:i32", () => {
    expect(ihex(Op.call(0x00438001, 1, 2, 3, 4))).toBe(
      "701400" + "01804300" + "01000000" + "02000000" + "03000000" + "04000000",
    );
  });

  it("0x71 WRITE region:u8, off:u16, size:u8, value:u32", () => {
    expect(ihex(Op.write(0, 0x40, 1, 2))).toBe("710800" + "00" + "4000" + "01" + "02000000");
  });

  it("0x72 READ var:u8, region:u8, off:u16, size:u8", () => {
    expect(ihex(Op.read(0, 1, 0x10, 4))).toBe("720500" + "00" + "01" + "1000" + "04");
  });

  it("sets bit 7 of the op byte for a REQUIRED instruction", () => {
    // The AUTHOR declares the consequence per instruction: an interpreter that lacks a REQUIRED
    // opcode aborts with status=UNKNOWN_REQUIRED instead of skipping it.
    expect(ihex(required(Op.page(0, 100, 120, 255)))).toBe(
      "c00500" + "00" + "64" + "7800" + "ff",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// vmask — a SEPARATE BYTE, never a tag in the value's top bits
// ══════════════════════════════════════════════════════════════════════════════════════

describe("vmask", () => {
  it("marks operand slots in DECLARED ORDER, and the value becomes a var index", () => {
    // MOVE slot:u8(0), x:i16[V1], y:i16[V2] — binding y alone sets BIT 2, i.e. vmask 0x04.
    expect(ihex(Op.move(1, 40, varRef(3)))).toBe("120504" + "01" + "2800" + "0300");
    expect(ihex(Op.move(1, varRef(2), 0))).toBe("120502" + "01" + "0200" + "0000");
    expect(ihex(Op.move(1, varRef(2), varRef(3)))).toBe("120506" + "01" + "0200" + "0300");
  });

  it("is zero on everything the authoring surface emits by default", () => {
    // ⚠️ ffs_prog.h's table used to annotate IFVAR's `imm` as [V1] while its own prose rule
    // ("numbered from 0 in DECLARED ORDER") made it operand 2. program.ts followed the prose and
    // reported the typo; §3 now reads [V2], so table and prose agree and bit 2 is the contract.
    // Nothing in the authoring surface sets that bit either way.
    const a = assemble(SLICE1);
    let pc = 0;
    while (pc + 3 <= a.codeLen) {
      const len = a.code[pc + 1];
      expect(a.code[pc + 2]).toBe(0);
      pc += 3 + len;
    }
  });

  it("keeps a negative i32 out of the var space entirely", () => {
    // -5.0f is 0xC0A00000; a top-two-bits tag would read it as a variable reference. The whole
    // reason vmask is its own byte.
    expect(ihex(Op.style(0, STYLE_PROP.TRANSLATE_X, -0x3f600000))).toBe(
      "140600" + "00" + "6c" + "0000a0c0",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// SLICE 1 — the menu that answers a finger
// ══════════════════════════════════════════════════════════════════════════════════════

/** design §6's Push A, typed the way §4 says a developer types it. */
const SLICE1 = screen(
  [
    text({
      id: "title", x: 40, y: 18, w: 496, h: 46,
      text: "FFS OS", border: 2, radius: 10, pad: 6,
    }),
    list({
      id: "menu", x: 40, y: 78, w: 496, h: 150,
      items: ["CLOCK", "CAMERA", "SETTINGS"],
      border: 2, radius: 10, pad: 8,
    }),
  ],
  {
    page: "overlay",
    // ★ "sel" IS THE PHONE-VISIBLE NOTIFY SLOT, pinned to FFSP_NOTIFY_VAR, so the ONE thing the tap
    // records is the thing the next readback reports. vm->var[] is resident across pushes, which is
    // why an index two independently-authored programs can agree on has to be named rather than
    // allocated.
    vars: { sel: FFSP_NOTIFY_VAR },
    on: {
      scrollFwd: listNext("menu"),   // DOWNROLL — focus moves FORWARD
      scrollBack: listPrev("menu"),  // UPROLL   — and this one DECREMENTS
      // ★ §6's TAP HANDLER, AS WRITTEN, AND IT ONLY BECAME EXPRESSIBLE WITH 0x07 LOAD.
      // It used to be `notify(1)` — a bare marker — because SET takes an immediate and EMIT ORs
      // into a result mask a handler has no channel to return, so the push could prove A HANDLER
      // RAN but not WHAT WAS FOCUSED. Now the readback reports the selection itself.
      tap: set("sel", listFocus("menu")),
    },
  },
);

describe("slice 1 — screen() lowering", () => {
  // Hand-derived, instruction by instruction, from §3's table. Chunked so a failure names the
  // instruction that drifted rather than dumping 141 bytes.
  const DRAW = [
    "060100" + "01",                                    // NEED datum=PAGEMGR
    "400500" + "00" + "64" + "7800" + "ff",             // PAGE overlay, 100%, 120ms, prio 255
    "100100" + "01",                                    // PARENT overlay root
    "140600" + "fe" + "1d" + "00000000",                // STYLE parent BG_OPA = 0 (FUT-198 guard)
    "110000",                                           // CLEAR
    "201500" + "00" + "2800" + "1200" + "f001" + "2e00" +
      "02" + "0f" + "0a" + "06" + "01" + "464653204f5300",
    "212400" + "01" + "2800" + "4e00" + "f001" + "9600" +
      "02" + "0f" + "0a" + "08" + "03" +
      "434c4f434b00" + "43414d45524100" + "53455454494e475300",
    "410100" + "00",                                    // SHOW overlay
    "000000",                                           // END  <- draw_end
  ].join("");

  const BLOCKS = [
    "430600" + "02" + "ff" + "04" + "00" + "0500",      // ON SCROLL_FWD any div=4, block 5 B
    "330200" + "01" + "00",                             //   LISTEV slot 1, DOWN
    "430600" + "03" + "ff" + "04" + "00" + "0500",      // ON SCROLL_BACK any div=4
    "330200" + "01" + "01",                             //   LISTEV slot 1, UP  (decrements)
    "430600" + "00" + "ff" + "01" + "00" + "0600",      // ON TAP any div=1, block 6 B
    "070300" + "0f" + "01" + "01",                      //   LOAD var15 <- LISTFOCUS(slot 1)
  ].join("");

  it("assigns slot indices from string ids, so the author never types a number", () => {
    const a = assemble(SLICE1);
    expect(a.slots).toEqual({ title: 0, menu: 1 });
  });

  it("emits the exact byte layout of §3", () => {
    const a = assemble(SLICE1);
    expect(hex(a.code.subarray(0, a.drawEnd))).toBe(DRAW);
    expect(hex(a.code.subarray(a.drawEnd))).toBe(BLOCKS);
  });

  it("computes draw_end, code_len and the CRC over code[0..code_len)", () => {
    const a = assemble(SLICE1);
    expect(a.drawEnd).toBe(DRAW.length / 2);
    expect(a.drawEnd).toBe(98);
    expect(a.codeLen).toBe((DRAW.length + BLOCKS.length) / 2);
    expect(a.codeLen).toBe(141);
    expect(a.crc).toBe(crc16(a.code));
  });

  it("★ the TAP handler is a LOAD — the push now reports WHAT was focused, not just that it ran", () => {
    const a = assemble(SLICE1);
    const blocks = hex(a.code.subarray(a.drawEnd));
    // ON TAP's 9-byte header, then the handler stream: `block_len` counts ONLY the handler
    // instructions, so the block is [pc+9, pc+9+block_len) — 6 bytes, exactly one LOAD.
    const at = blocks.indexOf("430600" + "00" + "ff" + "01" + "00" + "0600");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(blocks.slice(at + 18, at + 18 + 12)).toBe("070300" + "0f" + "01" + "01");
    // LOAD is on FFSP_OP_ALLOWED_IN_HANDLER, so it passes the allowlist rather than sneaking past
    // it: a handler that cannot write var[] cannot remember a selection, which is why 0x07 exists.
    expect(blocks.includes("070300")).toBe(true);
  });

  it("packs the 16-byte header exactly as ffsp_prog_t declares it", () => {
    const a = assemble(SLICE1);
    expect(a.header.length).toBe(FFSP_HDR_SIZE);
    const dv = new DataView(a.header.buffer);
    expect(dv.getUint32(0, true)).toBe(FFSP_MAGIC);     // "FFSP" LE
    expect(hex(a.header.subarray(0, 4))).toBe("46465350");
    expect(a.header[4]).toBe(FFSP_ABI);
    expect(a.header[5]).toBe(FFSP_SYMGEN);
    expect(dv.getUint16(6, true)).toBe(FFSP_FW_BUILD);  // 22714 — there is no other target
    expect(dv.getUint16(8, true)).toBe(a.codeLen);      // ★ the round-trip echo field
    expect(dv.getUint16(10, true)).toBe(a.crc);
    expect(dv.getUint16(12, true)).toBe(a.drawEnd);
    expect(dv.getUint16(14, true)).toBe(0);             // no KEEP, no UNSAFE, no READBACK
    // Pinned whole. The CRC literal is the one value here that is not hand-derivable, and it is
    // pinned rather than recomputed so that a drift in ANY code byte fails on this line too.
    // ⚠️ IT MOVED 0x4AAD -> 0x5C2D WHEN THE TAP HANDLER BECAME A LOAD, and `patch_prog.py` computed
    // 0x5C2D independently from the same authored screen — two implementations, one number, which
    // is the only kind of agreement code_crc cannot manufacture for itself. `code_len` (141) and
    // `draw_end` (98) did NOT move: LOAD is 6 bytes exactly as the SET marker it replaced was, and
    // it lives after draw_end.
    expect(a.crc).toBe(0x5c2d);
    expect(hex(a.header)).toBe(
      "46465350" + "01" + "01" + "ba58" + "8d00" + "2d5c" + "6200" + "0000",
    );
  });

  it("pads the patchable object to the full 2064-byte hole", () => {
    const a = assemble(SLICE1);
    expect(a.object.length).toBe(FFSP_PROG_SIZE);
    expect(hex(a.object.subarray(0, FFSP_HDR_SIZE + a.codeLen))).toBe(hex(a.image));
    // Everything past code_len is zero, i.e. it decodes as END if anything ever walked into it.
    expect(a.object.subarray(FFSP_HDR_SIZE + a.codeLen).every((b) => b === 0)).toBe(true);
  });

  it("fits the 2048 B hole with room to spare", () => {
    expect(assemble(SLICE1).codeLen).toBeLessThan(2048);
  });

  it("hides the LISTEV inversion behind listNext/listPrev", () => {
    // ★ The author writes "next"; the wire says DOWN=0. The author writes "prev"; the wire says
    // UP=1, which DECREMENTS. That inversion is table data in ffs_prog.h, not folklore.
    const fwd = assemble(screen([list({ id: "m", x: 0, y: 0, w: 10, h: 10, items: ["a"] })],
      { on: { scrollFwd: listNext("m") } }));
    const back = assemble(screen([list({ id: "m", x: 0, y: 0, w: 10, h: 10, items: ["a"] })],
      { on: { scrollBack: listPrev("m") } }));
    // The list is the only widget, so it is slot 0; only the trailing `ev` byte differs.
    expect(hex(fwd.code.subarray(fwd.drawEnd)).endsWith("330200" + "00" + "00")).toBe(true);
    expect(hex(back.code.subarray(back.drawEnd)).endsWith("330200" + "00" + "01")).toBe(true);
  });

  it("defaults div to 4 on the scroll classes and 1 elsewhere — a swipe is a STREAM", () => {
    // One forward swipe measured 4 DOWNROLLs, one backward 5 UPROLLs. Treating each as one step
    // would scroll four to five times too far.
    const a = assemble(SLICE1);
    const blocks = hex(a.code.subarray(a.drawEnd));
    expect(blocks.slice(0, 14)).toBe("430600" + "02" + "ff" + "04" + "00");
    expect(blocks.indexOf("430600" + "00" + "ff" + "01")).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// PUSH B — the readback, and PUSH C — park()
// ══════════════════════════════════════════════════════════════════════════════════════

describe("readback() — design §6's Push B", () => {
  const RB = readback(
    [
      field(listFocus("menu"), 0, 4),   // bits 0..3
      field(evtCount(), 4, 8),          // bits 4..11
      field(evtCode(), 12, 8),          // bits 12..19  (arg 0xFF = the LAST event)
      field(evtDev(), 20, 4),           // bits 20..23
    ],
    { slots: assemble(SLICE1).slots },
  );

  it("emits four EMITs and an END", () => {
    const a = assemble(RB);
    expect(hex(a.code)).toBe(
      "050400" + "01" + "01" + "00" + "04" +
      "050400" + "03" + "00" + "04" + "08" +
      "050400" + "04" + "ff" + "0c" + "08" +
      "050400" + "05" + "ff" + "14" + "04" +
      "000000",
    );
    expect(a.codeLen).toBe(31);
    expect(a.drawEnd).toBe(31);   // no ON blocks: the whole program is the draw pass
  });

  it("sets READBACK and KEEP — a readback must never clear the screen it is reading", () => {
    const a = assemble(RB);
    expect(a.flags).toBe(FFSP_FLAG.READBACK | FFSP_FLAG.KEEP);
    expect(hex(a.header.subarray(14))).toBe("0500");
  });

  it("refuses a field that runs past bit 23 — the ffs_gesture_wizard truncation", () => {
    // Its first reader put a 12-bit field at bit 20; the overflow was silently masked off by the
    // `& 0x00FFFFFF` on the way out and every odd-indexed event decoded as code 0x00.
    expect(() => readback([field(evtCode(), 20, 8)])).toThrow(/past bit 23/);
  });

  it("refuses overlapping fields — EMIT ORs, so an overlap corrupts both silently", () => {
    expect(() => readback([field(evtCount(), 0, 8), field(evtDev(), 4, 4)])).toThrow(/overlaps/);
  });

  it("echoProgram() is EMIT(CODE_LEN,0,0,16) + END — the CI round-trip proof", () => {
    // The instruction itself, hand-derived, independent of the padding below.
    expect(hex(insBytes(Op.emit(8, 0, 0, 16)))).toBe("050400" + "08" + "00" + "00" + "10");
    const bare = assemble(echoProgram(10));
    expect(hex(bare.code)).toBe("050400" + "08" + "00" + "00" + "10" + "000000");
    expect(bare.codeLen).toBe(10);
    void programLength; // the named source that produced src=8
  });

  it("★ pads to the DISTINCTIVE code_len 0x0255, because the point is to spot a folded readback", () => {
    // ⚠️ 0x0255 = 0000 0010 0101 0101. The alternating low bits are the whole design: a folded,
    // masked or truncated readback is visible AT A GLANCE, and 0x7F000255 as a ret= word is
    // unmistakable. The bare 10-byte version expected 0x7F00000A, and 10 is very hard to tell apart
    // from a partially folded or byte-truncated readback of 10. `patch_prog.py --selftest-echo` pads
    // to exactly this number (its own ECHO_LEN_DEFAULT is 0x0255); if CI ever pushes the TS-built
    // echo the two must agree on the word. ⚠️ TS drifted to 0x0555 (code_len 1365 vs Python's 597)
    // and the whole-program cross-check below caught it.
    const a = assemble(echoProgram());
    expect(a.codeLen).toBe(0x0255);
    expect(a.drawEnd).toBe(0x0255);   // no ON blocks: the whole program is the draw pass
    expect(ECHO_LEN_DEFAULT).toBe(0x0255);
    // The head is unchanged; everything after it is skippable filler.
    expect(hex(a.code.subarray(0, 10))).toBe("050400" + "08" + "00" + "00" + "10" + "000000");
    // ★ op 0x7F with bit 7 CLEAR is optional, so a conforming interpreter skips it with the
    // zero-knowledge rule `pc += 3 + len` and counts it in FFSP_EMIT_SKIPPED. Re-walk with that
    // rule alone and require it to land exactly on code_len.
    let pc = 0, seen = 0;
    while (pc < a.codeLen) {
      if (pc >= 10) {
        expect(a.code[pc]).toBe(0x7f);
        expect(a.code[pc] & 0x80).toBe(0);   // optional, never REQUIRED
        seen++;
      }
      pc += 3 + a.code[pc + 1];
    }
    expect(pc).toBe(a.codeLen);
    expect(seen).toBe(3);   // 2 x 258 B + 1 x 71 B = 587 B of padding (597 - 10)
  });
});

describe("park() — design §5.4's Push C", () => {
  it("is HIDE overlay + SHOWSYS + END, 12 bytes", () => {
    const a = assemble(park());
    expect(hex(a.code)).toBe("420100" + "00" + "460200" + "0100" + "000000");
    expect(a.codeLen).toBe(12);
  });

  it("carries KEEP, because parking must not clear the slots it stands down from", () => {
    expect(assemble(park()).flags).toBe(FFSP_FLAG.KEEP);
  });

  it("restores a BASE page and not just the overlay — operational rule #3", () => {
    // A cleanup that hides the overlay and stops leaves the HUD blank. Recovery from that is
    // pushing a stock dashboard, which costs a whole cycle.
    const a = assemble(park({ sysId: 3 }));
    expect(hex(a.code)).toBe("420100" + "00" + "460200" + "0300" + "000000");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// dashboard()
// ══════════════════════════════════════════════════════════════════════════════════════

describe("dashboard()", () => {
  const MIRROR = dashboard({
    basePos: "right",
    widgets: [0, 1, 2, 4, 3],
    face: bigClock({ clock: 0, left: 1, right: 4 }),
  });

  it("lowers to NEED(DASH) + one DASH + END", () => {
    const a = assemble(MIRROR);
    expect(hex(a.code)).toBe(
      "060100" + "03" +
      "321800" + "02" + "05" + "0001020403" + "01" +
      "00000000" + "01000000" + "04000000" + "0000" + "0000" +
      "000000",
    );
    expect(a.codeLen).toBe(34);
    expect(a.drawEnd).toBe(34);
  });

  it("restates apply_geo, so a push can be graded against a number decided beforehand", () => {
    expect(dashboardGeometry({ basePos: "left", widgetCount: 0 })).toEqual({ watchfaceX: 0, widgetColX: 0 });
    expect(dashboardGeometry({ basePos: "centre", widgetCount: 0 })).toEqual({ watchfaceX: 188, widgetColX: 0 });
    expect(dashboardGeometry({ basePos: "right", widgetCount: 0 })).toEqual({ watchfaceX: 376, widgetColX: 0 });
    expect(dashboardGeometry({ basePos: "left", widgetCount: 5 })).toEqual({ watchfaceX: 0, widgetColX: 224 });
    expect(dashboardGeometry({ basePos: "right", widgetCount: 5 })).toEqual({ watchfaceX: 376, widgetColX: 0 });
  });

  it("refuses CENTER with widgets — the case that renders stock and looks like a no-op", () => {
    expect(() => dashboard({ basePos: "centre", widgets: [0, 1], face: bigClock() })).toThrow(/CENTER/);
  });

  it("carries a world clock's derived count into wf_n", () => {
    const a = assemble(dashboard({
      basePos: "left", widgets: [], face: worldClock({ zones: [{ name: "LON", utc: 0 }, { name: "NYC", utc: -5 }] }),
    }));
    // …base_pos=0 wcount=0 order=00000 kind=4, a=align 0, b=0, c=0, n=2, items=0
    expect(hex(a.code)).toBe(
      "060100" + "03" +
      "321800" + "00" + "00" + "0000000000" + "04" +
      "00000000" + "00000000" + "00000000" + "0200" + "0000" +
      "000000",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// WATCHFACES — the one firmware struct layout that lives in TypeScript
// ══════════════════════════════════════════════════════════════════════════════════════

describe("watchface configs", () => {
  it("kind 1 puts the union body at cfg+4", () => {
    expect(hex(bigClock({ clock: 0, left: 1, right: 4 }).cfg)).toBe("0100000000010400");
  });

  it("kind 3 likewise, with align/date_en/temperature_en", () => {
    expect(hex(dateTemp({ align: 0, date: true, temperature: true }).cfg)).toBe("0300000000010100");
    expect(hex(dateTemp({ align: 2, date: false, temperature: true }).cfg)).toBe("0300000002000100");
  });

  it("kind 4 is 117 bytes with the counts DERIVED, not trusted", () => {
    // ★ The firmware rejects a three-way count mismatch SILENTLY, which is indistinguishable from
    // a dead push. name_count and utc_offset_count are computed from the zone list, never taken.
    const cfg = worldClock({
      align: 0,
      zones: [{ name: "LON", utc: 0 }, { name: "NYC", utc: -5 }, { name: "DEL", utc: 5.5 }],
    }).cfg;
    expect(cfg.length).toBe(117);
    expect(cfg[0]).toBe(4);          // cfg+0  kind
    expect(cfg[4]).toBe(0);          // base+0 align
    expect(cfg[5]).toBe(3);          // base+1 world_clock_count
    expect(cfg[6]).toBe(3);          // base+2 utc_offset_count  — derived
    expect(cfg[20]).toBe(3);         // base+16 name_count       — derived
    // base+4  f32[3], IEEE-754, in HOURS. 5.5f = 0x40B00000, and only a float can turn :20 into
    // :50 — which is what the photographed "DEL 22:50" demonstrated.
    expect(hex(cfg.subarray(8, 20))).toBe("00000000" + "0000a0c0" + "0000b040");
    // base+17 char[3][32], INLINE arrays with stride 32. base+17 being ODD is the tell that
    // name_count at base+16 is a u8, not a 16-bit pb_size_t.
    expect(new TextDecoder().decode(cfg.subarray(21, 24))).toBe("LON");
    expect(new TextDecoder().decode(cfg.subarray(53, 56))).toBe("NYC");
    expect(new TextDecoder().decode(cfg.subarray(85, 88))).toBe("DEL");
    expect(cfg[24]).toBe(0);
  });

  it("⛔ refuses a fourth world clock — the cap is 3, not 4", () => {
    expect(() => worldClock({
      zones: [{ name: "A", utc: 0 }, { name: "B", utc: 1 }, { name: "C", utc: 2 }, { name: "D", utc: 3 }],
    })).toThrow(/1\.\.3/);
    expect(() => worldClock({ zones: [] })).toThrow(/1\.\.3/);
  });

  it("refuses a zone name the firmware would silently truncate", () => {
    expect(() => worldClock({ zones: [{ name: "x".repeat(32), utc: 0 }] })).toThrow(/truncat/);
  });

  it("stubs kind 2 with a reason instead of guessing its offsets", () => {
    expect(() => listFace()).toThrow(/not pinned/);
  });

  it("places two DIFFERENT designs at coordinates their layout engine cannot produce", () => {
    // Their engine computes ONE watchface at one of 0 / 188 / 376. Proven on-glass at 40 and 336.
    const a = assemble(screen([
      watchface({ x: 40, face: bigClock({ clock: 0, left: 1, right: 4 }) }),
      watchface({ x: 336, face: dateTemp({ align: 0, date: true, temperature: true }) }),
    ]));
    const s = hex(a.code);
    expect(s.includes("300b00" + "01" + "2800" + "0100000000010400")).toBe(true);
    expect(s.includes("300b00" + "03" + "5001" + "0300000000010100")).toBe(true);
  });

  it("gives a watchface no slot — WFCREATE returns a STATUS, not a handle", () => {
    // Testing it as a pointer reads a clean success as a failure: ret=0x7A88200F, "both creates
    // failed" sitting next to a child count that had grown by exactly 2.
    const a = assemble(screen([
      watchface({ x: 40, face: bigClock() }),
      list({ id: "menu", x: 0, y: 0, w: 10, h: 10, items: ["a"] }),
    ]));
    expect(a.slots).toEqual({ menu: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// THE THROWS — every §7 constraint the format cannot enforce
// ══════════════════════════════════════════════════════════════════════════════════════

describe("constraints the format cannot enforce — program.ts throws, with the reason", () => {
  it("⛔ longPress(): 0x45 is reserved-dead, and the reason is in the message", () => {
    expect(() => Op.longPress()).toThrow(/0x45 is reserved and permanently unusable/);
    expect(() => Op.longPress()).toThrow(/above the page hook/i);
    expect(() => Op.longPress()).toThrow(/0x00442e70/);
    // ★ It must not be a silent no-op: that would read on the HUD as "long press does nothing on
    // this hardware", which is a different and wrong conclusion.
    expect(() => Op.longPress()).toThrow(/no-op/);
  });

  it("two text() in one screen — the second common_text_create returns NULL", () => {
    expect(() => screen([
      text({ id: "a", x: 0, y: 0, w: 10, h: 10, text: "A" }),
      text({ id: "b", x: 0, y: 20, w: 10, h: 10, text: "B" }),
    ])).toThrow(/ONE common_text_create AT A TIME/);
  });

  it("dashboard() composed with screen() — a whole-screen takeover cannot share a push", () => {
    const d = dashboard({ basePos: "left", widgets: [], face: bigClock() }) as unknown as never;
    expect(() => screen([d])).toThrow(/WHOLE-SCREEN TAKEOVER/);
  });

  it("two watchfaces of the same kind — module statics, so the second overwrites the first", () => {
    expect(() => screen([
      watchface({ x: 40, face: bigClock() }),
      watchface({ x: 336, face: bigClock({ left: 2 }) }),
    ])).toThrow(/two watchfaces of kind 1/);
  });

  it("border_color 16 — it is a GREY INDEX and Even's clamp lets 16 through to white", () => {
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: ["a"], borderColor: 16 }))
      .toThrow(/GREY INDEX/);
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: ["a"], borderColor: 16 }))
      .toThrow(/off-by-one/);
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: ["a"], borderColor: 15 })).not.toThrow();
  });

  it("item_count outside 1..20 — a NULL there is a SILENT NO-DRAW", () => {
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: [] })).toThrow(/SILENT NO-DRAW/);
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: new Array(21).fill("x") })).toThrow(/21 items/);
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: new Array(20).fill("x") })).not.toThrow();
  });

  it("a string longer than FFSP_MAX_STR, NUL included", () => {
    expect(() => text({ x: 0, y: 0, w: 1, h: 1, text: "x".repeat(64) })).toThrow(/FFSP_MAX_STR/);
    expect(() => text({ x: 0, y: 0, w: 1, h: 1, text: "x".repeat(63) })).not.toThrow();
  });

  it("an id that names no widget", () => {
    expect(() => screen([list({ id: "menu", x: 0, y: 0, w: 1, h: 1, items: ["a"] })],
      { on: { tap: listNext("nope") } })).toThrow(/no widget with id "nope"/);
  });

  it("a duplicate widget id — ids name slots and must be unique", () => {
    expect(() => screen([
      list({ id: "m", x: 0, y: 0, w: 1, h: 1, items: ["a"] }),
      list({ id: "m", x: 0, y: 0, w: 1, h: 1, items: ["a"] }),
    ])).toThrow(/share the id "m"/);
  });

  it("an opcode that is not on the handler allowlist, with WHY", () => {
    expect(() => screen([list({ id: "m", x: 0, y: 0, w: 1, h: 1, items: ["a"] })],
      { on: { tap: inlineOp(Op.clear()) } })).toThrow(/CLEAR is forbidden inside a handler/);
    expect(() => screen([list({ id: "m", x: 0, y: 0, w: 1, h: 1, items: ["a"] })],
      { on: { tap: inlineOp(Op.page(0, 100, 120, 255)) } })).toThrow(/ONE-WAY/);
    expect(() => screen([list({ id: "m", x: 0, y: 0, w: 1, h: 1, items: ["a"] })],
      { on: { tap: inlineOp(Op.call(0x00438001, 0, 0, 0, 0)) } })).toThrow(/even under UNSAFE/);
  });

  it("a handler over the 64-instruction budget — handlers run on the DISPLAY THREAD", () => {
    const many = new Array(65).fill(notify(1));
    expect(() => screen([list({ id: "m", x: 0, y: 0, w: 1, h: 1, items: ["a"] })],
      { on: { tap: many } })).toThrow(/budget is 64/);
  });

  it("CALL/WRITE/READ without FFSP_FLAG_UNSAFE", () => {
    const p = screen([], { });
    const withCall = { ...p, draw: [...p.draw, Op.call(0x00438001, 0, 0, 0, 0)] };
    expect(() => assemble(withCall)).toThrow(/needs FFSP_FLAG_UNSAFE/);
    expect(() => assemble({ ...withCall, flags: FFSP_FLAG.UNSAFE })).not.toThrow();
  });

  it("CALL outside flash text, or with the thumb bit clear", () => {
    expect(() => Op.call(0x20000001, 0, 0, 0, 0)).toThrow(/outside flash text/);
    expect(() => Op.call(0x00438000, 0, 0, 0, 0)).toThrow(/thumb bit/);
  });

  it("PDESC aimed at one of OUR page ids — it would destroy the resident VM", () => {
    expect(() => Op.pdesc(0x0ff5, 0, 0)).toThrow(/resident VM/);
    expect(() => Op.pdesc(0x0ff6, 0, 0)).toThrow(/fade duration/);
    expect(() => Op.pdesc(3, 0, 0)).not.toThrow();
  });

  it("PAGE with an id that is not one of the two — registration is ONE-WAY", () => {
    expect(() => Op.page(2, 100, 120, 255)).toThrow(/one-way/);
  });

  it("⚠️ a LIST refusal names WHICH cap bound — three can fire and they need different fixes", () => {
    // ffs_prog.h §7 pins FFSP_MAX_STR (64 B per string), FFSP_MAX_ITEMS (20) and — the one that
    // actually binds a long list — the u8 `len`, which leaves 241 B for the whole string blob. An
    // author told the wrong cap edits the wrong thing: "shorten the strings" and "split the list"
    // are different repairs.
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: new Array(21).fill("x") }))
      .toThrow(/BOUND THAT BIT HERE IS FFSP_MAX_ITEMS/);
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: new Array(20).fill("x".repeat(63)) }))
      .toThrow(/BOUND THAT BIT HERE IS THE u8 `len`/);
    expect(() => text({ x: 0, y: 0, w: 1, h: 1, text: "x".repeat(64) })).toThrow(/FFSP_MAX_STR/);
  });

  it("⚠️ a LIST whose payload overflows the u8 `len` — 241 B is the ceiling ffs_prog.h §7 now names", () => {
    // ★ THE HEADER SAYS THIS ITSELF NOW: FFSP_MAX_ITEMS (20) x FFSP_MAX_STR (64) = 1280 B is
    // "STRUCTURALLY UNREACHABLE" because `len` is a u8, so a LIST holds at most 255 - 14 = 241 B of
    // strings however many items it declares — and the encoders must say WHICH cap they refused on.
    // It was reported as a disagreement inside the header; it is table data now.
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: new Array(20).fill("x".repeat(63)) }))
      .toThrow(/`len` is a u8/);
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: new Array(20).fill("x".repeat(63)) }))
      .toThrow(/true ceiling is 241 B/);
    // 20 items of 11 chars = 240 B of strings, len = 254: the largest list that still fits.
    expect(() => list({ x: 0, y: 0, w: 1, h: 1, items: new Array(20).fill("x".repeat(11)) }))
      .not.toThrow();
  });

  it("a program larger than the 2048 B hole", () => {
    // Eight maximal lists: 8 x (3 + 254) = 2056 B of code[], plus the prologue.
    const big = new Array(20).fill("x".repeat(11));
    const eight = new Array(8).fill(0).map((_, i) =>
      list({ id: `l${i}`, x: 0, y: 0, w: 1, h: 1, items: big }));
    expect(() => assemble(screen(eight))).toThrow(/the hole holds 2048/);
  });

  it("⛔ CLEAR under PARENT lv_layer_top — it would delete every page root, ours and Even's", () => {
    // ffs_prog.h §3: the draw pass STARTS at lv_layer_top so a program with no PARENT still has
    // somewhere legal to draw — but lv_layer_top parents EVERY page root. `PARENT 0; CLEAR` is
    // therefore lv_obj_clean() over all of them, and page registration is ONE-WAY, so node[+0x04]
    // is left dangling with nothing able to repair it until reboot — and the next push's reuse path
    // hands that pointer to lv_obj_set_size. The interpreter refuses it with status=DATUM; refused
    // here first, with the reason.
    const p = park();
    const layerTop = { ...p, draw: [Op.parent(0), Op.clear(), Op.end()] };
    expect(() => assemble(layerTop)).toThrow(/lv_layer_top/);
    expect(() => assemble(layerTop)).toThrow(/ONE-WAY/);
    // No PARENT at all is the same case: the pass starts on the top layer.
    expect(() => assemble({ ...p, draw: [Op.clear(), Op.end()] })).toThrow(/status=DATUM/);
    // Our own two roots are exactly what CLEAR is for, and LAYER_TOP stays legal for DRAWING.
    expect(() => assemble({ ...p, draw: [Op.parent(1), Op.clear(), Op.end()] })).not.toThrow();
    expect(() => assemble({ ...p, draw: [Op.parent(2), Op.clear(), Op.end()] })).not.toThrow();
    expect(() => assemble({ ...p, draw: [Op.parent(0), Op.obj(0), Op.end()] })).not.toThrow();
    // …and screen() cannot produce the bad shape: it always PARENTs our root before clearing.
    expect(() => assemble(SLICE1)).not.toThrow();
  });

  it("a reserved flags bit — the interpreter refuses with status=MAGIC", () => {
    expect(() => assemble({ ...park(), flags: 0x0008 })).toThrow(/reserved bit/);
  });

  it("more slotted widgets than the VM has slots", () => {
    const nine = new Array(9).fill(0).map((_, i) => obj({ id: `o${i}` }));
    expect(() => screen(nine)).toThrow(/8 slots/);
  });

  it("⛔ ON RAW for a code the hook can never deliver — it would install and never fire", () => {
    // ffs_hook switches on the LVGL code and returns before the ON walk for anything outside the
    // five named ones, because ffs_prog.h §4 point 3 requires the 0x1A/0x1F/0x20/0x21 draw storm
    // to cost "two compares and a return". A raw handler for 0x42 used to assemble, report itself
    // installed in ret= bits 18..19, and never fire — on the HUD indistinguishable from "the
    // gesture does not exist on this hardware".
    expect(() => screen([obj({ id: "b" })],
      { on: { raw: [{ code: 0x42, do: notify(1) }] } })).toThrow(/CAN NEVER FIRE/);
    expect(() => screen([obj({ id: "b" })],
      { on: { raw: [{ code: 0x42, do: notify(1) }] } })).toThrow(/draw storm/i);
    // The five that CAN fire still assemble — RAW is a redundant spelling of the named classes.
    for (const code of [0x0a, 0x48, 0x44, 0x45, 0x4a]) {
      expect(() => screen([obj({ id: "b" })], { on: { raw: [{ code, do: notify(1) }] } })).not.toThrow();
    }
  });

  it("⛔ FLAG on=0 — lv_obj_remove_flag 0x0043dfa5 is DERIVED, never executed", () => {
    // Cardinal rule 1: proven on-glass, per capability, or it does not ship. FLAG is on the
    // handler allowlist, so on=0 would put an unproven address on the display thread on a real
    // temple tap. Refused, not no-op'd — a no-op reads as "remove_flag does nothing here".
    expect(() => Op.flag(0, 1, 0)).toThrow(/0x0043dfa5/);
    expect(() => Op.flag(0, 1, 0)).toThrow(/MAPPED IS NOT PROVEN/);
    expect(() => Op.flag(0, 1, varRef(0))).toThrow(/cannot be var-bound/);
    expect(() => Op.flag(0, 1, 1)).not.toThrow();
  });

  it("⛔ STYLE with a POINTER-typed prop — an i32 off the wire becomes a pointer the renderer chases", () => {
    // TEXT_FONT(90) is an lv_font_t*. lv_style_set_prop's value is a union, so this plants a
    // garbage pointer dereferenced on the next draw tick — the exact failure ffs_widget_style.h
    // exists to prevent, with no UNSAFE flag anywhere near it.
    expect(() => Op.style(0, 90, 0xdeadbeef | 0)).toThrow(/POINTER-TYPED/);
    expect(() => Op.style(0, 40, 0)).toThrow(/BG_IMAGE_SRC/);
    expect(() => Op.style(0, 130, 0)).toThrow(/GRID_COLUMN_DSC_ARRAY/);
    expect(() => Op.style(0, 138, 0)).toThrow(/out of range 0\.\.137/);
    expect(() => Op.style(0, STYLE_PROP.BG_OPA, 0)).not.toThrow();
  });

  it("⛔ STYLE inside a handler — an input-driven malloc with no free", () => {
    // ★ THIS IS THE CONTRACT NOW, NOT A LOCAL NARROWING. STYLE was on
    // FFSP_OP_ALLOWED_IN_HANDLER and was dropped from it on 2026-08-11; the header calls it "the
    // one entry whose absence must never be 'fixed'". The refusal used to be an encoder-side belt
    // over a frozen header that still allowed it, which is exactly the kind of deviation that
    // desyncs three implementations.
    expect(() => screen([obj({ id: "b" })],
      { on: { tap: inlineOp(Op.style(0, STYLE_PROP.BG_OPA, 0)) } })).toThrow(/forbidden inside a handler/);
    expect(() => screen([obj({ id: "b" })],
      { on: { tap: inlineOp(Op.style(0, STYLE_PROP.BG_OPA, 0)) } })).toThrow(/per swipe FOREVER/);
  });

  it("EMIT refuses what the interpreter would silently MANGLE rather than refuse", () => {
    // ffs_prog.c does `if (shift + width > 24) width = 24 - shift;` and masks every arg into its
    // own index space. Each of these used to encode fine here and return a plausible WRONG number.
    expect(() => Op.emit(4, 20, 0, 8)).toThrow(/indexes the 16-entry event ring/);  // arg & 15 -> event 4
    expect(() => Op.emit(1, 9, 0, 4)).toThrow(/indexes a SLOT/);
    expect(() => Op.emit(0, 16, 0, 4)).toThrow(/indexes var\[\]/);
    expect(() => Op.emit(3, 0, 20, 8)).toThrow(/past bit 23/);
    expect(() => Op.emit(3, 0, 0, 25)).toThrow(/out of range 1\.\.24/);
    expect(() => Op.emit(4, 0xff, 12, 8)).not.toThrow();   // 0xFF is FFSP_EVT_LAST, not an index
  });

  it("range-checks the operands patch_prog.py has always range-checked", () => {
    expect(() => Op.ifOp(OP.LONGPRESS, 5)).toThrow(/0x45 is reserved/);
    expect(() => Op.ifOp(0x69, 5)).toThrow(/not an allocated opcode/);
    expect(() => Op.parent(3)).toThrow(/out of range 0\.\.2/);
    expect(() => Op.wfCreate(5, 0, new Uint8Array(0))).toThrow(/out of range 1\.\.4/);
    // ⚠️ vtable slot 0 is create(parent, x, cfg) — it takes a POINTER, and WFCALL carries only i32.
    expect(() => Op.wfCall(1, 0, 0, 0, 0, 0)).toThrow(/takes a POINTER/);
    expect(() => Op.wfCall(1, 15, 0, 0, 0, 0)).toThrow(/out of range 1\.\.14/);
    expect(() => Op.on(0, DEV.ANY, 0, 0, 0)).toThrow(/divide-by-zero/);
    expect(() => Op.add(0, 1, 10, 2, 0)).toThrow(/the list is stuck/);
    expect(() => Op.showSys(0)).toThrow(/not a page/);
    expect(() => Op.pdesc(0, 0, 0)).toThrow(/not a page/);
    // §8 region bounds — a region-bounded write is the whole reason WRITE is not a raw POKE.
    expect(() => Op.write(2, 0x1a, 4, 0)).toThrow(/runs past the region's 28 B/);
    expect(() => Op.read(0, 3, 0x16, 4)).toThrow(/runs past the region's 24 B/);
    // ★ ffs_prog.h renamed TEXT's `font`->`align` (LV_STYLE_TEXT_ALIGN) and WIDENED the range to
    // 0..3 (0 AUTO, 1 LEFT, 2 CENTER, 3 RIGHT) on 2026-08-13. The old 0..1 bound cited "two fonts"
    // — true of fonts, irrelevant to this byte — and it refused centred titles. 4 is now the first
    // illegal value; 2 (CENTER) and 3 (RIGHT) are legal. The wire byte is unchanged; only the name
    // and the legal range moved. (`font` stays accepted as the pre-rename spelling of the byte.)
    expect(() => text({ x: 0, y: 0, w: 1, h: 1, text: "x", font: 4 })).toThrow(/out of range 0\.\.3/);
    expect(() => text({ x: 0, y: 0, w: 1, h: 1, text: "x", align: 2 })).not.toThrow();
    expect(() => text({ x: 0, y: 0, w: 1, h: 1, text: "x", align: 3 })).not.toThrow();
  });

  it("★ text() and list() default `pad` to the header's FFSP_DEF_* — 6 and 8, not one number", () => {
    // ⚠️ Not caught by any program golden, because both slice1 demos pass pad explicitly: it would
    // first surface as a diff against a photograph taken from the other tool's push. This file used
    // to default BOTH to 8 while patch_prog.py emitted 6 for text. They are ffs_prog.h §7 data now
    // (FFSP_DEF_PAD_TEXT / FFSP_DEF_PAD_LIST), mirrored rather than agreed.
    // dst:u8 x,y,w,h:i16 bw bc rad **pad** — `pad` is arg byte 12 (0-based) of both opcodes.
    const t = text({ x: 40, y: 18, w: 496, h: 46, text: "A" }).build(0);
    const l = list({ x: 40, y: 78, w: 496, h: 150, items: ["a"] }).build(1);
    expect([FFSP_DEF_PAD_TEXT, FFSP_DEF_PAD_LIST]).toEqual([6, 8]);
    expect(t.args[12]).toBe(FFSP_DEF_PAD_TEXT);
    expect(l.args[12]).toBe(FFSP_DEF_PAD_LIST);
    // border 2 / borderColor 15 / radius 10 agree in both encoders and in both widgets.
    expect([t.args[9], t.args[10], t.args[11]]).toEqual([2, 15, 10]);
    expect([l.args[9], l.args[10], l.args[11]]).toEqual([2, 15, 10]);
    // …and font 1 is FFSP_DEF_FONT, "what Even's own filler always writes".
    expect(t.args[13]).toBe(1);
  });

  it("mirrors the header's numbers rather than keeping a second definition of them", () => {
    // Each of these was a local derivation in this file until ffs_prog.h named it. The value did
    // not change — its PROVENANCE did, which is the whole point: two tools deriving the same bound
    // separately is how bounds silently diverge.
    expect(FFSP_STYLE_PROP_MAX).toBe(137);                 // §7 FFSP_STYLE_PROP_MAX
    expect(() => Op.style(0, FFSP_STYLE_PROP_MAX, 0)).not.toThrow();
    expect(() => Op.style(0, FFSP_STYLE_PROP_MAX + 1, 0)).toThrow(/out of range 0\.\.137/);
    // §7 geometry: clamped WIDER than the 576x288 panel, because sliding a widget fully off-screen
    // and back is a legitimate transition. ⚠️ It is a RUNTIME clamp on an int32 var, so it is
    // mirrored for the author to reason with and NOT enforced on a literal here.
    expect([FFSP_GEO_MIN, FFSP_GEO_MAX]).toEqual([-576, 1152]);
    // §8 FFSP_RGN_LEN_*: all four are header data now; the first cut gave only LAYOUT_CFG's.
    expect(() => Op.write(0, 0xb0 - 1, 2, 0)).toThrow(/runs past the region's 176 B/);
    expect(() => Op.write(1, 0x80 - 1, 2, 0)).toThrow(/runs past the region's 128 B/);
    expect(() => Op.write(2, 0x1c - 1, 2, 0)).toThrow(/runs past the region's 28 B/);
    expect(() => Op.write(3, 0x18 - 1, 2, 0)).toThrow(/runs past the region's 24 B/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// VARIABLES — resident across pushes, which is exactly what makes them dangerous
// ══════════════════════════════════════════════════════════════════════════════════════

describe("variables", () => {
  it("assigns indices from names in first-use order and reports the map", () => {
    const p = screen([list({ id: "m", x: 0, y: 0, w: 1, h: 1, items: ["a"] })], {
      on: { tap: [set("sel", 3), add("page", 1, { lo: 0, hi: 4, wrap: true })] },
    });
    expect(p.vars).toEqual({ sel: 0, page: 1 });
  });

  it("pins notify() to var 15, because vm->var[] survives every push", () => {
    // ⚠️ A CONVENTION program.ts invents — the header defines no NOTIFY opcode and no reserved
    // var — pinned so two independently-authored programs cannot read each other's garbage.
    const p = screen([], { on: { tap: [set("a", 1), notify(2)] } });
    expect(p.vars).toEqual({ a: 0 });
    expect(NOTIFY_VAR).toBe(15);
    const a = assemble(p);
    expect(hex(a.code.subarray(a.drawEnd)).endsWith("030300" + "0f" + "0200")).toBe(true);
  });

  it("honours a pinned var map, so a readback push and its screen agree", () => {
    const p = screen([], { vars: { sel: 4 }, on: { tap: set("sel", 1) } });
    expect(p.vars).toEqual({ sel: 4 });
    const a = assemble(p);
    expect(hex(a.code.subarray(a.drawEnd)).endsWith("030300" + "04" + "0100")).toBe(true);
  });

  it("binds a geometry field to a live variable via the vmask", () => {
    const p = screen([obj({ id: "box" })], { on: { tap: move("box", varRef("x"), 0) } });
    const a = assemble(p);
    // MOVE slot=0, x=var[0], y=0 -> vmask bit 1
    expect(hex(a.code.subarray(a.drawEnd)).endsWith("120502" + "00" + "0000" + "0000")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// ★ set() PICKS THE OPCODE — LOAD for a firmware reading, SET for an immediate
// ══════════════════════════════════════════════════════════════════════════════════════

describe("set() — one surface, two encodings", () => {
  /** The handler stream of a one-list screen, hex. */
  const handlerOf = (p: ReturnType<typeof screen>) => {
    const a = assemble(p);
    return hex(a.code.subarray(a.drawEnd));
  };
  const one = () => list({ id: "menu", x: 0, y: 0, w: 10, h: 10, items: ["a"] });

  it("set(name, listFocus(id)) lowers to LOAD — the author never types the opcode", () => {
    // LOAD var0(sel) <- src=LISTFOCUS(1), arg=slot 0 (the list is the only widget).
    const h = handlerOf(screen([one()], { on: { tap: set("sel", listFocus("menu")) } }));
    expect(h.endsWith("070300" + "00" + "01" + "00")).toBe(true);
    expect(h.includes("030300")).toBe(false);   // no SET anywhere: this is not an immediate
  });

  it("set(name, 42) still lowers to SET — same call, different encoding", () => {
    const h = handlerOf(screen([one()], { on: { tap: set("sel", 42) } }));
    expect(h.endsWith("030300" + "00" + "2a00")).toBe(true);
    expect(h.includes("070300")).toBe(false);
  });

  it("★ design §4(c) works AS WRITTEN: [ set(\"sel\", listFocus(\"menu\")), notify(1) ]", () => {
    // This is the line the design has shown since the beginning and the compiler could not compile:
    // SET takes an immediate, so nothing moved a firmware reading into var[] and no screen could
    // remember what the user selected. Now it lowers to LOAD + SET, in the author's order.
    const h = handlerOf(screen([one()], {
      on: { tap: [set("sel", listFocus("menu")), notify(1)] },
    }));
    expect(h).toBe(
      "430600" + "00" + "ff" + "01" + "00" + "0c00" +   // ON TAP, block_len = 12 (two 6 B ins)
      "070300" + "00" + "01" + "00" +                   //   LOAD var0 <- LISTFOCUS(slot 0)
      "030300" + "0f" + "0100",                         //   SET  var15 (notify) = 1
    );
  });

  it("lowers every other Source the same way, because LOAD reads EMIT's whole enum", () => {
    // listCount names a SLOT, evtCode carries an INDEX (0xFF = the last event) — one arg space per
    // source, resolved once and shared with readback()'s EMIT.
    expect(handlerOf(screen([one()], { on: { tap: set("n", listCount("menu")) } }))
      .endsWith("070300" + "00" + "02" + "00")).toBe(true);
    expect(handlerOf(screen([one()], { on: { tap: set("code", evtCode()) } }))
      .endsWith("070300" + "00" + "04" + "ff")).toBe(true);
  });

  it("resolves the destination name through the same var map as SET", () => {
    const p = screen([one()], {
      vars: { sel: 4 }, on: { tap: [set("sel", listFocus("menu")), set("other", 1)] },
    });
    expect(p.vars).toEqual({ sel: 4, other: 0 });
    expect(handlerOf(p)).toContain("070300" + "04" + "01" + "00");
  });

  it("notify() writes FFSP_NOTIFY_VAR — header data now, not a convention two encoders share", () => {
    expect(NOTIFY_VAR).toBe(FFSP_NOTIFY_VAR);
    expect(FFSP_NOTIFY_VAR).toBe(15);
    // ⚠️ patch_prog.py wrote its slice1 marker to var 0 while this file read var 15, so a handler
    // that RAN was reported as "the handler did not run". Both now cite ffs_prog.h §2.
    expect(handlerOf(screen([one()], { on: { tap: notify(2) } })))
      .toContain("030300" + "0f" + "0200");
  });

  it("keeps LOAD out of nothing — it is on the header's handler allowlist", () => {
    expect(() => screen([one()], { on: { tap: inlineOp(Op.load(0, EMIT_SRC.LISTFOCUS, 0)) } }))
      .not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// KEEP / page selection
// ══════════════════════════════════════════════════════════════════════════════════════

describe("pages and KEEP", () => {
  it("page: \"base\" is Route B — layer 0, visible_default=1, the launcher slot", () => {
    const a = assemble(screen([], { page: "base" }));
    expect(hex(a.code)).toBe(
      "060100" + "01" +
      "400500" + "01" + "64" + "7800" + "ff" +   // PAGE which = BASE
      "100100" + "02" +                          // PARENT base root
      "140600" + "fe" + "1d" + "00000000" +
      "110000" +
      "410100" + "01" +                          // SHOW base
      "000000",
    );
  });

  it("keep: true drops the CLEAR and sets FFSP_FLAG_KEEP", () => {
    const a = assemble(screen([], { keep: true }));
    expect(a.flags).toBe(FFSP_FLAG.KEEP);
    expect(hex(a.code).includes("110000")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// CROSS-CHECK against the Python assembler's goldens, when it has produced them
// ══════════════════════════════════════════════════════════════════════════════════════

// ⚠️ ★ THIS IS THE ONLY MECHANICAL CHECK THAT TWO OF THE THREE IMPLEMENTATIONS AGREE, and it was
// a NO-OP until 2026-08-11. It looked up `doc[k]` for the keys "end"/"clear"/"slice1"/"park"/"echo"
// at the TOP LEVEL of the goldens JSON, whose real shape is
//     { opcodes: { END: {hex}, … }, programs: { slice1: {code_hex, header_hex, …}, … } }
// so EVERY lookup returned `undefined`, hit `if (t === undefined) continue;`, and the test asserted
// an always-empty array: 1 pass, 1 expect() call, ZERO bytes compared. It sat green while slice1
// genuinely disagreed on code_len (138 vs 141), draw_end (95 vs 98) and crc (0xDE78 vs 0x4AAD) —
// and that defect is WHY four program-level drifts survived (the trailing END, the notify var
// index, the KEEP flag on readback/echo, and the echo's distinctive length).
//
// ⛔ THE MISSING-KEY POLICY IS NOW INVERTED. A name present in the Python goldens with no TS
// counterpart FAILS. Silently skipping is what made the original defect invisible; if the Python
// tool grows a vector, this test must go red until someone builds the TypeScript side of it.
//
// ⚠️ AND THE POINT IS TO FAIL LOUDLY, NOT TO SYNCHRONISE. If the two disagree, one of them is
// wrong about the header and the drift is resolved THERE — never by editing a golden to match.

/** One TS-built instruction per Python `OPCODE_VECTORS` entry, with the SAME operands. */
const OPCODE_VECTORS_TS: Readonly<Record<string, () => Uint8Array>> = {
  END: () => insBytes(Op.end()),
  IFOP: () => insBytes(Op.ifOp(OP.LISTEV, 5)),
  IFVAR: () => insBytes(Op.ifVar(2, 3, -3, 9)),
  // ★ The vmask row that pinned §3's old `imm:i16[V1]` annotation against §2's declared-order rule
  // and WON: declared order is (var, cmp, imm, skip), so `imm` is slot 2 and vmask is 0x04, and the
  // header now reads [V2]. All three implementations chose bit 2 independently; this vector stays
  // so that agreement cannot quietly be re-litigated back into a disagreement.
  IFVAR_VARBOUND: () => insBytes(Op.ifVar(2, 0, varRef(7), 9)),
  SET: () => insBytes(Op.set(0, 1)),
  SET_VARBOUND: () => insBytes(Op.set(0, varRef(5))),
  ADD: () => insBytes(Op.add(1, 1, 0, 4, 1)),
  EMIT: () => insBytes(Op.emit(8, 0, 0, 16)),
  // ★ 0x07 LOAD — slice1's TAP handler, as an instruction: var15 <- LISTFOCUS(slot 1).
  LOAD: () => insBytes(Op.load(NOTIFY_VAR, EMIT_SRC.LISTFOCUS, 1)),
  // ⚠️ LOAD's `arg` is operand slot 2 (var, src, arg) while EMIT's identically-named `arg` is
  // slot 1 (src, arg, shift, width): 0x04 here, 0x02 there. Same enum, same per-source arg spaces,
  // DIFFERENT operand order — the near-miss a shared source reader invites.
  LOAD_VARBOUND: () => insBytes(Op.load(0, EMIT_SRC.LISTFOCUS, varRef(3))),
  NEED: () => insBytes(Op.need(NEED.PAGEMGR)),
  PARENT: () => insBytes(Op.parent(1)),
  CLEAR: () => insBytes(Op.clear()),
  MOVE: () => insBytes(Op.move(1, 40, -8)),
  SIZE: () => insBytes(Op.size(1, 496, 150)),
  STYLE: () => insBytes(Op.style(FFSP_SLOT_PARENT, STYLE_PROP.BG_OPA, 0)),
  FLAG: () => insBytes(Op.flag(0, 1, 1)),
  TEXT: () => insBytes(Op.text({
    dst: 0, x: 40, y: 18, w: 496, h: 46, bw: 2, bc: 15, rad: 10, pad: 6, font: 1,
    str: new TextEncoder().encode("FFS OS\0"),
  })),
  LIST: () => insBytes(Op.list({
    dst: 1, x: 40, y: 78, w: 496, h: 150, bw: 2, bc: 15, rad: 10, pad: 8, n: 3,
    items: new TextEncoder().encode("CLOCK\0CAMERA\0SETTINGS\0"),
  })),
  OBJ: () => insBytes(Op.obj(2)),
  BOUNCE: () => insBytes(Op.bounce(1, 78, 0)),
  // ── newgfx family (0x24–0x27). These four HAD no emitter here (the comment on OP said so) and so
  // had no cross-check vector, which is exactly the drift the missing-key policy now fails on: the
  // Python golden carried FONT/IMAGE/INK/ANIM and this map did not. Each is built with the SAME
  // operands as its ffsp_goldens.json entry so the byte comparison is meaningful.
  FONT: () => insBytes(Op.font(0, 0)),
  FONT_CLOCK: () => insBytes(Op.font(1, 5)),
  IMAGE: () => insBytes(Op.image({ dst: 3, x: 40, y: 60, w: 288, h: 144, bw: 2, bc: 15, rad: 10 })),
  INK: () => insBytes(Op.ink({ slot: 3, prim: 1, a: 4, b: 4, c: 60, d: 40, w: 2, lvl: 15 })),
  "INK.RING": () => insBytes(Op.ink({ slot: 1, prim: 3, a: 44, b: 44, c: 36, w: 1, lvl: 12 })),
  "INK.TRI": () => insBytes(Op.ink({ slot: 2, prim: 5, a: -8, b: -8, c: 8, d: -8, e: 0, f: 12, lvl: 15 })),
  ANIM: () => insBytes(Op.anim({
    slot: 1, x0: -496, x1: 40, y0: 78, y1: 78, w0: 496, w1: 496, h0: 150, h1: 150,
    durMs: 300, delayMs: 0,
  })),
  // ⚠️ x0 and y1 var-bound: [V3] and [V6], so vmask 0x48 and the var index rides in the field bytes.
  ANIM_VARBOUND: () => insBytes(Op.anim({
    slot: 1, x0: varRef(0), x1: 40, y0: 78, y1: varRef(6), w0: 496, w1: 496, h0: 150, h1: 150,
    durMs: 300, delayMs: 0,
  })),
  // ★ 0x28 GIF — native frame cycling over three IMAGE slots, ping-pong at 100 ms/frame. This is
  // the ONE newgfx-family opcode this port authors (FONT/IMAGE/ANIM/INK have no emitter here yet),
  // so it is the one whose bytes the cross-check can actually pin against the Python golden.
  GIF: () => insBytes(Op.gif(4, [1, 2, 3], 100, GIF_MODE.PINGPONG)),
  // ⚠️ 7 bytes, NOT bigClock()'s 8: the Python vector's cfg_hex is "01000000000104".
  WFCREATE: () => insBytes(Op.wfCreate(1, 40, Uint8Array.from([1, 0, 0, 0, 0, 1, 4]))),
  WFCALL: () => insBytes(Op.wfCall(1, 3, 0, 20, 17, 1)),
  DASH: () => insBytes(Op.dash({
    basePos: 2, wcount: 5, order: [0, 1, 2, 4, 3], wfKind: 1,
    wfA: 0, wfB: 1, wfC: 4, wfN: 0, wfItems: 0,
  })),
  LISTEV: () => insBytes(Op.listEv(1, 0)),
  PAGE: () => insBytes(Op.page(WHICH.OVERLAY, 100, 120, 255)),
  SHOW: () => insBytes(Op.show(WHICH.OVERLAY)),
  HIDE: () => insBytes(Op.hide(WHICH.OVERLAY)),
  PDESC: () => insBytes(Op.pdesc(3, 0x0c, 400)),
  SHOWSYS: () => insBytes(Op.showSys(1)),
  CALL: () => insBytes(Op.call(0x004e2ded, 0, 0, 0, 0)),
  WRITE: () => insBytes(Op.write(1, 0, 1, 2)),
  READ: () => insBytes(Op.read(3, 3, 0, 4)),
  // ★ An interpreter that cannot execute a REQUIRED instruction must ABORT, not skip it.
  CLEAR_REQUIRED: () => insBytes(required(Op.clear())),
};

// ══════════════════════════════════════════════════════════════════════════════════════
// ⚠️ THESE THREE TESTS ARE LOCAL-ONLY, AND THAT IS A REAL GAP — SAY IT, DO NOT IMPLY
// PROTECTION THAT DOES NOT EXIST.
//
// They read an artifact from the PRIVATE `g2flash` repo, a sibling checkout of this one.
// `ffs_os` is public and its CI (.github/workflows/android-checks.yml) runs `bun install`,
// `npx tsc --noEmit` and the Kotlin unit tests — NOT `bun test`. So nothing in CI checks
// this encoder against the assembler; it is checked when a human runs `bun test src/sdk`
// on a box that has both repos. Every other guarantee here is real; this one is
// conditional, and pretending otherwise is worse than the gap.
//
// The absent-file case THROWS rather than skipping. A skip would be a green test that
// checks nothing — which is the exact bug this block had in its first version, where it
// compared zero bytes and passed unconditionally.
// ══════════════════════════════════════════════════════════════════════════════════════
describe("cross-check vs g2flash/tools/ffsp_goldens.json", () => {
  const path = `${import.meta.dir}/../../../../g2flash/tools/ffsp_goldens.json`;
  const GOLDENS_MISSING =
    `${path} does not exist.\n` +
    `These tests need the PRIVATE g2flash repo checked out as a sibling of ffs_os, and the ` +
    `goldens generated there with \`python tools/patch_prog.py --goldens\`.\n` +
    `⛔ Do NOT "fix" this by skipping: CRC-16 cannot catch assembler/interpreter drift ` +
    `(the same tool computes both sides), so these byte vectors are the only thing that can.`;

  it("agrees with the assembler on every per-opcode byte vector", async () => {
    const f = Bun.file(path);
    if (!(await f.exists())) throw new Error(GOLDENS_MISSING);
    const doc = await f.json() as {
      opcodes: Record<string, { hex: string | null; refused?: boolean }>;
    };

    const disagreements: string[] = [];
    for (const [name, entry] of Object.entries(doc.opcodes)) {
      if (entry.refused) {
        // ⛔ LONGPRESS has NO bytes and must never have any. `hex: null` in the goldens means
        // "every implementation MUST throw here"; a silent no-op would read on the HUD as "long
        // press does nothing on this hardware", a different and wrong conclusion.
        expect(() => Op.longPress()).toThrow();
        continue;
      }
      const build = OPCODE_VECTORS_TS[name];
      if (build === undefined) {
        disagreements.push(`${name}: present in the Python goldens, NO TypeScript vector — add one`);
        continue;
      }
      const ts = hex(build());
      if (entry.hex !== ts) disagreements.push(`${name}: python=${entry.hex} ts=${ts}`);
    }
    expect(disagreements).toEqual([]);
  });

  // ⛔ THE ONE THING BYTE VECTORS CANNOT COVER. A REFUSED prop produces no bytes, so if this
  // encoder started accepting a pointer-typed prop the other refuses, every opcode vector and
  // every program golden would still be green. `ffs_prog.h` §7 owns the set;
  // `patch_prog.py` parses it out of the header and republishes it here; this pins the third
  // implementation to the same source. Without this the set agreed only by luck.
  it("agrees with the contract on which style props are pointer-typed", async () => {
    const f = Bun.file(path);
    if (!(await f.exists())) throw new Error(GOLDENS_MISSING);
    const doc = await f.json() as { style_ptr_props: number[]; style_prop_max: number };

    expect(doc.style_ptr_props).toBeDefined();
    expect(Object.keys(STYLE_PTR_PROPS).map(Number).sort((a, b) => a - b))
      .toEqual([...doc.style_ptr_props].sort((a, b) => a - b));
    expect(FFSP_STYLE_PROP_MAX).toBe(doc.style_prop_max);

    // and they are actually refused, not merely listed
    for (const p of doc.style_ptr_props) {
      expect(() => Op.style(0, p, 0x20001234)).toThrow(/POINTER-TYPED/);
    }
    expect(() => Op.style(0, doc.style_prop_max + 1, 0)).toThrow();
  });

  it("agrees with the assembler on every whole-program golden, header included", async () => {
    const f = Bun.file(path);
    if (!(await f.exists())) throw new Error(GOLDENS_MISSING);
    const doc = await f.json() as {
      programs: Record<string, {
        code_hex: string; code_len: number; draw_end: number;
        code_crc: string; flags: string; header_hex: string;
      }>;
    };

    // The four §6 programs, built the way §4 says a developer types them. `readback` names the
    // same slot map slice1 produced, exactly as a real Push B would.
    const ours: Record<string, ReturnType<typeof assemble>> = {
      slice1: assemble(SLICE1),
      readback: assemble(readback(
        [field(listFocus("menu"), 0, 4), field(evtCount(), 4, 8),
          field(evtCode(), 12, 8), field(evtDev(), 20, 4)],
        { slots: assemble(SLICE1).slots },
      )),
      park: assemble(park()),
      echo: assemble(echoProgram()),
    };

    const disagreements: string[] = [];
    for (const [name, want] of Object.entries(doc.programs)) {
      const got = ours[name];
      if (got === undefined) {
        disagreements.push(`${name}: present in the Python goldens, NO TypeScript program — add one`);
        continue;
      }
      const mine = {
        code_hex: hex(got.code),
        code_len: got.codeLen,
        draw_end: got.drawEnd,
        code_crc: `0x${got.crc.toString(16).toUpperCase().padStart(4, "0")}`,
        flags: `0x${got.flags.toString(16).toUpperCase().padStart(4, "0")}`,
        header_hex: hex(got.header),
      };
      for (const k of ["code_hex", "code_len", "draw_end", "code_crc", "flags", "header_hex"] as const) {
        if (mine[k] !== want[k]) disagreements.push(`${name}.${k}: python=${want[k]} ts=${mine[k]}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("agrees on the CRC-16 vectors and the header constants", async () => {
    const f = Bun.file(path);
    const doc = await f.json() as {
      abi: number; symgen: number; fw_build: number; prog_cap: number; hdr_size: number;
      crc16_vectors: Record<string, { input_hex: string; crc16: string }>;
    };
    expect(doc.abi).toBe(FFSP_ABI);
    expect(doc.symgen).toBe(FFSP_SYMGEN);
    expect(doc.fw_build).toBe(FFSP_FW_BUILD);
    expect(doc.hdr_size).toBe(FFSP_HDR_SIZE);
    for (const [name, v] of Object.entries(doc.crc16_vectors)) {
      const input = Uint8Array.from(
        (v.input_hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
      const got = `0x${crc16(input).toString(16).toUpperCase().padStart(4, "0")}`;
      expect(`${name}=${got}`).toBe(`${name}=${v.crc16}`);
    }
  });
});
