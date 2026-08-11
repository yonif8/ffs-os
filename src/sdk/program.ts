// program.ts — the FFSP lowering compiler. What a developer actually types.
//
// ★ THE OPCODE STREAM IS A COMPILE TARGET, NOT AN AUTHORING SURFACE.
// `screen([...])` / `dashboard({...})` / `park()` are the surface; the instruction stream in
// `g2flash/patches/ffs_prog.h` §3 is what comes out. Nobody types a slot number, a vmask bit, a
// `draw_end`, a CRC, or the fact that LISTEV UP=1 *decrements*.
//
// ══ THE CONTRACT ══════════════════════════════════════════════════════════════════════
// `g2flash/patches/ffs_prog.h` is normative for every byte here. It is FROZEN, and it was AMENDED
// ONCE (2026-08-11) after the first build of all three implementations: `0x07 LOAD` was added,
// `STYLE` was dropped from the handler allowlist, IFVAR's `imm` annotation was corrected to [V2],
// and constants the encoders had each derived locally (FFSP_NOTIFY_VAR, the FFSP_DEF_* box,
// FFSP_GEO_*, FFSP_STYLE_PROP_MAX, FFSP_RGN_LEN_*) became header data. ⛔ Amendments come from the
// header, never from here: this file mirrors and reports, it does not narrow or extend. Three
// implementations must agree:
//     g2flash/payloads/ffs_prog.c   the interpreter + the input hook   (on-glass)
//     g2flash/tools/patch_prog.py   the assembler + patcher + framer   (the dev box)
//     THIS FILE                     the lowering compiler              (the phone)
// A drift between any two is INVISIBLE — CRC-16 cannot catch it, because the same tool computes
// both sides of the CRC. Only per-opcode byte goldens catch it, and they are in
// `__tests__/program.test.ts`, written from the header table by hand, BEFORE trusting an opcode.
// That is a rule, not a suggestion (design §7 item 8).
//
// ══ WHY A PROGRAM AND NOT A DESCRIPTOR ════════════════════════════════════════════════
// v1 (`templates.ts`: FFSD, FSDB) is a struct. A struct can describe a screen and can never
// describe a REACTION — there is no field for "when the temple is tapped, move the list focus",
// and there never can be, because the behaviour is code. FFSP is an instruction stream, so a
// handler is just more bytes, and the hook that runs those bytes is compiled into the SAME BLOB
// as the program it reads.
//
// ⚠️ v1 IS UNTOUCHED AND STAYS GREEN. `templates.ts` and its goldens are not modified by this
// file; the only thing imported from it is `validateDashConfig`, because the dashboard limits are
// a FIRMWARE rule and two copies of a firmware rule is exactly the drift this codebase hates.
//
// Pure logic on purpose: no react-native import, so `bun test src/sdk` checks every byte with no
// glasses attached.

import { patchTemplate, validateDashConfig, type DashConfig } from "./templates";
import type { PayloadTemplate } from "./templates.generated";

// ══════════════════════════════════════════════════════════════════════════════════════
// 1. THE CONTRACT, MIRRORED
//    Every constant below is a transcription of ffs_prog.h. Nothing here may be "improved".
// ══════════════════════════════════════════════════════════════════════════════════════

/** "FFSP" LE — deliberately distinct from FFSD (0x44534646) and FSDB (0x42445346), so a stale
 *  v1 template cannot be patched by this compiler and vice versa. */
export const FFSP_MAGIC = 0x50534646;
/** The interpreter REFUSES a program with abi > its own. */
export const FFSP_ABI = 1;
/** Bumped when a symbolic id's MEANING changes — NOT when an address moves (that is fw_build). */
export const FFSP_SYMGEN = 1;
/** g2_2.2.7.14.bin. There is no other target. */
export const FFSP_FW_BUILD = 22714;
/** Bytes of code[] the hole can hold. Measured: the whole blob lands ~4.5 KB against the
 *  loader's 8192 B cap, so this is affordable, not aspirational. */
export const FFSP_PROG_CAP = 2048;
export const FFSP_HDR_SIZE = 0x10;
export const FFSP_PROG_SIZE = FFSP_HDR_SIZE + FFSP_PROG_CAP; // 2064 B

/** flags — ⛔ bits 3..15 MUST BE ZERO; a non-zero one is a HARD REFUSAL (status = MAGIC), not a
 *  warning. Those two comparisons are the entire forward-extension story for the header. */
export const FFSP_FLAG = {
  /** do not implicitly CLEAR: adopt the slots a previous push left resident */
  KEEP: 0x0001,
  /** unlock CALL/WRITE/READ — also needs an EXACT fw_build match; refused otherwise with DATUM */
  UNSAFE: 0x0002,
  /** report under tag 0x7F, and the WHOLE 24 bits are EMIT data with no status bits */
  READBACK: 0x0004,
  RESERVED: 0xfff8,
} as const;

/** On the op byte: an interpreter that cannot execute this instruction must ABORT, not skip it. */
export const FFSP_OP_REQUIRED = 0x80;
export const FFSP_OP_MASK = 0x7f;

export const OP = {
  END: 0x00, IFOP: 0x01, IFVAR: 0x02, SET: 0x03, ADD: 0x04, EMIT: 0x05, NEED: 0x06,
  /** ★ ADDED TO THE HEADER 2026-08-11, because slice 1 could not express its own spec. Design §6
   *  asks a TAP handler for `SET var0 <- listFocus(1)` and SET takes an IMMEDIATE, so nothing
   *  could move a firmware reading into `var[]` — and `var[16]`, "the OS's entire mutable state",
   *  is worth nothing if the OS can only ever put constants in it. LOAD is EMIT's source enum
   *  pointed at a variable instead of the result mask. */
  LOAD: 0x07,
  PARENT: 0x10, CLEAR: 0x11, MOVE: 0x12, SIZE: 0x13, STYLE: 0x14, FLAG: 0x15,
  TEXT: 0x20, LIST: 0x21, OBJ: 0x22, BOUNCE: 0x23,
  WFCREATE: 0x30, WFCALL: 0x31, DASH: 0x32, LISTEV: 0x33,
  PAGE: 0x40, SHOW: 0x41, HIDE: 0x42, ON: 0x43, PDESC: 0x44,
  /** ⛔ 0x45 LONGPRESS IS RESERVED AND PERMANENTLY UNUSABLE — see `longPress()`. */
  LONGPRESS: 0x45,
  SHOWSYS: 0x46,
  CALL: 0x70, WRITE: 0x71, READ: 0x72,
} as const;

/** Every id §3's table allocates, LONGPRESS included — `IFOP` asks about membership of this set,
 *  so an id outside it is a question with a permanent answer and a dead guarded block. */
const ALLOCATED_OPS: ReadonlySet<number> = new Set<number>(Object.values(OP));

/** ⛔ Shared by `longPress()` and `Op.ifOp()`: one reason, quoted at both doors. */
const LONGPRESS_REASON =
  "opcode 0x45 is reserved and permanently unusable. Long press is intercepted ABOVE the page hook " +
  "(measured — after a long press the hook stops receiving input codes entirely and the active page " +
  "belongs to Even's menu), so NO page hook will ever see it. It becomes live only after the 4-byte " +
  "patch at 0x00442e70, which needs a flash; old interpreters then skip the block harmlessly. " +
  "Refusing rather than emitting a no-op, because a no-op would read as 'long press does nothing on " +
  "this hardware'.";

export const FFSP_MAX_VARS = 16;
export const FFSP_MAX_SLOTS = 8;
export const FFSP_VAR_MASK = 0x0f;

/**
 * ★ THE PHONE-VISIBLE NOTIFY SLOT — `FFSP_NOTIFY_VAR`, and it is HEADER DATA now, not a convention
 * two encoders happen to share.
 *
 * A handler writes it, the next readback EMITs it. It is pinned (rather than allocated in first-use
 * order) because `vm->var[]` is RESIDENT ACROSS PUSHES, so two independently-authored programs that
 * allocated "notify" to different indices would read each other's garbage. ⚠️ THAT PREDICTION CAME
 * TRUE: `patch_prog.py --demo slice1` wrote its TAP marker to var 0 while this file read var 15, so
 * a real handler that ran was reported as "the handler did not run". Both now cite ffs_prog.h §2.
 */
export const FFSP_NOTIFY_VAR = 15;

/** NEED datum ids — ★ VALIDATE THE DATUM, NOT THE VERSION. ~6 instructions, ZERO wire bytes
 *  beyond the opcode, and it catches the one thing a version number structurally cannot: the
 *  version is right and the address moved. */
export const NEED = {
  /** *(u32*)0x005052c8 == 0x0071b690 — the kind→vtable array head, checked BEFORE indexing it */
  WF_VTABLE: 0,
  /** ⚠️ THE POWER-CYCLE GATE. page_manager_send_input NULL-checks mgr but NOT its root, and a
   *  NULL root makes LVGL's assert do `str r0,[0xFFFFFFFF]; b .` — a hang needing the charging
   *  case (the G2 has no power button), not a no-op. */
  PAGEMGR: 1,
  /** *(u32*)0x20002ca8 == 3 — the menu page descriptor is really page id 3 */
  MENU_DESC: 2,
  /** *(u8*)0x200e7934 readable, G2FW_DASH_PB in SRAM */
  DASH: 3,
} as const;
const NEED_MAX = 3;

/** EMIT sources. EMIT ORs `(value & ((1<<width)-1)) << shift` into the result mask.
 *  ★ `LOAD var, src, arg` READS THIS SAME ENUM and writes `var[]` instead of the result mask
 *  (ffs_prog.h §3, EMIT sources). One source reader serves both, so the per-source `arg` guard
 *  below is SHARED by `Op.emit` and `Op.load` — see `checkSourceArg`. */
export const EMIT_SRC = {
  VAR: 0,
  /** hnd[arg] + 0x5c — Even's own focus index */
  LISTFOCUS: 1,
  /** hnd[arg] + 0x58 — the item count the firmware actually built */
  LISTCOUNT: 2,
  EVT_N: 3,
  EVT_CODE: 4,
  EVT_DEV: 5,
  GEN: 6,
  STATUS: 7,
  /** ★ THE ROUND-TRIP ECHO. `EMIT 8,0,0,16` + END is the CI program that proves the header
   *  scalars are actually read and not folded into constants by -O2. */
  CODE_LEN: 8,
  SKIPPED: 9,
  /** kind[arg] — 0 none 1 text 2 list 3 lvobj */
  SLOTKIND: 10,
} as const;
const EMIT_SRC_MAX = 10;
/** `arg == 0xFF` on EVT_CODE / EVT_DEV means THE LAST EVENT. */
export const FFSP_EVT_LAST = 0xff;

export const CMP = { EQ: 0, NE: 1, LT: 2, GT: 3 } as const;
export const ADD_MODE = { CLAMP: 0, WRAP: 1 } as const;

export const PARENT_TARGET = { LAYER_TOP: 0, OVERLAY: 1, BASE: 2 } as const;
/** STYLE slot sentinel: address the current parent instead of a slot. */
export const FFSP_SLOT_PARENT = 0xfe;

/** ★ THE INVERSION THE AUTHOR NEVER SEES. `listNext()` / `listPrev()` are the surface; this is
 *  table data, not folklore. DOWN(0) moves focus FORWARD (index++); UP(1) DECREMENTS. */
export const LISTEV = { DOWN: 0, UP: 1 } as const;

/** ⚠️ PAGE REGISTRATION IS ONE-WAY — nothing frees a node until reboot, so every distinct id ever
 *  registered is consumed for the whole boot session. Exactly TWO ids exist and NEITHER is ever a
 *  wire field; `which` selects between them and the interpreter refuses anything else, so a phone
 *  cannot consume an id no matter what bytes it sends.
 *  TWO, not one, because Route B — layer 0, visible_default=1 — IS the "replace Even's launcher"
 *  configuration, and that is the standing decision. */
export const WHICH = { OVERLAY: 0, BASE: 1 } as const;
export const FFSP_PAGE_OVERLAY_ID = 0x0ff5;
export const FFSP_PAGE_BASE_ID = 0x0ff6;
export const FFSP_PANEL_W = 576;
export const FFSP_PANEL_H = 288;

/** ON input classes. */
export const ON_CLASS = {
  TAP: 0, DOUBLE: 1, SCROLL_FWD: 2, SCROLL_BACK: 3, RELEASE: 4, RAW: 5,
} as const;
const ON_CLASS_MAX = 5;

/** LVGL codes, for `raw` handlers. Measured with a finger, not read off a disassembly. */
export const LVGL_CODE = {
  TAP: 0x0a, DOUBLE: 0x48, UPROLL: 0x44, DOWNROLL: 0x45, RELEASE: 0x4a,
} as const;

export const DEV = { LEFT: 0, RIGHT: 1, RING: 4, ANY: 0xff } as const;
/** ★ A SWIPE IS A STREAM, not an event: one forward swipe measured 4 DOWNROLLs, one backward 5
 *  UPROLLs. `div` accumulates in vm->accum[] and defaults to 4 for the scroll classes — a default
 *  IN THE FORMAT rather than a footnote every program has to re-derive. */
export const DIV_DEFAULT_SCROLL = 4;
export const DIV_DEFAULT_TAP = 1;

/** Handlers run ON THE DISPLAY THREAD inside lv_obj_send_event. A long handler stutters the UI;
 *  a faulting one takes the lens. 64 instructions, enforced here because nothing in the hardware
 *  enforces it. */
export const FFSP_HANDLER_BUDGET = 64;

/**
 * The handler allowlist — ★ NOW AN EXACT MIRROR OF `FFSP_OP_ALLOWED_IN_HANDLER` (ffs_prog.h §4),
 * which is a change: it used to be that list MINUS `OP.STYLE`, an encoder-side narrowing of a
 * frozen contract.
 *
 * ⛔ `STYLE` WAS ON THE HEADER'S LIST AND IS NOT ANY MORE (removed 2026-08-11), so the refusal
 * below is THE CONTRACT rather than a local belt, and the header says its absence "must never be
 * 'fixed'". `LOAD` is on it, and deliberately so — a handler that cannot move a firmware reading
 * into `var[]` cannot remember what the user selected, which is the whole reason 0x07 exists.
 */
const HANDLER_ALLOWED: ReadonlySet<number> = new Set<number>([
  OP.END, OP.SET, OP.ADD, OP.IFVAR, OP.IFOP, OP.EMIT, OP.LOAD,
  OP.MOVE, OP.SIZE, OP.FLAG, OP.BOUNCE, OP.LISTEV,
  OP.SHOW, OP.HIDE, OP.SHOWSYS,
]);
/** Why each forbidden opcode is forbidden — the error message is the whole point of the check. */
const HANDLER_FORBIDDEN_REASON: Readonly<Record<number, string>> = {
  [OP.PAGE]: "PAGE registers a page node and registration is ONE-WAY (nothing frees a node until reboot) — it must never be reachable from a gesture",
  [OP.WFCREATE]: "WFCREATE drives the watchface module's STATICS; a gesture must not re-enter the watchface engine",
  [OP.DASH]: "DASH is a whole-screen takeover (dashboard_page_create), not something a tap may do",
  [OP.PDESC]: "PDESC writes a .data page descriptor",
  [OP.STYLE]: "every STYLE mallocs a 32 B style block and lv_obj_add_style APPENDS it to the object's (reallocating) style array, with nothing that ever reclaims either — bounded in the draw pass, but from a gesture it is ~200 B per swipe FOREVER plus a style list that lengthens every frame, ending in FW_MALLOC returning NULL; and ten of the recovered style props are POINTER-typed, so an input-driven STYLE is also the one place a program could plant a pointer the renderer dereferences on the next tick. ⛔ STYLE IS OFF ffs_prog.h's FFSP_OP_ALLOWED_IN_HANDLER as of 2026-08-11, and the header says its absence must never be 'fixed' — this is the contract, not an encoder-side narrowing. Styling is a DRAW-pass concern: a handler that must change appearance uses FLAG or moves a highlight with LISTEV",
  [OP.CLEAR]: "CLEAR frees the objects the handler's own slots point at",
  [OP.TEXT]: "constructors allocate and can return NULL on the display thread",
  [OP.LIST]: "constructors allocate and can return NULL on the display thread",
  [OP.OBJ]: "constructors allocate and can return NULL on the display thread",
  [OP.PARENT]: "the parent is chosen by the draw pass, not by a gesture",
  [OP.NEED]: "a datum check belongs in the draw pass, where a failure can abort the push",
  [OP.WFCALL]: "the watchface engine's setters touch module statics",
  [OP.CALL]: "an arbitrary call from an input path is the one place we could never reproduce the fault — forbidden even under UNSAFE",
  [OP.WRITE]: "an arbitrary write from an input path is the one place we could never reproduce the fault — forbidden even under UNSAFE",
  [OP.READ]: "an arbitrary read from an input path is the one place we could never reproduce the fault — forbidden even under UNSAFE",
};

// ── §7 LIMITS AND CLAMPS — table data, never folklore ─────────────────────────────────
/** WFCREATE cfg[] — layout 4's is 117 B. */
export const FFSP_MAX_CFG = 128;
/** ⚠️ common_list_create returns NULL on 0 or >20 items, and a NULL there is a SILENT NO-DRAW
 *  that looks EXACTLY like a broken push. That is why this throws instead of clamping. */
export const FFSP_MAX_ITEMS = 20;
/** ⚠️ It is a GREY INDEX, not rgb. Even's own clamp has an off-by-one that lets 16 through to
 *  "invalid color_index -> white", so 16 does not render "nearly white", it renders WRONG. */
export const FFSP_MAX_BORDER_COLOR = 15;
export const FFSP_MAX_BORDER_W = 5;
export const FFSP_MAX_RADIUS = 10;
export const FFSP_MAX_PADDING = 32;
/** Per string, NUL INCLUDED. */
export const FFSP_MAX_STR = 64;

/** ── THE DEFAULT BOX (ffs_prog.h §7), so the two encoders cannot disagree on what "a text box" is.
 *  ⚠️ `pad` IS NOT ONE NUMBER: 6 for text(), 8 for list(), which is what `patch_prog.py::text` and
 *  `list_` emit. This file used to default both to 8, so a `text({...})` with no explicit pad
 *  produced arg byte 12 = 0x08 here and 0x06 there — invisible to every golden, because both
 *  slice1 demos pass pad explicitly, and it would first have surfaced as a diff against a
 *  photograph taken from the other tool's push. They are HEADER DATA now (`FFSP_DEF_*`). */
export const FFSP_DEF_BORDER_W = 2;
export const FFSP_DEF_BORDER_COLOR = 15;
export const FFSP_DEF_RADIUS = 10;
export const FFSP_DEF_PAD_TEXT = 6;
export const FFSP_DEF_PAD_LIST = 8;
/** What Even's own filler always writes. */
export const FFSP_DEF_FONT = 1;

/**
 * ── GEOMETRY, AND WHY IT IS CLAMPED WIDER THAN THE PANEL (ffs_prog.h §7) ──
 * ⚠️ A [V]-bound geometry operand is a var, and `var[]` is `int32_t` — so the i16 in the ENCODING
 * is not the real bound at RUNTIME, and no encoder can check it: an unclamped `MOVE` from a handler
 * would hand LVGL an arbitrary int32 coordinate. The INTERPRETER clamps to this range, deliberately
 * WIDER than the 576x288 panel, because sliding a widget fully off-screen and back is a legitimate
 * transition and clamping to the panel would break it.
 * ⚠️ These are mirrored for the authoring surface to reason with, NOT enforced here: the clamp is a
 * runtime bound on a value this file cannot see, and refusing a literal outside it would refuse
 * off-screen staging that the range exists to permit.
 */
export const FFSP_GEO_MIN = -576;
export const FFSP_GEO_MAX = 1152;

/** Fixed arg bytes before TEXT's string / LIST's item blob (§3: `14+s`). */
const TEXT_FIXED_ARGS = 14;
const LIST_FIXED_ARGS = 14;
/**
 * ⚠️ ★ THE CAP THAT ACTUALLY BINDS A LIST. An instruction's `len` is a **u8**, so no instruction can
 * carry more than 255 arg bytes — which makes `FFSP_MAX_ITEMS (20) x FFSP_MAX_STR (64) = 1280`
 * STRUCTURALLY UNREACHABLE, as ffs_prog.h §7 now says outright. The real limit on a LIST is 241
 * bytes of strings however they are distributed, and the header requires the encoders to say WHICH
 * cap they refused on. See `Op.list` and `list()`.
 */
export const FFSP_MAX_LIST_STRING_BYTES = 255 - LIST_FIXED_ARGS;

/** WRITE/READ regions — named, never a raw address. A region-bounded write keeps the speed of
 *  this codebase's dominant discovery mode (a struct-field write: pb+0x40, g_layout, node[0x14],
 *  the gate byte) without handing an arbitrary SRAM address to anything that can send a BLE
 *  frame. A truly arbitrary poke stays a C payload. */
export const REGION = { DASH_PB: 0, LAYOUT_CFG: 1, MENU_DESC: 2, DASH_GEO: 3 } as const;
const REGION_MAX = 3;
/** ★ ALL FOUR LENGTHS ARE HEADER DATA NOW — `FFSP_RGN_LEN_*` (ffs_prog.h §8), mirrored here rather
 *  than re-derived. ⚠️ The first cut of the header gave a length for only ONE of the four
 *  (LAYOUT_CFG), so two separate tools each derived the other three, "which is how bounds silently
 *  diverge" — and `off+size` past a region's end is a bounded write into undecoded memory, i.e. the
 *  raw POKE §8 exists to refuse. The numbers are unchanged; only their provenance is:
 *    DASH_PB   0xB0 — the last documented field is L4_COUNT (u16 @0xae)
 *    MENU_DESC 0x1C — page_manager_register does memcpy(node, desc, 0x1C) @0x0045f814
 *    DASH_GEO  0x18 — apply_geo writes six words */
const REGION_LEN: Readonly<Record<number, { name: string; len: number }>> = {
  [REGION.DASH_PB]: { name: "DASH_PB", len: 0xb0 },      // FFSP_RGN_LEN_DASH_PB
  [REGION.LAYOUT_CFG]: { name: "LAYOUT_CFG", len: 0x80 }, // FFSP_RGN_LEN_LAYOUT_CFG
  [REGION.MENU_DESC]: { name: "MENU_DESC", len: 0x1c },   // FFSP_RGN_LEN_MENU_DESC
  [REGION.DASH_GEO]: { name: "DASH_GEO", len: 0x18 },     // FFSP_RGN_LEN_DASH_GEO
};

/** ⛔ THE TEN POINTER-TYPED LV_STYLE_* PROPS. `lv_style_set_prop`'s value argument is a UNION, so
 *  `STYLE slot, 90, 0xDEADBEEF` plants a garbage `lv_font_t*` that the renderer dereferences on
 *  the next draw tick — from a wire byte, with no UNSAFE flag anywhere near it. That is the exact
 *  failure `ffs_widget_style.h`'s opening comment says it exists to prevent ("BORDER_WIDTH was
 *  40, which is really BG_IMAGE_SRC, so setting a border width planted an integer where a bitmap
 *  POINTER was expected"). ffs_prog.h §8 gates WRITE/READ behind FFSP_FLAG_UNSAFE *plus* an exact
 *  fw_build match because "a truly arbitrary poke stays a C payload"; STYLE reaches the same
 *  severity, so all three implementations refuse these ten ids. */
/** ⛔ The ten pointer-typed style props. **`ffs_prog.h` §7 (`FFSP_STYLE_PROP_IS_PTR`) owns these
 *  ids; this is a MIRROR.** All three implementations used to carry their own copy — they agreed,
 *  and nothing could have caught it if they had stopped, because a refused prop has no golden byte
 *  vector, so one encoder accepting what another refuses is completely silent. `patch_prog.py`
 *  now parses the set out of the header and republishes it as `style_ptr_props` in
 *  `ffsp_goldens.json`, and the cross-check test asserts this object's keys against it. Exported
 *  ONLY so that test can reach it. */
export const STYLE_PTR_PROPS: Readonly<Record<number, string>> = {
  38: "BG_GRAD (lv_grad_dsc_t*)",
  40: "BG_IMAGE_SRC (const void*)",
  84: "ARC_IMAGE_SRC (const void*)",
  90: "TEXT_FONT (lv_font_t*)",
  100: "COLOR_FILTER_DSC (lv_color_filter_dsc_t*)",
  102: "ANIM (lv_anim_t*)",
  104: "TRANSITION (lv_style_transition_dsc_t*)",
  117: "BITMAP_MASK_SRC (const void*)",
  129: "GRID_ROW_DSC_ARRAY (const int32_t*)",
  130: "GRID_COLUMN_DSC_ARRAY (const int32_t*)",
};
/** `FFSP_STYLE_PROP_MAX` (ffs_prog.h §7) — LV_STYLE_LAST_BUILT_IN_PROP for this image, recovered
 *  twice from the binary (stock LVGL v9.3.0 numbering, 138 props) and confirmed on hardware by
 *  FUT-238. ⛔ THE PROP ID IS GATED AND THE VALUE IS NOT, so the id is the whole safety boundary. */
export const FFSP_STYLE_PROP_MAX = 137;
const STYLE_PROP_MAX = FFSP_STYLE_PROP_MAX;

/** ⛔ THE ONLY LVGL CODES AN `ON RAW` BLOCK CAN EVER MATCH — see `Handlers.raw`. */
const RAW_CODES_THAT_CAN_FIRE: ReadonlySet<number> = new Set<number>([
  LVGL_CODE.TAP, LVGL_CODE.DOUBLE, LVGL_CODE.UPROLL, LVGL_CODE.DOWNROLL, LVGL_CODE.RELEASE,
]);

/** ⛔ Why `FLAG on=0` is refused in slice 1. Shared by `Op.flag()` and `flag()`. */
const FLAG_OFF_REASON =
  "FLAG on=0 lowers to lv_obj_remove_flag 0x0043dfa5, which the interpreter REFUSES in slice 1 " +
  "(status=DATUM). That address has no g2fw.h symbol, is called by no payload, and was DERIVED as " +
  "the companion of add_flag out of watchface slot 8 — ffs_prog.c calls it \"the weakest address in " +
  "the file\". Cardinal rule 1: proven on-glass, per capability, or it does not ship; MAPPED IS NOT " +
  "PROVEN. FLAG is on the handler allowlist, so on=0 would put an unproven address on the display " +
  "thread on a REAL TEMPLE TAP — the least reproducible fault we could ship, and if the address is " +
  "wrong the first symptom is a dead lens with no ret= to read. Refused rather than emitted as a " +
  "no-op, for the same reason longPress() throws: a no-op reads as \"remove_flag does nothing on " +
  "this hardware\", a different and wrong conclusion.";

/** CALL's address is forced into flash text with the thumb bit set. Anything else is refused by
 *  the interpreter with status=DATUM; refused here first, with the reason. */
export const FFSP_CALL_LO = 0x00438000;
export const FFSP_CALL_HI = 0x00800000;

/** Result tags. Bumped from v1's 0x75 so a STALE BLOB'S ret= cannot be misread as a v2 one. */
export const FFSP_TAG_RENDER = 0x7e;
export const FFSP_TAG_READBACK = 0x7f;

/** LV_STYLE_* property ids, re-derived from the binary (g2fw.h, FUT-238). Only the ones an SDK
 *  screen plausibly needs; the full table lives in g2fw.h.
 *  ★ BG_OPA(29) = 0 on the page root is the FUT-198 guard: WITHOUT it the page root is a filled
 *  bright rectangle over the whole HUD — the green-screen, already photographed once. */
export const STYLE_PROP = {
  WIDTH: 1, HEIGHT: 2, X: 8, Y: 9, ALIGN: 10, RADIUS: 12,
  PAD_TOP: 16, PAD_BOTTOM: 17, PAD_LEFT: 18, PAD_RIGHT: 19,
  BG_COLOR: 28, BG_OPA: 29,
  BORDER_WIDTH: 48, BORDER_COLOR: 49, BORDER_OPA: 50,
  TEXT_COLOR: 88, OPA: 98, TRANSLATE_X: 108, TRANSLATE_Y: 109,
} as const;

// ══════════════════════════════════════════════════════════════════════════════════════
// 2. CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF, no reflection, no xorout
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * ffs_prog.h §9's `ffsp_crc16`, to the bit.
 *
 * ⚠️ This is NOT the frame CRC. `templates.ts::crc32` is computed by the framer AFTER patching and
 * proves TRANSPORT. This one proves THE ENCODER AND THE HOLE AGREE — it catches "the patcher wrote
 * past the hole" and "the hole moved after a rebuild", which are the two ways this class of SDK
 * dies silently.
 *
 * Vectors (§9, all four verified against the C): "" 0xFFFF · "A" 0xB915 ·
 * "123456789" 0x29B1 · sixteen 0x00 bytes 0x6A0A.
 */
export function crc16(bytes: Uint8Array): number {
  let c = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (c ^ (bytes[i] << 8)) & 0xffff;
    for (let b = 0; b < 8; b++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
  }
  return c & 0xffff;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 3. THE INSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * One FFSP instruction, pre-encoding.
 *
 * Wire shape, and ★ THE LOAD-BEARING DECISION OF THE WHOLE FORMAT:
 *     u8 op · u8 len · u8 vmask · u8 args[len]
 * Skipping an instruction you do not understand is unconditionally `pc += 3 + len`, with ZERO
 * per-opcode knowledge. Total skippability is the entire forward-compatibility story, and three
 * bytes of header per instruction is what it costs.
 */
export interface Ins {
  /** 0..0x7F — WITHOUT the REQUIRED bit; see `required()`. */
  readonly op: number;
  /** bit i => numeric operand slot i is a VAR INDEX (`vm->var[value & 0x0F]`). */
  readonly vmask: number;
  readonly args: Uint8Array;
  /** REQUIRED: an interpreter that lacks this opcode must ABORT rather than skip. */
  readonly req: boolean;
  /** Mnemonic, for error messages only — never on the wire. */
  readonly name: string;
}

/** Mark an instruction REQUIRED: an old interpreter aborts with status=UNKNOWN_REQUIRED rather
 *  than silently skipping it. The AUTHOR declares the consequence per instruction — a fade-in
 *  decoration is optional; `PAGE` is not. */
export function required(ins: Ins): Ins {
  return { ...ins, req: true };
}

/** 3 + len bytes, exactly as the interpreter's loop reads them. */
export function insBytes(ins: Ins): Uint8Array {
  if (ins.args.length > 255) {
    throw new Error(`${ins.name}: ${ins.args.length} arg bytes; \`len\` is a u8 so 255 is the ceiling`);
  }
  const out = new Uint8Array(3 + ins.args.length);
  out[0] = (ins.op & FFSP_OP_MASK) | (ins.req ? FFSP_OP_REQUIRED : 0);
  out[1] = ins.args.length;
  out[2] = ins.vmask;
  out.set(ins.args, 3);
  return out;
}

/** Total encoded size of a run of instructions. */
function runLength(list: readonly Ins[]): number {
  let n = 0;
  for (const i of list) n += 3 + i.args.length;
  return n;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ── the arg writer ────────────────────────────────────────────────────────────────────
// ⚠️ BYTE-PACKED WITH NO ALIGNMENT PADDING, LITTLE-ENDIAN, in the opcode's declared order.
// Because there is no padding EVERY multi-byte read on the interpreter side is potentially
// unaligned — which is why ffs_prog.h ships FFSP_RD16/FFSP_RD32 and forbids `*(uint16_t*)p`.
// Nothing here may ever insert a pad byte "to help".

class ArgWriter {
  private readonly bytes: number[] = [];
  constructor(private readonly where: string) {}

  u8(v: number, field: string): this {
    this.range(v, field, 0, 0xff);
    this.bytes.push(v & 0xff);
    return this;
  }
  i16(v: number, field: string): this {
    this.range(v, field, -0x8000, 0x7fff);
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u16(v: number, field: string): this {
    this.range(v, field, 0, 0xffff);
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  i32(v: number, field: string): this {
    // Accepts the whole 32-bit range from either side: a flag word reads naturally as unsigned,
    // a coordinate delta as signed, and both land on identical bytes.
    this.range(v, field, -0x80000000, 0xffffffff);
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u32(v: number, field: string): this {
    return this.i32(v, field);
  }
  raw(b: Uint8Array): this {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i]);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
  private range(v: number, field: string, lo: number, hi: number): void {
    if (!Number.isInteger(v)) throw new Error(`${this.where}: ${field} must be an integer, got ${v}`);
    if (v < lo || v > hi) throw new Error(`${this.where}: ${field}=${v} out of range ${lo}..${hi}`);
  }
}

// ── vmask ─────────────────────────────────────────────────────────────────────────────
// `vmask` is a SEPARATE BYTE and never a tag in the value's top bits: -5.0f is 0xC0A00000 and a
// top-two-bits tag would read it as a variable reference.
//
// §2's prose is normative: "Numeric operand slots are numbered from 0 in DECLARED ORDER." §3's
// table then annotates each var-bindable operand [Vn], and every `n` equals the declared-order
// index (SET imm=1, ADD delta=1, EMIT arg=1, MOVE x=1/y=2, STYLE value=2, FLAG on=2, TEXT x..h=1..4,
// WFCALL a..d=2..5, PDESC value=2, LISTEV ev=1, LOAD arg=2).
//
// ⚠️ ★ IFVAR USED TO BE THE ONE PLACE THE HEADER CONTRADICTED ITSELF, AND IT NO LONGER IS.
// `IFVAR var:u8, cmp:u8, imm:i16, skip:u16` makes `imm` operand 2 by declared order while the
// table annotated it `[V1]`. This file followed the prose rule (bit 2) and reported the one-
// character typo rather than silently patching it; ffs_prog.h §3 now reads `imm:i16[V2]`, so the
// table and the prose agree and BIT 2 IS THE CONTRACT. Nothing in the authoring surface sets that
// bit by default, so a compiled program cannot diverge on it either way.
const VBIT = {
  SET_IMM: 1,
  ADD_DELTA: 1,
  EMIT_ARG: 1,
  IFVAR_IMM: 2, // [V2] — declared order (var, cmp, imm, skip), and the header now says so
  LOAD_ARG: 2,  // LOAD var:u8, src:u8, arg:u8[V2]
  MOVE_X: 1, MOVE_Y: 2,
  SIZE_W: 1, SIZE_H: 2,
  STYLE_VALUE: 2,
  FLAG_ON: 2,
  TEXT_X: 1, TEXT_Y: 2, TEXT_W: 3, TEXT_H: 4,
  BOUNCE_BASE_Y: 1,
  WFCREATE_X: 1,
  WFCALL_A: 2, WFCALL_B: 3, WFCALL_C: 4, WFCALL_D: 5,
  LISTEV_EV: 1,
  PDESC_VALUE: 2,
} as const;

/** A live variable standing in for an immediate. `vm->var[index]` is read at execution time. */
export interface VarRef { readonly __varRef: string | number; }
/** Bind a numeric operand to a resident variable — the thing that lets a screen react on-glass
 *  with the phone completely uninvolved. */
export function varRef(name: string | number): VarRef {
  return { __varRef: name };
}
function isVarRef(v: unknown): v is VarRef {
  return typeof v === "object" && v !== null && "__varRef" in (v as object);
}
export type Num = number | VarRef;

// ══════════════════════════════════════════════════════════════════════════════════════
// 4. THE OPCODE ENCODERS — one per row of §3's table, and nothing else
//    These are the compile TARGET. They take slot indices and var indices, never string ids.
// ══════════════════════════════════════════════════════════════════════════════════════

function ins(name: string, op: number, args: Uint8Array, vmask = 0): Ins {
  return { name, op, args, vmask, req: false };
}

/**
 * ⚠️ ★ EVERY GUARD BELOW EXISTS BECAUSE THE INTERPRETER SILENTLY MANGLES THE VALUE INSTEAD OF
 * REFUSING IT — which is the failure mode this codebase spends most of its comments on.
 * `patch_prog.py` enforces this same table via `_rng`; this file used to accept a range of
 * inputs Python refused, so a program that assembled here would have been refused there, and
 * one that ran here would have run DIFFERENTLY on the glasses. `rng()` is the shared shape.
 */
function rng(where: string, field: string, v: number, lo: number, hi: number, why = ""): number {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`${where}: ${field}=${v} out of range ${lo}..${hi}${why ? `; ${why}` : ""}`);
  }
  return v;
}
/** A literal-only guard: skipped when the operand is var-bound, because then the encoded value
 *  is a VAR INDEX (already bounded to 0..15 by `Operands.n`) and `lo`/`hi` describe the
 *  immediate, not the index. Exactly `patch_prog.py::_rng(..., vars)`. */
function rngLit(where: string, field: string, v: Num, lo: number, hi: number, why = ""): void {
  if (isVarRef(v)) return;
  rng(where, field, v, lo, hi, why);
}

/**
 * ★ THE SOURCE GUARD, SHARED BY `EMIT` AND `LOAD` SO THE TWO CANNOT DRIFT.
 *
 * ffs_prog.h §3 says `LOAD var, src, arg` "reads THIS SAME ENUM and writes `var[]` instead of the
 * result mask. One source reader serves both, so the pair costs one implementation, not two." The
 * same is true of the validation, and it is validation that MUST be shared rather than copied:
 *
 * ⚠️ `arg` INDEXES A DIFFERENT SPACE PER SOURCE, and each one is MASKED (not checked) on the
 * glasses — slots by `>= FFSP_MAX_SLOTS`, vars by `& 0x0F`, events by `& (FFSP_MAX_EVTS-1)`. So
 * `evtCode(20)` returned event 4: a real number for the WRONG event, which is the exact shape of
 * the ffs_gesture_wizard bug. A `LOAD` with its own copy of this table would eventually disagree
 * with `EMIT`'s, and a program would then read one thing into a variable and report another.
 *
 * Skipped entirely when `arg` is var-bound: the encoded value is then a VAR INDEX (already bounded
 * to 0..15 by `Operands.n`), and lo/hi describe the immediate, not the index.
 */
function checkSourceArg(where: string, src: number, arg: Num): void {
  if (src < 0 || src > EMIT_SRC_MAX) {
    throw new Error(`${where}: src=${src} is not one of the ${EMIT_SRC_MAX + 1} defined sources`);
  }
  if (isVarRef(arg)) return;
  if (src === EMIT_SRC.LISTFOCUS || src === EMIT_SRC.LISTCOUNT || src === EMIT_SRC.SLOTKIND) {
    rng(where, "arg", arg, 0, FFSP_MAX_SLOTS - 1, "this source indexes a SLOT");
  } else if (src === EMIT_SRC.EVT_CODE || src === EMIT_SRC.EVT_DEV) {
    if (arg !== FFSP_EVT_LAST) {
      rng(where, "arg", arg, 0, 15,
        "this source indexes the 16-entry event ring; use 0xFF (FFSP_EVT_LAST) for the last event, " +
        "because the interpreter does `arg & 15` and a larger index silently reads the WRONG event");
    }
  } else if (src === EMIT_SRC.VAR) {
    rng(where, "arg", arg, 0, FFSP_MAX_VARS - 1, "this source indexes var[]");
  } else {
    rng(where, "arg", arg, 0, 0xff);
  }
}

/** `off + size` must fit the named region. ★ A REGION-BOUNDED WRITE IS THE WHOLE REASON WRITE IS
 *  NOT A RAW POKE: an arbitrary SRAM address must never be reachable by anything that can send a
 *  BLE frame. Same numbers and same shape as `patch_prog.py::_region`. */
function checkRegion(where: string, region: number, off: number, size: number): void {
  const r = REGION_LEN[region];
  if (r === undefined) throw new Error(`${where}: region=${region} is not one of the ${REGION_MAX + 1} named regions`);
  if (size !== 1 && size !== 2 && size !== 4) throw new Error(`${where}: size=${size}; a region write is 1, 2 or 4 bytes`);
  if (!Number.isInteger(off) || off < 0 || off + size > r.len) {
    throw new Error(
      `${where}: ${r.name} off=${off} + size=${size} runs past the region's ${r.len} B. A ` +
      "region-bounded write is the whole reason WRITE is not a raw POKE — an arbitrary SRAM address " +
      "must never be reachable by anything that can send a BLE frame.");
  }
}

/** Resolve `Num` operands against a var resolver, accumulating the vmask. */
class Operands {
  vmask = 0;
  constructor(private readonly resolve: (n: string | number) => number, private readonly where: string) {}
  /** Returns the literal to encode; sets `bit` when the operand is a variable reference. */
  n(v: Num, bit: number, field: string): number {
    if (!isVarRef(v)) return v;
    const idx = this.resolve(v.__varRef);
    if (!Number.isInteger(idx) || idx < 0 || idx >= FFSP_MAX_VARS) {
      throw new Error(`${this.where}: ${field} binds var index ${idx}; the VM has ${FFSP_MAX_VARS} (var & 0x0F)`);
    }
    this.vmask |= 1 << bit;
    return idx & FFSP_VAR_MASK;
  }
}

/** No-op resolver for the encoder-level API, where a VarRef must already be an index. */
const literalVars = (n: string | number): number => {
  if (typeof n !== "number") {
    throw new Error(`varRef("${n}"): a raw opcode encoder takes a var INDEX, not a name — name resolution happens in screen()/dashboard()`);
  }
  return n;
};

export const Op = {
  /** 0x00 END — also what a zero-filled program hole decodes to, which is why it must be 0. */
  end(): Ins {
    return ins("END", OP.END, new Uint8Array(0));
  },

  /** 0x01 IFOP op_id:u8, skip:u16 — run the following block only if this interpreter implements
   *  that opcode. Paired with a plain fallback block it is an if/else, so a new opcode gets a
   *  hand-written fallback on an old interpreter instead of silently vanishing.
   *
   *  ★ `skip` UNITS ARE PINNED BY THE HEADER NOW (ffs_prog.h §2), and they used to be a per-tool
   *  definition: it is a FORWARD BYTE DELTA FROM THE POST-ADVANCE pc — i.e. after `pc += 3 + len`
   *  for the IFOP itself, the target is `pc + skip`. Not an instruction count, not an absolute
   *  offset, never negative. Same rule for IFVAR's `skip` and ON's `block_len`. All three
   *  implementations must agree or a program silently executes the wrong instructions. */
  ifOp(opId: number, skip: number): Ins {
    // ⛔ `IFOP LONGPRESS` used to encode cleanly because the op id was simply masked with
    // FFSP_OP_MASK. 0x45 is reserved and permanently unusable; guarding *it* while letting
    // `longPress()` throw is the same rule applied at both doors, and `patch_prog.py::ifop`
    // refuses it too.
    if ((opId & FFSP_OP_MASK) === OP.LONGPRESS) {
      throw new Error("IFOP: op_id 0x45 — " + LONGPRESS_REASON);
    }
    if (!ALLOCATED_OPS.has(opId & FFSP_OP_MASK)) {
      throw new Error(
        `IFOP: op_id 0x${(opId & FFSP_OP_MASK).toString(16)} is not an allocated opcode. IFOP asks ` +
        "\"does this interpreter implement that opcode?\" — an id nothing will ever allocate always " +
        "answers no, so the guarded block would be dead code that looks like a fallback.");
    }
    const w = new ArgWriter("IFOP");
    return ins("IFOP", OP.IFOP, w.u8(opId & FFSP_OP_MASK, "op_id").u16(skip, "skip").done());
  },

  /** 0x02 IFVAR var:u8, cmp:u8, imm:i16[V2], skip:u16.
   *  ⛔ `skip` is deliberately NEVER var-bindable: a var-bound skip would let a program jump
   *  somewhere the parser never validated. It is a forward byte delta from the post-advance pc —
   *  see `ifOp` above. */
  ifVar(v: number, cmp: number, imm: Num, skip: number): Ins {
    rng("IFVAR", "var", v, 0, FFSP_MAX_VARS - 1);
    rng("IFVAR", "cmp", cmp, CMP.EQ, CMP.GT, "0 EQ, 1 NE, 2 LT, 3 GT");
    rngLit("IFVAR", "imm", imm, -0x8000, 0x7fff);
    const o = new Operands(literalVars, "IFVAR");
    const w = new ArgWriter("IFVAR");
    const immLit = o.n(imm, VBIT.IFVAR_IMM, "imm");
    return ins("IFVAR", OP.IFVAR,
      w.u8(v, "var").u8(cmp, "cmp").i16(immLit, "imm").u16(skip, "skip").done(), o.vmask);
  },

  /** 0x03 SET var:u8, imm:i16 */
  set(v: number, imm: Num): Ins {
    rng("SET", "var", v, 0, FFSP_MAX_VARS - 1);
    rngLit("SET", "imm", imm, -0x8000, 0x7fff);
    const o = new Operands(literalVars, "SET");
    const w = new ArgWriter("SET");
    const lit = o.n(imm, VBIT.SET_IMM, "imm");
    return ins("SET", OP.SET, w.u8(v, "var").i16(lit, "imm").done(), o.vmask);
  },

  /** 0x04 ADD var:u8, delta:i16, lo:i16, hi:i16, mode:u8 (0 clamp, 1 wrap) */
  add(v: number, delta: Num, lo: number, hi: number, mode: number): Ins {
    rng("ADD", "var", v, 0, FFSP_MAX_VARS - 1);
    rngLit("ADD", "delta", delta, -0x8000, 0x7fff);
    rng("ADD", "mode", mode, ADD_MODE.CLAMP, ADD_MODE.WRAP, "0 CLAMP, 1 WRAP");
    if (lo > hi) {
      throw new Error(
        `ADD: lo=${lo} > hi=${hi}. The interpreter treats an inverted range as a no-op, so the ` +
        "variable never moves and the screen reads on-glass as \"the list is stuck\" — a symptom " +
        "with no obvious cause. Refused here instead.");
    }
    const o = new Operands(literalVars, "ADD");
    const w = new ArgWriter("ADD");
    const lit = o.n(delta, VBIT.ADD_DELTA, "delta");
    return ins("ADD", OP.ADD,
      w.u8(v, "var").i16(lit, "delta").i16(lo, "lo").i16(hi, "hi").u8(mode, "mode").done(), o.vmask);
  },

  /** 0x05 EMIT src:u8, arg:u8, shift:u8, width:u8 — OR a value into the result mask.
   *  It alone retires ffs_gesture_wizard's `-DFFS_SLICE=n` rebuild-per-read loop: reading two
   *  captured events stops being a recompile on the dev box and becomes a 14-byte program. */
  emit(src: number, arg: Num, shift: number, width: number): Ins {
    // ⚠️ THE INTERPRETER SILENTLY NARROWS RATHER THAN REFUSING: ffs_prog.c does
    // `if (shift + width > 24) width = 24 - shift;`. So an over-wide field does not fail, it
    // returns a TRUNCATED number that looks plausible — which is precisely the ffs_gesture_wizard
    // bug (a 12-bit field at bit 20, silently masked off by the `& 0x00FFFFFF` on the way out, so
    // every odd-indexed event decoded as code 0x00). Only `readback()` used to check this; the
    // raw encoder did not, so `Op.emit` was a way around the check.
    rng("EMIT", "width", width, 1, 24);
    rng("EMIT", "shift", shift, 0, 23);
    if (shift + width > 24) {
      throw new Error(
        `EMIT: shift=${shift} + width=${width} = ${shift + width} runs past bit 23. The result mask ` +
        "is 24 bits and there is no 25th; the interpreter would clamp width and hand back a " +
        "truncated value. ⚠️ THIS IS THE ffs_gesture_wizard BUG, PAID FOR ONCE.");
    }
    // ⚠️ `arg` indexes a different space per source and the glasses MASK rather than check it —
    // shared with LOAD, because a second copy of that table is a drift waiting to happen.
    checkSourceArg("EMIT", src, arg);
    const o = new Operands(literalVars, "EMIT");
    const w = new ArgWriter("EMIT");
    const lit = o.n(arg, VBIT.EMIT_ARG, "arg");
    return ins("EMIT", OP.EMIT,
      w.u8(src, "src").u8(lit, "arg").u8(shift, "shift").u8(width, "width").done(), o.vmask);
  },

  /** 0x06 NEED datum:u8 */
  need(datum: number): Ins {
    if (datum < 0 || datum > NEED_MAX) throw new Error(`NEED: datum=${datum} is not one of the ${NEED_MAX + 1} defined checks`);
    return ins("NEED", OP.NEED, new ArgWriter("NEED").u8(datum, "datum").done());
  },

  /**
   * 0x07 LOAD var:u8, src:u8, arg:u8 — ★ EMIT'S SOURCE ENUM POINTED AT A VARIABLE.
   *
   * Reads `FFSP_EMIT_*` exactly as EMIT does and writes `vm->var[var]` instead of ORing into the
   * result mask, so `Op.emit` and this share ONE `arg` guard (`checkSourceArg`) and cannot drift.
   *
   * ★ WHY IT EXISTS: without it slice 1 could not express its own spec. Design §6 asks a TAP
   * handler for `SET var0 <- listFocus(1)`, and SET takes an IMMEDIATE — so nothing could move a
   * firmware reading into `var[]`, and `var[16]` (described as "the OS's entire mutable state") was
   * worth nothing, because no screen could remember what the user selected. The authoring surface
   * spells it `set(name, listFocus(id))`; nobody types the opcode.
   *
   * `arg` is operand slot 2 in declared order — vmask bit 2, `[V2]` in §3's table.
   * ⚠️ Adding an id needed NO symgen bump: an old interpreter SKIPS it with `pc += 3 + len`, which
   * is §2's total-skippability rule doing the job it exists for. Only a changed MEANING moves
   * symgen.
   */
  load(v: number, src: number, arg: Num): Ins {
    rng("LOAD", "var", v, 0, FFSP_MAX_VARS - 1);
    checkSourceArg("LOAD", src, arg);
    const o = new Operands(literalVars, "LOAD");
    const w = new ArgWriter("LOAD");
    const lit = o.n(arg, VBIT.LOAD_ARG, "arg");
    return ins("LOAD", OP.LOAD, w.u8(v, "var").u8(src, "src").u8(lit, "arg").done(), o.vmask);
  },

  /** 0x10 PARENT target:u8 */
  parent(target: number): Ins {
    // The interpreter refuses an unknown target with status=DATUM and aborts the whole draw pass
    // ("⛔ NO SILENT FALLBACK" — drawing onto lv_layer_top when the author asked for our page is
    // the mess owning a page exists to leave behind). Refused here first, with the names.
    rng("PARENT", "target", target, PARENT_TARGET.LAYER_TOP, PARENT_TARGET.BASE,
      "0 lv_layer_top, 1 our overlay page root, 2 our base page root");
    return ins("PARENT", OP.PARENT, new ArgWriter("PARENT").u8(target, "target").done());
  },

  /** 0x11 CLEAR — lv_obj_clean(parent) AND zero obj[]/hnd[] AND gen++.
   *  ★ These three are NEVER separable: the generation bump is what stops a later handler
   *  dereferencing a freed lv_obj and hitting LVGL's `str r0,[0xFFFFFFFF]; b .` assert, which is
   *  a power cycle (fold the temples into the charging case), not a no-op.
   *  ⛔ AND IT IS ONLY EVER LEGAL ON A ROOT WE OWN — see `assemble()`, which refuses a CLEAR whose
   *  current parent is `lv_layer_top`. The instruction carries no operand, so the check cannot live
   *  here: the parent is whatever the last PARENT said. */
  clear(): Ins {
    return ins("CLEAR", OP.CLEAR, new Uint8Array(0));
  },

  /** 0x12 MOVE slot:u8, x:i16, y:i16 */
  move(slot: number, x: Num, y: Num): Ins {
    rng("MOVE", "slot", slot, 0, FFSP_MAX_SLOTS - 1);
    rngLit("MOVE", "x", x, -0x8000, 0x7fff);
    rngLit("MOVE", "y", y, -0x8000, 0x7fff);
    const o = new Operands(literalVars, "MOVE");
    const w = new ArgWriter("MOVE");
    const xl = o.n(x, VBIT.MOVE_X, "x");
    const yl = o.n(y, VBIT.MOVE_Y, "y");
    return ins("MOVE", OP.MOVE, w.u8(slot, "slot").i16(xl, "x").i16(yl, "y").done(), o.vmask);
  },

  /** 0x13 SIZE slot:u8, w:i16, h:i16 */
  size(slot: number, ww: Num, hh: Num): Ins {
    rng("SIZE", "slot", slot, 0, FFSP_MAX_SLOTS - 1);
    rngLit("SIZE", "w", ww, -0x8000, 0x7fff);
    rngLit("SIZE", "h", hh, -0x8000, 0x7fff);
    const o = new Operands(literalVars, "SIZE");
    const w = new ArgWriter("SIZE");
    const wl = o.n(ww, VBIT.SIZE_W, "w");
    const hl = o.n(hh, VBIT.SIZE_H, "h");
    return ins("SIZE", OP.SIZE, w.u8(slot, "slot").i16(wl, "w").i16(hl, "h").done(), o.vmask);
  },

  /** 0x14 STYLE slot:u8, prop:u8, value:i32 — `slot` may be FFSP_SLOT_PARENT (0xFE). */
  style(slot: number, prop: number, value: Num): Ins {
    if (slot !== FFSP_SLOT_PARENT) rng("STYLE", "slot", slot, 0, FFSP_MAX_SLOTS - 1, "or 0xFE for the current parent");
    rng("STYLE", "prop", prop, 0, STYLE_PROP_MAX,
      `LV_STYLE_LAST_BUILT_IN_PROP is ${STYLE_PROP_MAX} in this image (FUT-238)`);
    const ptr = STYLE_PTR_PROPS[prop];
    if (ptr !== undefined) {
      throw new Error(
        `STYLE: prop ${prop} (${ptr}) is POINTER-TYPED and is refused by all three implementations. ` +
        "lv_style_set_prop's value argument is a union, so the i32 you pass becomes a pointer the " +
        "RENDERER dereferences on the next draw tick — from a wire byte, with no UNSAFE flag anywhere " +
        "near it. ffs_prog.h §8 gates WRITE/READ behind FFSP_FLAG_UNSAFE plus an exact fw_build match " +
        "because \"a truly arbitrary poke stays a C payload\"; this reaches the same severity.");
    }
    const o = new Operands(literalVars, "STYLE");
    const w = new ArgWriter("STYLE");
    const v = o.n(value, VBIT.STYLE_VALUE, "value");
    return ins("STYLE", OP.STYLE, w.u8(slot, "slot").u8(prop, "prop").i32(v, "value").done(), o.vmask);
  },

  /** 0x15 FLAG slot:u8, flag:u32, on:u8 — lv_obj_add_flag / lv_obj_remove_flag */
  flag(slot: number, flagBits: number, on: Num): Ins {
    rng("FLAG", "slot", slot, 0, FFSP_MAX_SLOTS - 1);
    // ⛔ on=0 is refused, and a var-bound `on` is refused because it could RESOLVE to 0.
    if (isVarRef(on)) throw new Error("FLAG: `on` cannot be var-bound in slice 1 — it could resolve to 0, and " + FLAG_OFF_REASON);
    rng("FLAG", "on", on, 0, 1);
    if (on === 0) throw new Error("FLAG: " + FLAG_OFF_REASON);
    const o = new Operands(literalVars, "FLAG");
    const w = new ArgWriter("FLAG");
    const onl = o.n(on, VBIT.FLAG_ON, "on");
    return ins("FLAG", OP.FLAG, w.u8(slot, "slot").u32(flagBits, "flag").u8(onl, "on").done(), o.vmask);
  },

  /** 0x20 TEXT dst:u8, x,y,w,h:i16, bw,bc,rad,pad,font:u8, str (NUL-terminated) */
  text(a: {
    dst: number; x: Num; y: Num; w: Num; h: Num;
    bw: number; bc: number; rad: number; pad: number; font: number; str: Uint8Array;
  }): Ins {
    if (TEXT_FIXED_ARGS + a.str.length > 255) {
      throw new Error(`TEXT: ${a.str.length} B of string needs len=${TEXT_FIXED_ARGS + a.str.length}; the instruction header's \`len\` is a u8`);
    }
    const o = new Operands(literalVars, "TEXT");
    const w = new ArgWriter("TEXT");
    const x = o.n(a.x, VBIT.TEXT_X, "x"), y = o.n(a.y, VBIT.TEXT_Y, "y");
    const ww = o.n(a.w, VBIT.TEXT_W, "w"), hh = o.n(a.h, VBIT.TEXT_H, "h");
    return ins("TEXT", OP.TEXT, w
      .u8(a.dst, "dst").i16(x, "x").i16(y, "y").i16(ww, "w").i16(hh, "h")
      .u8(a.bw, "bw").u8(a.bc, "bc").u8(a.rad, "rad").u8(a.pad, "pad").u8(a.font, "font")
      .raw(a.str).done(), o.vmask);
  },

  /** 0x21 LIST dst:u8, x,y,w,h:i16, bw,bc,rad,pad:u8, n:u8, then n NUL-terminated strings */
  list(a: {
    dst: number; x: Num; y: Num; w: Num; h: Num;
    bw: number; bc: number; rad: number; pad: number; n: number; items: Uint8Array;
  }): Ins {
    // ⚠️ ★ WHICH CAP BOUND — and the header requires the refusal to SAY. ffs_prog.h §7 pins
    // FFSP_MAX_ITEMS (20) and FFSP_MAX_STR (64), and states outright that their product (1280 B) is
    // STRUCTURALLY UNREACHABLE, because the instruction header's `len` is a u8: a LIST holds at most
    // 255 - 14 = 241 B of strings however many items it declares. Two different caps can refuse a
    // list, and an author who is told the wrong one edits the wrong thing — so this one names the
    // u8 `len`, and `list()` names the item count.
    // The alternative — an over-long list silently truncated by a `& 0xFF` on `len` — is a program
    // whose remaining instructions are parsed from the middle of a string, i.e. unbounded nonsense
    // on the display thread.
    if (LIST_FIXED_ARGS + a.items.length > 255) {
      throw new Error(
        `LIST: ${a.n} items totalling ${a.items.length} B of strings needs len=${LIST_FIXED_ARGS + a.items.length}, ` +
        "but the instruction header's `len` is a u8 (max 255) — ⚠️ THE BOUND THAT BIT HERE IS THE u8 " +
        `\`len\`, NOT FFSP_MAX_ITEMS (${FFSP_MAX_ITEMS}) or FFSP_MAX_STR (${FFSP_MAX_STR}). Their product ` +
        `(${FFSP_MAX_ITEMS * FFSP_MAX_STR} B) is structurally unreachable, as ffs_prog.h §7 says: the ` +
        `true ceiling is ${255 - LIST_FIXED_ARGS} B of strings per LIST. Shorten the items or split the list.`);
    }
    const o = new Operands(literalVars, "LIST");
    const w = new ArgWriter("LIST");
    const x = o.n(a.x, VBIT.TEXT_X, "x"), y = o.n(a.y, VBIT.TEXT_Y, "y");
    const ww = o.n(a.w, VBIT.TEXT_W, "w"), hh = o.n(a.h, VBIT.TEXT_H, "h");
    return ins("LIST", OP.LIST, w
      .u8(a.dst, "dst").i16(x, "x").i16(y, "y").i16(ww, "w").i16(hh, "h")
      .u8(a.bw, "bw").u8(a.bc, "bc").u8(a.rad, "rad").u8(a.pad, "pad").u8(a.n, "n")
      .raw(a.items).done(), o.vmask);
  },

  /** 0x22 OBJ dst:u8 — a bare lv_obj_create(parent) */
  obj(dst: number): Ins {
    rng("OBJ", "dst", dst, 0, FFSP_MAX_SLOTS - 1);
    return ins("OBJ", OP.OBJ, new ArgWriter("OBJ").u8(dst, "dst").done());
  },

  /** 0x23 BOUNCE slot:u8, base_y:i16, dir:u8.
   *  ⚠️ BOUNCE takes handle[+0x00], never the Even handle itself — that is why the VM stores BOTH
   *  the lv_obj and the handle per slot. Mixing them has already faulted a lens. Table data: the
   *  author names a slot and never sees the indirection. */
  bounce(slot: number, baseY: Num, dir: number): Ins {
    rng("BOUNCE", "slot", slot, 0, FFSP_MAX_SLOTS - 1);
    rngLit("BOUNCE", "base_y", baseY, -0x8000, 0x7fff);
    rng("BOUNCE", "dir", dir, 0, 1);
    const o = new Operands(literalVars, "BOUNCE");
    const w = new ArgWriter("BOUNCE");
    const b = o.n(baseY, VBIT.BOUNCE_BASE_Y, "base_y");
    return ins("BOUNCE", OP.BOUNCE, w.u8(slot, "slot").i16(b, "base_y").u8(dir, "dir").done(), o.vmask);
  },

  /** 0x30 WFCREATE kind:u8, x:i16, cfg[c] — cfg is OPAQUE to the interpreter (c <= 128), which is
   *  what lets layout 4's 117 B with its float[3] and inline char[3][32] ship as-is without the
   *  interpreter ever touching a float.
   *  ⚠️ It returns a STATUS (0 created / -1 fell back), NOT a handle, so it occupies no slot. */
  wfCreate(kind: number, x: Num, cfg: Uint8Array): Ins {
    rng("WFCREATE", "kind", kind, 1, 4, "watchface kinds are 1..4");
    rngLit("WFCREATE", "x", x, -0x8000, 0x7fff);
    if (cfg.length > FFSP_MAX_CFG) {
      throw new Error(`WFCREATE: cfg is ${cfg.length} B; the format caps it at ${FFSP_MAX_CFG} (layout 4's is 117)`);
    }
    if (cfg.length > 0 && cfg[0] !== kind) {
      throw new Error(
        `WFCREATE: cfg[0]=${cfg[0]} but kind=${kind}. cfg[0] IS the kind byte and it selects THEIR ` +
        "validator; a mismatch is \"layoutN create: cfg invalid, return -1 to fallback\", which renders " +
        "as nothing at all — indistinguishable from a dead push.");
    }
    const o = new Operands(literalVars, "WFCREATE");
    const w = new ArgWriter("WFCREATE");
    const xl = o.n(x, VBIT.WFCREATE_X, "x");
    return ins("WFCREATE", OP.WFCREATE, w.u8(kind, "kind").i16(xl, "x").raw(cfg).done(), o.vmask);
  },

  /** 0x31 WFCALL kind:u8, slot:u8, a,b,c,d:i32 — FOUR argument slots, because
   *  set_date(u32,u32,u32,u8) needs four. NULL vtable words are skipped and counted. */
  wfCall(kind: number, vtSlot: number, a: Num, b: Num, c: Num, d: Num): Ins {
    rng("WFCALL", "kind", kind, 1, 4);
    if (vtSlot === 0) {
      throw new Error(
        "WFCALL: vtable slot 0 is create(parent, x, cfg) — it takes a POINTER, and WFCALL only " +
        "carries i32 immediates, so it would hand the layout a bogus parent. Use wfCreate(), which " +
        "builds the cfg buffer properly.");
    }
    rng("WFCALL", "slot", vtSlot, 1, 14,
      "the watchface vtables are FIFTEEN slots (0..14); an earlier note saying six came from dumping " +
      "six words and stopping");
    const o = new Operands(literalVars, "WFCALL");
    const w = new ArgWriter("WFCALL");
    const al = o.n(a, VBIT.WFCALL_A, "a"), bl = o.n(b, VBIT.WFCALL_B, "b");
    const cl = o.n(c, VBIT.WFCALL_C, "c"), dl = o.n(d, VBIT.WFCALL_D, "d");
    return ins("WFCALL", OP.WFCALL, w
      .u8(kind, "kind").u8(vtSlot, "slot")
      .i32(al, "a").i32(bl, "b").i32(cl, "c").i32(dl, "d").done(), o.vmask);
  },

  /** 0x32 DASH base_pos:u8, wcount:u8, order[5]:u8, wf_kind:u8, wf_a/b/c:u32, wf_n:u16,
   *  wf_items:u16 — the v1 FSDB body, minus its magic/version/pads. */
  dash(a: {
    basePos: number; wcount: number; order: readonly number[]; wfKind: number;
    wfA: number; wfB: number; wfC: number; wfN: number; wfItems: number;
  }): Ins {
    const w = new ArgWriter("DASH");
    w.u8(a.basePos, "base_pos").u8(a.wcount, "wcount");
    for (let i = 0; i < 5; i++) w.u8(a.order[i] ?? 0, `order[${i}]`);
    w.u8(a.wfKind, "wf_kind")
      .u32(a.wfA, "wf_a").u32(a.wfB, "wf_b").u32(a.wfC, "wf_c")
      .u16(a.wfN, "wf_n").u16(a.wfItems, "wf_items");
    return ins("DASH", OP.DASH, w.done());
  },

  /** 0x33 LISTEV slot:u8, ev:u8 — ★ common_list_inject_event, the NATIVE scroller, with Even's
   *  own rubber band. Without it a swipe merely lv_obj_set_pos'es the whole list container, which
   *  is not a menu. */
  listEv(slot: number, ev: Num): Ins {
    rng("LISTEV", "slot", slot, 0, FFSP_MAX_SLOTS - 1);
    rngLit("LISTEV", "ev", ev, LISTEV.DOWN, LISTEV.UP, "0 DOWN (index++), 1 UP (index--)");
    const o = new Operands(literalVars, "LISTEV");
    const w = new ArgWriter("LISTEV");
    const e = o.n(ev, VBIT.LISTEV_EV, "ev");
    return ins("LISTEV", OP.LISTEV, w.u8(slot, "slot").u8(e, "ev").done(), o.vmask);
  },

  /** 0x40 PAGE which:u8, rest_pct:u8, anim_ms:u16, prio:u8 — find-or-register.
   *  ⚠️ NOTE THE ABSENT OPERAND: there is NO anim-mode field, and that is deliberate. The resident
   *  VM is parked in the page node at +0x10, which is the fade-anim-ms field — dead ONLY while
   *  anim mode (+0x0a) is 0. A format that let a legal program set the anim mode would let it
   *  destroy its own state: page_anim_run would read a 0x2007xxxx VM pointer as a fade duration.
   *  Our pages are slide-mode forever, enforced by the FORMAT rather than by anybody's memory. */
  page(which: number, restPct: number, animMs: number, prio: number): Ins {
    if (which !== WHICH.OVERLAY && which !== WHICH.BASE) {
      throw new Error(`PAGE: which=${which}; only 0 (overlay 0x0FF5) and 1 (base 0x0FF6) exist, and registration is one-way`);
    }
    rng("PAGE", "rest_pct", restPct, 0, 100);
    const w = new ArgWriter("PAGE");
    return ins("PAGE", OP.PAGE,
      w.u8(which, "which").u8(restPct, "rest_pct").u16(animMs, "anim_ms").u8(prio, "prio").done());
  },

  /** 0x41 SHOW which:u8 */
  show(which: number): Ins {
    rng("SHOW", "which", which, WHICH.OVERLAY, WHICH.BASE);
    return ins("SHOW", OP.SHOW, new ArgWriter("SHOW").u8(which, "which").done());
  },

  /** 0x42 HIDE which:u8 — and the residual dangling-hook hole's checkable answer: the dispatcher
   *  only calls node[0x18] on the ACTIVE page, so a hidden page's hook is unreachable. */
  hide(which: number): Ins {
    rng("HIDE", "which", which, WHICH.OVERLAY, WHICH.BASE);
    return ins("HIDE", OP.HIDE, new ArgWriter("HIDE").u8(which, "which").done());
  },

  /** 0x43 ON class:u8, dev:u8, div:u8, raw:u8, block_len:u16 — the handler block header.
   *  ★ `block_len` COUNTS ONLY THE HANDLER INSTRUCTIONS, NOT THE 9-BYTE ON HEADER (ffs_prog.h §4):
   *  the scan from one ON header to the next is `pc += 9 + block_len`, and the handler's own stream
   *  is the half-open range [pc + 9, pc + 9 + block_len). Like `skip`, it is a forward byte delta
   *  from the post-advance pc. A block that runs past its own `block_len`, or an ON whose
   *  `block_len` runs past `code_len`, is FFSP_ST_LEN — the whole program is refused rather than a
   *  truncated handler executed, because a half-run handler leaves the screen in a state no push
   *  produced. `assemble()` computes this from the encoded body and it is never author-supplied. */
  on(cls: number, dev: number, div: number, raw: number, blockLen: number): Ins {
    if (cls < 0 || cls > ON_CLASS_MAX) throw new Error(`ON: class=${cls} is not one of the ${ON_CLASS_MAX + 1} defined classes`);
    // ★ A SWIPE IS A STREAM: one forward swipe measured 4 DOWNROLLs, one backward 5 UPROLLs, so
    // `div` accumulates in vm->accum[]. div=0 is a DIVIDE-BY-ZERO on the display thread.
    rng("ON", "div", div, 1, 0xff,
      "a swipe is a STREAM, not an event; div=0 would be a divide-by-zero on the display thread");
    if (cls === ON_CLASS.RAW && !RAW_CODES_THAT_CAN_FIRE.has(raw)) {
      throw new Error(
        `ON RAW: code 0x${raw.toString(16)} CAN NEVER FIRE, so it is refused rather than assembled. ` +
        "ffs_hook switches on the LVGL code FIRST and returns for anything outside " +
        "{0x0A TAP, 0x48 DOUBLE, 0x44 UPROLL, 0x45 DOWNROLL, 0x4A RELEASE}, so only those five ever " +
        "reach the ON walk where a RAW match is evaluated. That early return is NORMATIVE: " +
        "ffs_prog.h §4 point 3 says this hook receives EVERY LVGL event on the manager root — " +
        "including the 0x1A/0x1F/0x20/0x21 DRAW STORM — and that the storm \"must cost two compares " +
        "and a return\". ⚠️ A raw handler for e.g. 0x42 used to assemble cleanly, report itself " +
        "installed in ret= bits 18..19, and then never fire — on the HUD indistinguishable from " +
        "\"the gesture does not exist on this hardware\", the same wrong conclusion the longPress() " +
        "throw exists to prevent. RAW is a redundant spelling of the five named classes.");
    }
    if (cls !== ON_CLASS.RAW && raw !== 0) {
      throw new Error(`ON: raw=0x${raw.toString(16)} is only read when class === RAW; the class already names the code, so a stray raw byte is a typo`);
    }
    const w = new ArgWriter("ON");
    return ins("ON", OP.ON,
      w.u8(cls, "class").u8(dev, "dev").u8(div, "div").u8(raw, "raw").u16(blockLen, "block_len").done());
  },

  /** 0x44 PDESC sys_id:u16, field:u8, value:i32 — writes BOTH the .data descriptor AND the live
   *  node, as menu_update_registered_page_anim_time proves is required.
   *  ⛔ REFUSES our own two ids: see `page()` for why touching their anim fields destroys the VM. */
  pdesc(sysId: number, field: number, value: Num): Ins {
    if (sysId === FFSP_PAGE_OVERLAY_ID || sysId === FFSP_PAGE_BASE_ID) {
      throw new Error(
        `PDESC: sys_id 0x${sysId.toString(16).toUpperCase()} is one of OUR pages and is refused by the format. ` +
        "The resident VM lives in that node at +0x10 — the fade-anim-ms field — which is dead only while anim mode is 0; " +
        "page_anim_run would read the VM pointer as a fade duration.");
    }
    if (sysId === 0) throw new Error("PDESC: sys_id 0 is not a page — page_manager_register validates id != 0");
    const o = new Operands(literalVars, "PDESC");
    const w = new ArgWriter("PDESC");
    const v = o.n(value, VBIT.PDESC_VALUE, "value");
    return ins("PDESC", OP.PDESC, w.u16(sysId, "sys_id").u8(field, "field").i32(v, "value").done(), o.vmask);
  },

  /** 0x46 SHOWSYS sys_id:u16 — page_manager_show(mgr, id). Needed because page_manager_ctl ops
   *  1–2 require layer==1 and CANNOT show a base page; restoring the base page is operational
   *  rule #3, and skipping it leaves the HUD blank. */
  showSys(sysId: number): Ins {
    if (sysId === 0) throw new Error("SHOWSYS: sys_id 0 is not a page");
    return ins("SHOWSYS", OP.SHOWSYS, new ArgWriter("SHOWSYS").u16(sysId, "sys_id").done());
  },

  /** 0x70 CALL addr:u32, a,b,c,d:i32 — needs FFSP_FLAG_UNSAFE and an exact fw_build match. */
  call(addr: number, a: number, b: number, c: number, d: number): Ins {
    const u = addr >>> 0;
    if (u < FFSP_CALL_LO || u >= FFSP_CALL_HI) {
      throw new Error(`CALL: addr 0x${u.toString(16)} is outside flash text [0x${FFSP_CALL_LO.toString(16)}, 0x${FFSP_CALL_HI.toString(16)})`);
    }
    if ((u & 1) === 0) {
      throw new Error(`CALL: addr 0x${u.toString(16)} has the thumb bit clear; the interpreter forces addr|1 and refuses anything else with status=DATUM`);
    }
    const w = new ArgWriter("CALL");
    return ins("CALL", OP.CALL,
      w.u32(u, "addr").i32(a, "a").i32(b, "b").i32(c, "c").i32(d, "d").done());
  },

  /** 0x71 WRITE region:u8, off:u16, size:u8, value:u32 */
  write(region: number, off: number, size: number, value: number): Ins {
    checkRegion("WRITE", region, off, size);
    const w = new ArgWriter("WRITE");
    return ins("WRITE", OP.WRITE,
      w.u8(region, "region").u16(off, "off").u8(size, "size").u32(value, "value").done());
  },

  /** 0x72 READ var:u8, region:u8, off:u16, size:u8 */
  read(v: number, region: number, off: number, size: number): Ins {
    rng("READ", "var", v, 0, FFSP_MAX_VARS - 1);
    checkRegion("READ", region, off, size);
    const w = new ArgWriter("READ");
    return ins("READ", OP.READ,
      w.u8(v, "var").u8(region, "region").u16(off, "off").u8(size, "size").done());
  },

  /**
   * ⛔ 0x45 IS RESERVED AND PERMANENTLY UNUSABLE. This function exists ONLY to throw.
   *
   * Long press is intercepted ABOVE the page hook — measured: after a long press our hook stopped
   * seeing input codes at all and began receiving LVGL's own draw events (0x1A/0x1F/0x20/0x21),
   * because the active page had been handed to Even's menu. Route C was tried on hardware the
   * same day and CANNOT capture it either.
   *
   * ★ THE THROW IS THE POINT. Emitting a silent no-op would read on the HUD as "long press does
   * nothing on this hardware", which is a DIFFERENT and WRONG conclusion.
   */
  longPress(): never {
    throw new Error("longPress() is not expressible: " + LONGPRESS_REASON);
  },
} as const;

// ══════════════════════════════════════════════════════════════════════════════════════
// 5. STRINGS
// ══════════════════════════════════════════════════════════════════════════════════════

const utf8 = new TextEncoder();

/**
 * One NUL-terminated wire string.
 *
 * ⚠️ DELIBERATE DEPARTURE FROM v1. `templates.ts::packText` substitutes '?' for every non-ASCII
 * byte (Python's `.encode("ascii","replace")`) and silently truncates at a fixed width. Both are
 * silent divergences — the glasses would render something the author did not ask for and nothing
 * would say so. Here the bytes pass through unchanged and an over-long string THROWS.
 * (Glyph coverage for non-ASCII is not established on this firmware; passing the bytes through is
 * honest, mangling them to '?' is not.)
 */
function wireString(s: string, where: string): Uint8Array {
  const body = utf8.encode(s);
  if (body.length + 1 > FFSP_MAX_STR) {
    throw new Error(`${where}: "${s}" is ${body.length + 1} B with its NUL; FFSP_MAX_STR is ${FFSP_MAX_STR} (NUL included)`);
  }
  const out = new Uint8Array(body.length + 1);
  out.set(body, 0);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 6. WATCHFACE CONFIGS — the one firmware struct layout that lives in TypeScript
//    Stated as a real coupling in design §4, not hidden. WFCREATE calls THEIR validator first,
//    so their parser grades our encoder.
// ══════════════════════════════════════════════════════════════════════════════════════

export interface Face {
  readonly __face: true;
  /** 1 big clock · 2 list face · 3 date+temp · 4 world clocks */
  readonly kind: number;
  /** the opaque cfg bytes WFCREATE ships verbatim */
  readonly cfg: Uint8Array;
  /** the flattened union DASH carries instead (kinds share the same fields, different carrier) */
  readonly dash: { a: number; b: number; c: number; n: number };
  readonly label: string;
}

/**
 * ⚠️ THE cfg SIZE ON THE WIRE IS THE MEANINGFUL EXTENT, NOT A SAFE ALLOCATION SIZE.
 * The probes (`even_wf_place.c`, `even_wf_worldclock.c`) deliberately over-allocated to 64 B and
 * 192 B so that a constructor reading one byte past a short buffer could not be mistaken for a bad
 * address. That over-allocation is the INTERPRETER's job — it mallocs the destination. We ship
 * exactly the documented struct: 8 B for the three-loose-byte kinds, 117 B for layout 4.
 */
const WF_SMALL_CFG = 8;

/** kind 1 — the big two-line clock with two side fields. */
export function bigClock(o: { clock?: number; left?: number; right?: number } = {}): Face {
  const clock = o.clock ?? 0, left = o.left ?? 1, right = o.right ?? 4;
  rangeField("bigClock", "clock", clock, 0, 1);
  rangeField("bigClock", "left", left, 0, 9);
  rangeField("bigClock", "right", right, 0, 9);
  const cfg = new Uint8Array(WF_SMALL_CFG);
  cfg[0] = 1;      // cfg+0 kind — the validator checks it against the vtable it was reached by
  cfg[4] = clock;  // the union body starts at +4 (the validator's own `adds r4,#4`)
  cfg[5] = left;
  cfg[6] = right;
  return { __face: true, kind: 1, cfg, dash: { a: clock, b: left, c: right, n: 0 }, label: "big clock" };
}

/** kind 3 — the compact date / temperature face. */
export function dateTemp(o: { align?: number; date?: boolean; temperature?: boolean } = {}): Face {
  const align = o.align ?? 0;
  const dateEn = o.date === false ? 0 : 1;
  const tempEn = o.temperature === false ? 0 : 1;
  // align maps through 0x005c0eda (1→2, 2→3, else→1) onto LVGL TOP_LEFT/TOP_MID/TOP_RIGHT, i.e.
  // 0=left 1=centre 2=right — the same encoding as base_pos.
  rangeField("dateTemp", "align", align, 0, 2);
  const cfg = new Uint8Array(WF_SMALL_CFG);
  cfg[0] = 3;
  cfg[4] = align;
  cfg[5] = dateEn;
  cfg[6] = tempEn;
  return { __face: true, kind: 3, cfg, dash: { a: align, b: dateEn, c: tempEn, n: 0 }, label: "date+temp" };
}

export interface Zone {
  /** ⚠️ 31 usable chars + NUL — strncpy(...,31) then a forced NUL. Longer is SILENTLY truncated
   *  by the firmware, so it is refused here instead. */
  name: string;
  /** ★ HOURS, AS A FLOAT. layout4_update_clock does `vldr s0` then `roundf(offset * 60.0f)`, so
   *  5.5 is UTC+5:30 — which is exactly what the photographed `DEL 22:50` demonstrated. */
  utc: number;
}

/**
 * kind 4 — the 117-byte `wf4_cfg_t`. ★ PROVEN ON-GLASS 2026-08-10, ret=0x7BC1FF7F.
 *
 * ⛔ THE MAXIMUM IS 3 CLOCKS, NOT 4. `layout4_cfg_validate` does `cmp r0,#4 / blt`;
 * `layout4_update_clock` opens with `if (i >= 3) return`; the module's RAM arrays are 3-sized.
 * A second `layout4_create` does not help either — names, offsets and object pointers are MODULE
 * STATICS, so it overwrites the first.
 *
 * ★ name_count and utc_offset_count are DERIVED here, never taken from the caller: the firmware
 * rejects a three-way mismatch SILENTLY, and a silent rejection is indistinguishable from a dead
 * push on the HUD.
 */
export function worldClock(o: { align?: number; zones: readonly Zone[] }): Face {
  const align = o.align ?? 0;
  rangeField("worldClock", "align", align, 0, 2);
  const zones = o.zones ?? [];
  if (zones.length < 1 || zones.length > 3) {
    throw new Error(
      `worldClock: ${zones.length} zones. The firmware allows 1..3 — layout4_cfg_validate does ` +
      "`cmp r0,#4 / blt`, layout4_update_clock returns for i>=3, and the module's RAM arrays are " +
      "3-sized. A second create does not add clocks either: the names, offsets and object pointers " +
      "are module statics, so it overwrites the first.");
  }

  const cfg = new Uint8Array(117);
  const dv = new DataView(cfg.buffer);
  cfg[0] = 4;                       // cfg+0  kind
  const base = 4;                   // the union body
  cfg[base + 0] = align;            // base+0  align
  cfg[base + 1] = zones.length;     // base+1  world_clock_count
  cfg[base + 2] = zones.length;     // base+2  utc_offset_count — DERIVED, see above
  for (let i = 0; i < zones.length; i++) {
    // base+4  f32[3], little-endian. The interpreter never touches a float; only these bytes do.
    dv.setFloat32(base + 4 + 4 * i, zones[i].utc, true);
  }
  cfg[base + 16] = zones.length;    // base+16 name_count — DERIVED
  for (let i = 0; i < zones.length; i++) {
    // base+17 char[3][32], INLINE arrays and not pointers. `base+17` being ODD is the tell that
    // name_count at base+16 is a u8, not a 16-bit pb_size_t — all three counts are read with ldrb.
    const nm = utf8.encode(zones[i].name);
    if (nm.length > 31) {
      throw new Error(`worldClock: zone name "${zones[i].name}" is ${nm.length} B; the firmware strncpy's 31 and silently truncates, so it is refused here`);
    }
    cfg.set(nm, base + 17 + 32 * i);
  }
  return {
    __face: true, kind: 4, cfg,
    dash: { a: align, b: 0, c: 0, n: zones.length },
    label: "world clocks",
  };
}

/**
 * kind 2 — NOT IMPLEMENTED, and deliberately not guessed.
 *
 * TODO(kind 2): the union's first three bytes are known (align, clock, date_en at base+0..+2, and
 * a list_count <4 with an `items[]` after it), but the OFFSETS of `list_count` and `items[]` are
 * NOT pinned in docs/gui-re/FINDINGS-dashboard-layout.md — only their existence and limits are.
 * Guessing them would produce a cfg their validator accepts and their renderer draws wrong, which
 * is the exact failure mode this SDK exists to prevent. On top of that, **kind 2's `create` has
 * still never rendered on-glass** (kinds 1, 3 and 4 have), so there is no A/B to grade a guess
 * against. Pin the offsets from `0x005bf465` first, then implement.
 */
export function listFace(): never {
  throw new Error(
    "listFace() (watchface kind 2) is not implemented. Its list_count/items[] offsets are not pinned " +
    "in the RE findings — only their limits are — and kind 2's create has never rendered on-glass, " +
    "so a guessed cfg could not even be graded. Derive the offsets from 0x005bf465 first.");
}

function rangeField(where: string, field: string, v: number, lo: number, hi: number): void {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`${where}: ${field}=${v} out of range ${lo}..${hi}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 7. THE AUTHORING SURFACE — widgets
// ══════════════════════════════════════════════════════════════════════════════════════

export type WidgetKind = "text" | "list" | "obj" | "watchface";

export interface Widget {
  readonly __widget: WidgetKind;
  /** the author's name for this thing; the compiler turns it into a slot index */
  readonly id?: string;
  readonly build: (dst: number) => Ins;
  /** watchfaces occupy NO slot — WFCREATE returns a status, not a handle */
  readonly takesSlot: boolean;
  /** watchface kind, for the one-per-kind rule */
  readonly wfKind?: number;
}

export interface BoxStyle {
  /** border WIDTH in px, 0..5 */
  border?: number;
  /** ⚠️ GREY INDEX 0..15, NOT rgb. 16 trips Even's off-by-one straight through to white. */
  borderColor?: number;
  radius?: number;
  pad?: number;
}

/** ★ THE BOX DEFAULTS ARE HEADER DATA NOW — `FFSP_DEF_*`, ffs_prog.h §7, mirrored at the top of
 *  this file. They were two encoders carrying the same table by agreement until 2026-08-11. */

function box(where: string, s: BoxStyle, padDefault: number): { bw: number; bc: number; rad: number; pad: number } {
  // Defaults are v1's (templates.ts::packSlot) as well as the header's, so a screen ported from
  // FFSD looks the same.
  const bw = s.border ?? FFSP_DEF_BORDER_W, bc = s.borderColor ?? FFSP_DEF_BORDER_COLOR;
  const rad = s.radius ?? FFSP_DEF_RADIUS, pad = s.pad ?? padDefault;
  if (!Number.isInteger(bc) || bc < 0 || bc > FFSP_MAX_BORDER_COLOR) {
    throw new Error(
      `${where}: borderColor=${bc}. It is a GREY INDEX 0..${FFSP_MAX_BORDER_COLOR}, not an RGB value — ` +
      "and Even's own clamp has an off-by-one that lets 16 through to \"invalid color_index -> white\", " +
      "so an out-of-range value does not render \"nearly white\", it renders WRONG. " +
      "Refused rather than clamped: v1 clamped with Math.min and that is a silent divergence.");
  }
  rangeField(where, "border", bw, 0, FFSP_MAX_BORDER_W);
  rangeField(where, "radius", rad, 0, FFSP_MAX_RADIUS);
  rangeField(where, "pad", pad, 0, FFSP_MAX_PADDING);
  return { bw, bc, rad, pad };
}

export interface TextSpec extends BoxStyle {
  id?: string;
  x: Num; y: Num; w: Num; h: Num;
  text: string;
  /** text cfg +0x10. Even always writes 1; whether it selects a font is still unproven. */
  font?: number;
}

/**
 * ⚠️ ONE `text()` PER SCREEN. A second `common_text_create` returns NULL — reproduced on a freshly
 * rebooted lens with a clean heap, so it is NOT heap exhaustion. `screen()` throws; it does not
 * silently render one of the two.
 */
export function text(s: TextSpec): Widget {
  const b = box("text()", s, FFSP_DEF_PAD_TEXT);
  const str = wireString(s.text, "text()");
  const font = s.font ?? FFSP_DEF_FONT;
  // ⚠️ NOT a §7 clamp — a tool-level guard, and it is 0..1, matching patch_prog.py. font_manager
  // reports exactly TWO fonts (background/foreground) and Even always writes 1. Whether cfg+0x10
  // actually selects between them is still open (the `fontab` A/B). This used to accept 0..255,
  // i.e. it accepted 200 values with no evidence behind any of them and let the firmware index
  // whatever that byte indexes.
  rangeField("text()", "font", font, 0, 1);
  return {
    __widget: "text", id: s.id, takesSlot: true,
    build: (dst) => Op.text({ dst, x: s.x, y: s.y, w: s.w, h: s.h, ...b, font, str }),
  };
}

export interface ListSpec extends BoxStyle {
  id?: string;
  x: Num; y: Num; w: Num; h: Num;
  items: readonly string[];
}

/** A native list — Even's own scroller, focus highlight and rubber band, driven by LISTEV. */
export function list(s: ListSpec): Widget {
  const b = box("list()", s, FFSP_DEF_PAD_LIST);
  const n = s.items.length;
  if (n < 1 || n > FFSP_MAX_ITEMS) {
    throw new Error(
      `list(): ${n} items — ⚠️ THE BOUND THAT BIT HERE IS FFSP_MAX_ITEMS (${FFSP_MAX_ITEMS}), not the ` +
      `u8 \`len\` (which caps a LIST at ${255 - LIST_FIXED_ARGS} B of strings). common_list_create returns ` +
      `NULL on 0 or >${FFSP_MAX_ITEMS}, and a NULL there is a SILENT NO-DRAW that looks EXACTLY like a ` +
      "broken push — nothing on the HUD and nothing in ret= to tell the two apart. Refused here so " +
      "the failure has a reason.");
  }
  const items = concat(s.items.map((it, i) => wireString(it, `list() item ${i}`)));
  // Eagerly, so the throw lands where the author wrote the list rather than at assemble() time.
  // ⚠️ See Op.list: §7's item/string limits exceed what §2's u8 `len` can encode.
  Op.list({ dst: 0, x: 0, y: 0, w: 0, h: 0, ...b, n, items });
  return {
    __widget: "list", id: s.id, takesSlot: true,
    build: (dst) => Op.list({ dst, x: s.x, y: s.y, w: s.w, h: s.h, ...b, n, items }),
  };
}

/** A bare lv_obj_create(parent) — a container to parent or style. */
export function obj(s: { id?: string } = {}): Widget {
  return { __widget: "obj", id: s.id, takesSlot: true, build: (dst) => Op.obj(dst) };
}

/**
 * One of Even's real watchfaces, at ANY x.
 *
 * ★ Their own layout engine can never produce this: it computes ONE watchface at one of exactly
 * three x values (0 / 188 / 376). Two designs at 40 and 336 on one screen is proven on-glass
 * (ret=0x7A805F0F, photographed).
 *
 * ⚠️ A directly-placed watchface is a FROZEN SNAPSHOT. Nothing ticks it — only Even's own manager
 * calls set_time on a schedule — so the time it shows is the time you pushed. Use `wfCall()` to
 * advance it, or Even's dashboard (`dashboard()`) if you want it to run itself.
 */
export function watchface(s: { x: Num; face: Face }): Widget {
  return {
    __widget: "watchface", takesSlot: false, wfKind: s.face.kind,
    build: () => Op.wfCreate(s.face.kind, s.x, s.face.cfg),
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 8. THE AUTHORING SURFACE — actions (what happens on a gesture)
// ══════════════════════════════════════════════════════════════════════════════════════

/** What a lowering action can ask the compiler for. */
export interface LowerCtx {
  /** slot index for an author id — throws if the screen never declared it */
  slot(id: string | number): number;
  /** var index for an author name — allocated on first use */
  varIndex(name: string | number): number;
}

export type Action = (ctx: LowerCtx) => Ins[];

/**
 * ★ THE INVERSION IS HIDDEN HERE AND NOWHERE ELSE.
 * `listNext` lowers to `LISTEV slot, 0` (DOWN) and `listPrev` to `LISTEV slot, 1` (UP) — and
 * UP DECREMENTS. The author never sees it; it is table data in ffs_prog.h, not folklore.
 */
export function listNext(id: string | number): Action {
  return (ctx) => [Op.listEv(ctx.slot(id), LISTEV.DOWN)];
}
export function listPrev(id: string | number): Action {
  return (ctx) => [Op.listEv(ctx.slot(id), LISTEV.UP)];
}

/** An EMIT source, for `readback()` — and the thing `set()` refuses. */
export interface Source {
  readonly __src: number;
  readonly slotId?: string | number;
  readonly varName?: string | number;
  readonly index?: number;
  readonly label: string;
}
/** Even's own focus index for a list slot (`hnd[slot] + 0x5c`). */
export function listFocus(id: string | number): Source {
  return { __src: EMIT_SRC.LISTFOCUS, slotId: id, label: `listFocus(${String(id)})` };
}
/** The item count the firmware ACTUALLY built (`hnd[slot] + 0x58`) — content, not a pointer. */
export function listCount(id: string | number): Source {
  return { __src: EMIT_SRC.LISTCOUNT, slotId: id, label: `listCount(${String(id)})` };
}
export function evtCount(): Source {
  return { __src: EMIT_SRC.EVT_N, label: "evtCount()" };
}
/** `evtCode()` with no argument means THE LAST EVENT (arg 0xFF). */
export function evtCode(index: number = FFSP_EVT_LAST): Source {
  return { __src: EMIT_SRC.EVT_CODE, index, label: `evtCode(${index === FFSP_EVT_LAST ? "last" : index})` };
}
export function evtDev(index: number = FFSP_EVT_LAST): Source {
  return { __src: EMIT_SRC.EVT_DEV, index, label: `evtDev(${index === FFSP_EVT_LAST ? "last" : index})` };
}
export function varOf(name: string | number): Source {
  return { __src: EMIT_SRC.VAR, varName: name, label: `varOf(${String(name)})` };
}
export function vmGeneration(): Source {
  return { __src: EMIT_SRC.GEN, label: "vmGeneration()" };
}
export function vmStatus(): Source {
  return { __src: EMIT_SRC.STATUS, label: "vmStatus()" };
}
/** ★ THE ROUND-TRIP ECHO SOURCE — the only check that proves the header scalars are read. */
export function programLength(): Source {
  return { __src: EMIT_SRC.CODE_LEN, label: "programLength()" };
}
export function skippedCount(): Source {
  return { __src: EMIT_SRC.SKIPPED, label: "skippedCount()" };
}
export function slotKind(id: string | number): Source {
  return { __src: EMIT_SRC.SLOTKIND, slotId: id, label: `slotKind(${String(id)})` };
}
function isSource(v: unknown): v is Source {
  return typeof v === "object" && v !== null && "__src" in (v as object);
}

/** A `Source`'s `arg` byte, resolved against the lowering context. ★ ONE RESOLUTION SHARED BY
 *  `set()`'s LOAD AND `readback()`'s EMIT, because the two opcodes read the same source enum:
 *  a list source names a SLOT, `varOf` names a VAR, an event source carries an INDEX. */
function sourceArg(s: Source, ctx: LowerCtx): number {
  if (s.slotId !== undefined) return ctx.slot(s.slotId);
  if (s.varName !== undefined) return ctx.varIndex(s.varName);
  if (s.index !== undefined) return s.index;
  return 0;
}

/**
 * `set(name, value)` — write a resident variable, from an IMMEDIATE or from a FIRMWARE READING.
 *
 * ```ts
 * tap: [ set("sel", listFocus("menu")), notify(1) ]   // design §4(c), verbatim
 * ```
 *
 * ★ THE AUTHOR MUST NOT HAVE TO KNOW WHICH OPCODE THEY GOT. `set(name, 42)` lowers to `SET`
 * (var:u8, imm:i16); `set(name, listFocus("menu"))` lowers to `LOAD` (var:u8, src:u8, arg:u8) with
 * EMIT's source enum. Same surface, two encodings, chosen here.
 *
 * ⚠️ THIS USED TO THROW, and the throw was correct at the time: SET's operand is an i16 immediate
 * (or, via the vmask, another var), and ABI 1 as first frozen had NO opcode that moved a firmware
 * reading into `var[]` — EMIT reads `hnd[slot]+0x5c` but ORs it into the RESULT MASK, which a
 * handler has no channel to return. So design §6's `ON TAP { SET var0 <- listFocus(1) }` described
 * an instruction that did not exist, and the only way to learn the focus was the next readback
 * push. `0x07 LOAD` was added to ffs_prog.h for exactly this, which is why a screen can now
 * REMEMBER what the user selected.
 */
export function set(name: string | number, value: Num | Source): Action {
  if (isSource(value)) {
    return (ctx) => [Op.load(ctx.varIndex(name), value.__src, sourceArg(value, ctx))];
  }
  return (ctx) => [Op.set(ctx.varIndex(name), resolveNum(value, ctx))];
}

/** `add(name, delta, {lo, hi, wrap})` — bounded arithmetic on a resident variable. */
export function add(
  name: string | number,
  delta: Num,
  o: { lo?: number; hi?: number; wrap?: boolean } = {},
): Action {
  return (ctx) => [Op.add(
    ctx.varIndex(name), resolveNum(delta, ctx),
    o.lo ?? 0, o.hi ?? 0x7fff, o.wrap ? ADD_MODE.WRAP : ADD_MODE.CLAMP,
  )];
}

/**
 * The variable `notify()` writes — ★ `FFSP_NOTIFY_VAR`, AND IT IS IN THE HEADER NOW.
 *
 * It was a convention the two encoders invented and had to agree on by hand; ffs_prog.h §2 names it
 * ("By convention the TOP variable is the phone-visible notify slot… Naming it here stops the two
 * encoders picking different ones — which they already did once, var0 vs var15, before it had a
 * name"). This is now a mirror of that constant, not a second definition of it. There is still no
 * NOTIFY opcode: `notify(n)` lowers to a plain `SET var15, n`, i.e. zero new wire shapes.
 */
export const NOTIFY_VAR = FFSP_NOTIFY_VAR;

/**
 * `notify(n)` — set the bit the phone polls.
 *
 * ⚠️ Named honestly: this does NOT send anything. `tap` CANNOT open another screen on-glass;
 * navigation is a BLE round trip. Scrolling stays native (that is what LISTEV is for); BRANCHING
 * does not. Multi-screen on-glass needs a resident program store, i.e. a flash.
 */
export function notify(n: number): Action {
  return () => [Op.set(NOTIFY_VAR, n)];
}

export function move(id: string | number, x: Num, y: Num): Action {
  return (ctx) => [Op.move(ctx.slot(id), resolveNum(x, ctx), resolveNum(y, ctx))];
}
export function size(id: string | number, w: Num, h: Num): Action {
  return (ctx) => [Op.size(ctx.slot(id), resolveNum(w, ctx), resolveNum(h, ctx))];
}
export function style(id: string | number | typeof FFSP_SLOT_PARENT, prop: number, value: Num): Action {
  return (ctx) => [Op.style(
    id === FFSP_SLOT_PARENT ? FFSP_SLOT_PARENT : ctx.slot(id as string | number),
    prop, resolveNum(value, ctx),
  )];
}
export function flag(id: string | number, flagBits: number, on: boolean | Num): Action {
  return (ctx) => [Op.flag(ctx.slot(id), flagBits, typeof on === "boolean" ? (on ? 1 : 0) : resolveNum(on, ctx))];
}
/** bounce_animation_play, with a NULL done_cb — firmware-owned animation, the only kind that is
 *  actually NATIVE. ⛔ NO TIMERS, EVER, FROM A PROGRAM: a dangling lv_timer is strictly worse than
 *  a dangling hook, because nothing re-points it and LVGL calls into freed heap on its own clock. */
export function bounce(id: string | number, baseY: Num, dir = 0): Action {
  return (ctx) => [Op.bounce(ctx.slot(id), resolveNum(baseY, ctx), dir)];
}
export function show(which: number = WHICH.OVERLAY): Action {
  return () => [Op.show(which)];
}
export function hide(which: number = WHICH.OVERLAY): Action {
  return () => [Op.hide(which)];
}
export function showSys(sysId: number): Action {
  return () => [Op.showSys(sysId)];
}
/** Escape hatch: put an already-encoded instruction in a handler. Still allowlist-checked. */
export function inlineOp(i: Ins): Action {
  return () => [i];
}

function resolveNum(v: Num, ctx: LowerCtx): Num {
  return isVarRef(v) ? varRef(ctx.varIndex(v.__varRef)) : v;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 9. THE PROGRAM
// ══════════════════════════════════════════════════════════════════════════════════════

export interface HandlerBlock {
  readonly cls: number;
  readonly dev: number;
  readonly div: number;
  readonly raw: number;
  readonly body: readonly Ins[];
}

export interface Program {
  readonly __program: true;
  /** the draw pass — everything before `draw_end` */
  readonly draw: readonly Ins[];
  /** the ON regions — everything after it */
  readonly blocks: readonly HandlerBlock[];
  readonly flags: number;
  /** author id → slot index, so a later readback push can name the same list */
  readonly slots: Readonly<Record<string, number>>;
  /** author name → var index. ⚠️ vm->var[] is RESIDENT: two programs must agree on this map. */
  readonly vars: Readonly<Record<string, number>>;
}

export type Dev = "left" | "right" | "ring" | "any" | number;
function devByte(d: Dev | undefined): number {
  if (d === undefined || d === "any") return DEV.ANY;
  if (d === "left") return DEV.LEFT;
  if (d === "right") return DEV.RIGHT;
  if (d === "ring") return DEV.RING;
  if (typeof d === "number") return d;
  throw new Error(`dev "${String(d)}" is not left/right/ring/any or a raw device byte`);
}

export type HandlerSpec =
  | Action
  | readonly Action[]
  | { dev?: Dev; div?: number; do: Action | readonly Action[] };

export interface Handlers {
  tap?: HandlerSpec;
  double?: HandlerSpec;
  /** DOWNROLL 0x45 — swipe toward the LENSES. ⚠️ inverted from intuition. */
  scrollFwd?: HandlerSpec;
  /** UPROLL 0x44 — swipe toward the EAR. */
  scrollBack?: HandlerSpec;
  /** ★ RELEASE PRECEDES EVERY DISCRETE GESTURE. The hook DROPS 0x4A unless an ON RELEASE block
   *  exists, so anything counting taps counts them right without knowing why. Declare this only
   *  if you actually want the lift. */
  release?: HandlerSpec;
  /**
   * The `raw` byte carries the literal LVGL code.
   *
   * ⛔ ONLY THE FIVE CODES THE HOOK ALREADY SWITCHES ON CAN EVER FIRE — 0x0A, 0x48, 0x44, 0x45,
   * 0x4A — so `raw` is a redundant spelling of the five named classes and anything else is
   * REFUSED. This used to say "for anything outside the five classes", which is precisely the set
   * that cannot work: `ffs_hook` returns before the ON walk for every other code, because
   * ffs_prog.h §4 point 3 requires the 0x1A/0x1F/0x20/0x21 draw storm to cost "two compares and a
   * return". A raw handler for 0x42 assembled cleanly, reported itself installed in `ret=`
   * bits 18..19, and never fired.
   */
  raw?: ReadonlyArray<{ code: number; dev?: Dev; div?: number; do: Action | readonly Action[] }>;
}

const CLASS_OF_KEY: Readonly<Record<string, number>> = {
  tap: ON_CLASS.TAP,
  double: ON_CLASS.DOUBLE,
  scrollFwd: ON_CLASS.SCROLL_FWD,
  scrollBack: ON_CLASS.SCROLL_BACK,
  release: ON_CLASS.RELEASE,
};

function defaultDiv(cls: number): number {
  return cls === ON_CLASS.SCROLL_FWD || cls === ON_CLASS.SCROLL_BACK
    ? DIV_DEFAULT_SCROLL
    : DIV_DEFAULT_TAP;
}

// ── the lowering context ──────────────────────────────────────────────────────────────

class Ctx implements LowerCtx {
  readonly slotMap = new Map<string, number>();
  readonly varMap = new Map<string, number>();
  private nextVar = 0;

  constructor(pinned?: Readonly<Record<string, number>>) {
    if (pinned) {
      for (const [k, v] of Object.entries(pinned)) {
        if (!Number.isInteger(v) || v < 0 || v >= FFSP_MAX_VARS) {
          throw new Error(`vars: "${k}" pinned to ${v}; the VM has ${FFSP_MAX_VARS} variables`);
        }
        this.varMap.set(k, v);
      }
    }
  }

  declareSlot(id: string | undefined, index: number): void {
    if (id === undefined) return;
    if (this.slotMap.has(id)) throw new Error(`two widgets share the id "${id}"; ids name slots and must be unique`);
    this.slotMap.set(id, index);
  }

  slot(id: string | number): number {
    if (typeof id === "number") {
      if (!Number.isInteger(id) || id < 0 || id >= FFSP_MAX_SLOTS) {
        throw new Error(`slot ${id} is outside 0..${FFSP_MAX_SLOTS - 1}`);
      }
      return id;
    }
    const s = this.slotMap.get(id);
    if (s === undefined) {
      const known = [...this.slotMap.keys()].map((k) => `"${k}"`).join(", ") || "none";
      throw new Error(`no widget with id "${id}" in this screen (declared: ${known})`);
    }
    return s;
  }

  varIndex(name: string | number): number {
    if (typeof name === "number") {
      if (!Number.isInteger(name) || name < 0 || name >= FFSP_MAX_VARS) {
        throw new Error(`var ${name} is outside 0..${FFSP_MAX_VARS - 1}`);
      }
      return name;
    }
    const existing = this.varMap.get(name);
    if (existing !== undefined) return existing;
    // Allocate in first-use order, skipping anything already pinned and NOTIFY_VAR.
    const taken = new Set(this.varMap.values());
    taken.add(NOTIFY_VAR);
    while (taken.has(this.nextVar)) this.nextVar++;
    if (this.nextVar >= FFSP_MAX_VARS) {
      throw new Error(`out of variables: the VM has ${FFSP_MAX_VARS} (var 15 is reserved for notify())`);
    }
    this.varMap.set(name, this.nextVar);
    return this.nextVar++;
  }

  record(): Record<string, number> {
    return Object.fromEntries(this.varMap);
  }
}

function runActions(spec: Action | readonly Action[], ctx: LowerCtx): Ins[] {
  const list = typeof spec === "function" ? [spec] : spec;
  const out: Ins[] = [];
  for (const a of list) out.push(...a(ctx));
  return out;
}

/** Handlers run on the display thread. Enforce the allowlist and the budget, with the reason. */
function checkHandler(cls: number, body: readonly Ins[]): void {
  if (body.length > FFSP_HANDLER_BUDGET) {
    throw new Error(
      `handler for ON class ${cls} has ${body.length} instructions; the budget is ${FFSP_HANDLER_BUDGET}. ` +
      "Handlers run ON THE DISPLAY THREAD inside lv_obj_send_event — a long one stutters the UI and a " +
      "faulting one takes the lens.");
  }
  for (const i of body) {
    if (HANDLER_ALLOWED.has(i.op)) continue;
    const why = HANDLER_FORBIDDEN_REASON[i.op] ?? "it is not on FFSP_OP_ALLOWED_IN_HANDLER";
    throw new Error(`${i.name} is forbidden inside a handler: ${why}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 10. screen() — what a developer types
// ══════════════════════════════════════════════════════════════════════════════════════

export interface ScreenOptions {
  /** "overlay" = page 0x0FF5 on layer 1. "base" = 0x0FF6 on layer 0, visible_default=1 — ★ Route
   *  B, which IS the "replace Even's launcher" configuration and the standing decision. */
  page?: "overlay" | "base";
  on?: Handlers;
  /** Adopt the slots a previous push left resident instead of clearing. Sets FFSP_FLAG_KEEP and
   *  omits the CLEAR instruction. */
  keep?: boolean;
  restPct?: number;
  animMs?: number;
  prio?: number;
  /** Pin var indices, so this program and its readback push agree. See `Program.vars`. */
  vars?: Readonly<Record<string, number>>;
  /** Unlock CALL/WRITE/READ. Also needs an EXACT fw_build match on the glasses. */
  unsafe?: boolean;
}

/**
 * A screen: widgets drawn by the firmware, plus handlers the glasses run themselves.
 *
 * ```ts
 * screen(
 *   [ text({ id: "title", x: 40, y: 18, w: 496, h: 46, text: "FFS OS", border: 2, radius: 10, pad: 6 }),
 *     list({ id: "menu",  x: 40, y: 78, w: 496, h: 150, items: ["CLOCK","CAMERA","SETTINGS"],
 *            border: 2, radius: 10, pad: 8 }) ],
 *   { page: "overlay",
 *     on: { scrollFwd: listNext("menu"), scrollBack: listPrev("menu"), tap: notify(1) } },
 * )
 * ```
 *
 * The emitted draw pass, in this order and for these reasons:
 *   NEED(PAGEMGR)  — ⚠️ the power-cycle gate, before anything touches the manager
 *   PAGE           — find-or-register; ONE-WAY, which is why only two ids exist
 *   PARENT         — our page root
 *   STYLE parent BG_OPA=0 — ⚠️ the FUT-198 guard: without it the root is a filled bright
 *                    rectangle over the whole HUD (the green-screen, photographed once)
 *   CLEAR          — clean + zero slots + gen++, never separable
 *   the widgets    — in declaration order; slot indices assigned here
 *   SHOW           — activate
 *   END            — draw_end
 */
export function screen(widgets: readonly Widget[], opts: ScreenOptions = {}): Program {
  for (const w of widgets) {
    if ((w as unknown as { __program?: true }).__program) {
      throw new Error(
        "dashboard() cannot be composed into screen(). dashboard_page_create is a WHOLE-SCREEN " +
        "TAKEOVER that drives the same module globals WFCREATE uses, so the two cannot coexist in " +
        "one push. Push the dashboard on its own.");
    }
    if (!(w as Widget).__widget) throw new Error("screen() takes widgets — text(), list(), obj() or watchface()");
  }

  const texts = widgets.filter((w) => w.__widget === "text").length;
  if (texts > 1) {
    throw new Error(
      `screen() has ${texts} text() widgets. ⚠️ ONE common_text_create AT A TIME: the second returns ` +
      "NULL, reproduced on a freshly rebooted lens with a clean heap, so it is not heap exhaustion. " +
      "Refused rather than silently rendering the first — which is what v1 did, and it reported " +
      "\"constructor returned NULL\" in a bit nobody read.");
  }

  const wfKinds = new Set<number>();
  for (const w of widgets) {
    if (w.__widget !== "watchface") continue;
    const k = w.wfKind as number;
    if (wfKinds.has(k)) {
      throw new Error(
        `screen() has two watchfaces of kind ${k}. Layout modules keep their objects, names and ` +
        "offsets in MODULE STATICS, not per-instance, so a second create of the same kind SILENTLY " +
        "OVERWRITES the first. Max one per kind, four kinds.");
    }
    wfKinds.add(k);
  }

  const which = opts.page === "base" ? WHICH.BASE : WHICH.OVERLAY;
  const parentTarget = which === WHICH.BASE ? PARENT_TARGET.BASE : PARENT_TARGET.OVERLAY;
  const ctx = new Ctx(opts.vars);

  const draw: Ins[] = [
    Op.need(NEED.PAGEMGR),
    Op.page(which, opts.restPct ?? 100, opts.animMs ?? 120, opts.prio ?? 255),
    Op.parent(parentTarget),
    Op.style(FFSP_SLOT_PARENT, STYLE_PROP.BG_OPA, 0),
  ];
  if (!opts.keep) draw.push(Op.clear());

  let nextSlot = 0;
  for (const w of widgets) {
    if (!w.takesSlot) { draw.push(w.build(-1)); continue; }
    if (nextSlot >= FFSP_MAX_SLOTS) {
      throw new Error(`more than ${FFSP_MAX_SLOTS} slotted widgets; the resident VM has ${FFSP_MAX_SLOTS} slots`);
    }
    ctx.declareSlot(w.id, nextSlot);
    draw.push(w.build(nextSlot));
    nextSlot++;
  }
  draw.push(Op.show(which));
  // ★ END terminates the DRAW REGION, and `patch_prog.py::demo_slice1` emits it too — the two
  // encoders must agree, because `draw_end` is the boundary the hook scans from and the value
  // recorded in `vm->bind_off`, so a 3-byte disagreement means the same authored screen produces
  // two different `bind_off`s and no golden can validate both. It is kept (rather than dropped to
  // match design §6's listing) because ffs_prog.c's own built-in default template carries one at
  // draw_end=98, and because a truncated tail then decodes as END rather than as whatever follows.
  // ⚠️ IT IS *NOT* ABOUT ret= BIT 23. This file used to claim "an explicit END is what makes bit
  // 23 ('reached the end') mean something" — that is FALSE for this interpreter: ffs_prog.c sets
  // FFSP_R_END unconditionally after a clean draw pass, whether the pass ran off draw_end or hit
  // END, and its own comment says "bit 23 must not be read as 'an END opcode executed'".
  draw.push(Op.end());

  const blocks = lowerHandlers(opts.on, ctx);

  let flags = 0;
  if (opts.keep) flags |= FFSP_FLAG.KEEP;
  if (opts.unsafe) flags |= FFSP_FLAG.UNSAFE;

  return {
    __program: true, draw, blocks, flags,
    slots: Object.fromEntries(ctx.slotMap),
    vars: ctx.record(),
  };
}

/**
 * ON blocks are emitted in the author's key order — the order the `on:` object literal was
 * written. Deterministic (JS preserves string-key insertion order) and it is what a reader
 * expects when comparing a program against docs/SDK-V2-DESIGN.md §6's listing.
 */
function lowerHandlers(on: Handlers | undefined, ctx: Ctx): HandlerBlock[] {
  if (!on) return [];
  const blocks: HandlerBlock[] = [];
  for (const key of Object.keys(on) as Array<keyof Handlers>) {
    const spec = on[key];
    if (spec === undefined) continue;
    if (key === "raw") {
      for (const r of spec as NonNullable<Handlers["raw"]>) {
        const body = runActions(r.do, ctx);
        checkHandler(ON_CLASS.RAW, body);
        // Validate EAGERLY, so the throw lands where the author wrote the handler rather than at
        // assemble() time. Op.on() re-checks — the encoder is the door that must not be bypassed.
        Op.on(ON_CLASS.RAW, devByte(r.dev), r.div ?? DIV_DEFAULT_TAP, r.code, 0);
        blocks.push({
          cls: ON_CLASS.RAW, dev: devByte(r.dev),
          div: r.div ?? DIV_DEFAULT_TAP, raw: r.code, body,
        });
      }
      continue;
    }
    const cls = CLASS_OF_KEY[key];
    if (cls === undefined) throw new Error(`on: unknown handler "${String(key)}"`);
    const h = spec as HandlerSpec;
    const wrapped = typeof h === "object" && h !== null && "do" in h
      ? h as { dev?: Dev; div?: number; do: Action | readonly Action[] }
      : { do: h as Action | readonly Action[] };
    const body = runActions(wrapped.do, ctx);
    checkHandler(cls, body);
    blocks.push({
      cls, dev: devByte(wrapped.dev), div: wrapped.div ?? defaultDiv(cls), raw: 0, body,
    });
  }
  return blocks;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 11. dashboard() — Even's real dashboard, our configuration
// ══════════════════════════════════════════════════════════════════════════════════════

export type BasePos = "left" | "centre" | "center" | "right" | number;
function basePosByte(p: BasePos): number {
  if (typeof p === "number") return p;
  if (p === "left") return 0;
  if (p === "centre" || p === "center") return 1;
  if (p === "right") return 2;
  throw new Error(`basePos "${String(p)}" is not left/centre/right`);
}

export interface DashboardOptions {
  /** where the watchface sits; the widget column takes the other side */
  basePos: BasePos;
  /** widget types 0..4, up to 5; only the first `widgetCount` are read by the firmware */
  widgets?: readonly number[];
  /** defaults to `widgets.length` */
  widgetCount?: number;
  face: Face;
  /** DASH's second u16. ⚠️ Its meaning is NOT documented in ffs_prog.h — it occupies v1 FSDB's
   *  `_rsv` slot. Left 0 unless you know what you are doing; reported to the header's owner. */
  wfItems?: number;
}

/**
 * Even's own dashboard, reconfigured. `NEED(DASH)` + one `DASH` + `END`.
 *
 * ⛔ CANNOT BE COMPOSED WITH screen(). `dashboard_page_create` is a whole-screen takeover driving
 * the same module globals WFCREATE uses. That is why this returns a whole Program and not a
 * widget: the type system refuses the composition before the builder has to.
 */
export function dashboard(o: DashboardOptions): Program {
  const basePos = basePosByte(o.basePos);
  const order = [...(o.widgets ?? [])];
  const widgetCount = o.widgetCount ?? order.length;
  while (order.length < 5) order.push(0);

  // ★ ONE validator for the firmware's dashboard limits, shared with v1 rather than re-typed.
  // A descriptor the firmware rejects falls back to the STOCK dashboard, which on the HUD is
  // INDISTINGUISHABLE from "the push did nothing" — so client-side refusal is the whole point.
  const asV1: DashConfig = {
    basePos, widgetCount, widgetOrder: order.slice(0, 5),
    kind: o.face.kind,
    wf: [o.face.dash.a, o.face.dash.b, o.face.dash.c],
    n: o.face.dash.n,
  };
  const bad = validateDashConfig(asV1);
  if (bad) throw new Error(`dashboard(): ${bad}`);

  const draw: Ins[] = [
    Op.need(NEED.DASH),
    Op.dash({
      basePos, wcount: widgetCount, order: order.slice(0, 5), wfKind: o.face.kind,
      wfA: o.face.dash.a, wfB: o.face.dash.b, wfC: o.face.dash.c,
      wfN: o.face.dash.n, wfItems: o.wfItems ?? 0,
    }),
    Op.end(),
  ];
  return { __program: true, draw, blocks: [], flags: 0, slots: {}, vars: {} };
}

/** apply_geo restated, so a push can be graded against a number decided BEFORE it was sent. */
export function dashboardGeometry(o: { basePos: BasePos; widgetCount: number }): { watchfaceX: number; widgetColX: number } {
  const bp = basePosByte(o.basePos);
  if (o.widgetCount === 0) return { watchfaceX: [0, 188, 376][bp] ?? 0, widgetColX: 0 };
  return bp === 2 ? { watchfaceX: 376, widgetColX: 0 } : { watchfaceX: 0, widgetColX: 224 };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 12. park() and readback()
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * ★ MANDATORY BEFORE ANY NON-FFSP PUSH. 12 bytes: HIDE overlay + SHOWSYS + END.
 *
 * The residual dangling-hook hole is a non-FFSP payload pushed while our page is active — and it
 * has a CHECKABLE answer rather than a rule you have to remember: the dispatcher only calls
 * `node[0x18]` on `page_manager_get_active_page(mgr)`, so a HIDDEN page's hook is UNREACHABLE.
 * `ret=` bit 14 clearing is the verification that it worked.
 *
 * It also satisfies operational rule #3 — ⚠️ a cleanup must restore the BASE page, not just hide
 * the overlay, or the HUD goes blank. `sysId` defaults to Even's own base page.
 *
 * Carries FFSP_FLAG_KEEP: parking must not clear the slots it is standing down from.
 */
export function park(o: { sysId?: number } = {}): Program {
  return {
    __program: true,
    draw: [Op.hide(WHICH.OVERLAY), Op.showSys(o.sysId ?? 1), Op.end()],
    blocks: [], flags: FFSP_FLAG.KEEP, slots: {}, vars: {},
  };
}

export interface ReadbackField {
  readonly source: Source;
  readonly shift: number;
  readonly width: number;
}
export function field(source: Source, shift: number, width: number): ReadbackField {
  return { source, shift, width };
}

/**
 * The readback push — tag 0x7F, and ★ THE WHOLE 24 BITS ARE DATA with no status bits.
 *
 * ⚠️ THAT IS DELIBERATE AND IT IS A LESSON PAID FOR. ffs_gesture_wizard's first reader packed two
 * 12-bit fields at bits 8 and 20 of a 24-bit mask; the second overflowed past bit 23 and was
 * silently truncated by the `& 0x00FFFFFF` on the way out, so EVERY odd-indexed event decoded as
 * code 0x00 — a stream of alternating "real event, code 0x00" that looked plausible rather than
 * obviously broken. So this refuses shift+width > 24, and refuses OVERLAPPING fields too, because
 * EMIT ORs and an overlap is the same silent corruption one bit further in.
 *
 * Carries FFSP_FLAG_KEEP: a readback must ADOPT the resident slots, never clear the screen it is
 * reading. Without KEEP the push that reads the focus index would wipe the list first.
 */
export function readback(
  fields: readonly ReadbackField[],
  opts: { slots?: Readonly<Record<string, number>>; vars?: Readonly<Record<string, number>> } = {},
): Program {
  const ctx = new Ctx(opts.vars);
  if (opts.slots) for (const [k, v] of Object.entries(opts.slots)) ctx.slotMap.set(k, v);

  const used: number[] = [];
  const draw: Ins[] = [];
  for (const f of fields) {
    if (!Number.isInteger(f.width) || f.width < 1 || f.width > 24) {
      throw new Error(`readback: ${f.source.label} width=${f.width}; 1..24`);
    }
    if (!Number.isInteger(f.shift) || f.shift < 0) {
      throw new Error(`readback: ${f.source.label} shift=${f.shift}`);
    }
    if (f.shift + f.width > 24) {
      throw new Error(
        `readback: ${f.source.label} occupies bits ${f.shift}..${f.shift + f.width - 1}, past bit 23. ` +
        "The result mask is 24 bits and the loader ANDs 0x00FFFFFF on the way out — an over-wide " +
        "field is SILENTLY TRUNCATED, which is exactly how ffs_gesture_wizard decoded every " +
        "odd-indexed event as code 0x00.");
    }
    for (let b = f.shift; b < f.shift + f.width; b++) {
      if (used.includes(b)) {
        throw new Error(`readback: ${f.source.label} overlaps another field at bit ${b}; EMIT ORs, so an overlap silently corrupts both`);
      }
      used.push(b);
    }
    // ★ The same resolution `set()` uses for LOAD — one source enum, one arg space per source.
    draw.push(Op.emit(f.source.__src, sourceArg(f.source, ctx), f.shift, f.width));
  }
  draw.push(Op.end());
  return {
    __program: true, draw, blocks: [],
    flags: FFSP_FLAG.READBACK | FFSP_FLAG.KEEP,
    slots: opts.slots ? { ...opts.slots } : {},
    vars: ctx.record(),
  };
}

/**
 * ★ THE DISTINCTIVE `code_len` THE ECHO PADS TO — `0x0555` = `0000 0101 0101 0101`.
 *
 * ⚠️ THE ALTERNATING BITS ARE THE POINT, not decoration. `patch_prog.py`'s own docstring says why:
 * "a folded, masked or truncated readback is visible AT A GLANCE rather than needing a diff", and
 * `0x7F000555` as a whole `ret=` word is unmistakable. `echoProgram()` used to be the bare 10-byte
 * EMIT+END, so the expected word was `0x7F00000A` — and 10 is far harder to tell apart from a
 * partially folded or byte-truncated readback than 0x0555 is. Whatever CI actually pushes, both
 * tools must agree on the expected word.
 */
export const ECHO_LEN_DEFAULT = 0x0555;

/**
 * `total` bytes of OPTIONAL, SKIPPABLE instruction, byte-identical to `patch_prog.py::_filler`.
 *
 * Op `0x7F` is NOT an allocated opcode and its bit 7 is CLEAR, so it is optional: any conforming
 * interpreter skips it with the zero-knowledge rule `pc += 3 + len` and counts it in
 * `FFSP_EMIT_SKIPPED`. Using a well-formed skippable instruction rather than raw zero padding
 * means the echo program stays valid even for an interpreter that walks past END to `draw_end`.
 */
function fillerRun(total: number): Ins[] {
  const out: Ins[] = [];
  if (total === 0) return out;
  if (total < 3) throw new Error(`cannot fill ${total} B: an instruction is at least 3 B`);
  let left = total;
  while (left > 0) {
    // 258 = 3 + a full u8 `len`. The middle case avoids leaving a 1- or 2-byte remainder.
    const take = left <= 258 ? left : (left - 258 >= 3 ? 258 : left - 3);
    out.push(ins("FILLER", 0x7f, new Uint8Array(take - 3)));
    left -= take;
  }
  return out;
}

/**
 * ★ THE CI ROUND-TRIP ECHO. `EMIT src=CODE_LEN shift=0 width=16` + END, padded to a DISTINCTIVE
 * `code_len` with skippable filler that lives after the END.
 *
 * The only check that proves the header scalars are actually READ. Measured on this box: deleting
 * the pointer barrier from a 2 KB-hole interpreter left the magic present and the array intact and
 * shrank .text by 78 bytes, because clang folded the magic/abi/code_len COMPARES into constants.
 * So the v1 rule "check the built blob contains its magic" WOULD HAVE PASSED on a blob whose
 * header was dead. Patch a distinctive `code_len`, run this, require the value back in `ret=`.
 *
 * ⛔ CI FAILS IF THE VALUE DOES NOT COME BACK. Not "warns" — fails. A green build with a folded
 * header ships an SDK whose entire header is decoration, and every later status bit is then
 * reporting on constants baked in at compile time.
 */
export function echoProgram(codeLen: number = ECHO_LEN_DEFAULT): Program {
  const base = readback([field(programLength(), 0, 16)]);
  const fixed = runLength(base.draw);          // EMIT + END = 10 B
  if (codeLen === fixed) return base;
  if (codeLen < fixed) throw new Error(`echoProgram: codeLen must be >= ${fixed} (the EMIT + END themselves)`);
  if (codeLen > FFSP_PROG_CAP) throw new Error(`echoProgram: codeLen must be <= FFSP_PROG_CAP (${FFSP_PROG_CAP})`);
  if (codeLen - fixed < 3) {
    throw new Error(
      `echoProgram: codeLen ${codeLen} leaves ${codeLen - fixed} B of padding; an instruction is at ` +
      `least 3 B. Use exactly ${fixed} or >= ${fixed + 3}.`);
  }
  return { ...base, draw: [...base.draw, ...fillerRun(codeLen - fixed)] };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 13. assemble() — the compiler's output
// ══════════════════════════════════════════════════════════════════════════════════════

export interface Assembled {
  /** code[0 .. code_len) — exactly what the CRC covers */
  readonly code: Uint8Array;
  readonly codeLen: number;
  /** where the draw pass stops and the ON blocks begin; also the VM's `bind_off` */
  readonly drawEnd: number;
  readonly crc: number;
  readonly flags: number;
  /** the 16-byte ffsp_prog_t header */
  readonly header: Uint8Array;
  /** header + code, i.e. the used prefix of the patchable object */
  readonly image: Uint8Array;
  /** the WHOLE 2064-byte ffsp_prog_t, zero-padded — what patchTemplate() overwrites */
  readonly object: Uint8Array;
  readonly slots: Readonly<Record<string, number>>;
  readonly vars: Readonly<Record<string, number>>;
}

export function assemble(p: Program): Assembled {
  if ((p.flags & FFSP_FLAG.RESERVED) !== 0) {
    throw new Error(`flags 0x${p.flags.toString(16)} sets a reserved bit (3..15); the interpreter refuses with status=MAGIC`);
  }
  if ((p.flags & FFSP_FLAG.UNSAFE) === 0) {
    for (const i of p.draw) {
      if (i.op === OP.CALL || i.op === OP.WRITE || i.op === OP.READ) {
        throw new Error(
          `${i.name} needs FFSP_FLAG_UNSAFE (and an EXACT fw_build match on the glasses); the ` +
          "interpreter refuses it with status=DATUM otherwise. Pass { unsafe: true }.");
      }
    }
  }

  // ⛔ CLEAR IS ONLY EVER LEGAL ON A ROOT WE OWN — ffs_prog.h §3, which the interpreter enforces
  // with FFSP_ST_DATUM. The draw pass STARTS at lv_layer_top so that a program with no PARENT still
  // has somewhere legal to draw — but lv_layer_top is the parent of EVERY page root, ours and
  // Even's. So the two-instruction, format-legal program `PARENT 0; CLEAR` deletes every page root
  // on the top layer, and since page registration is ONE-WAY, `node[+0x04]` then holds a dangling
  // pointer that NOTHING CAN REPAIR UNTIL REBOOT — and the very next push's reuse path calls
  // lv_obj_set_size on it. Refused here first, with the reason; LAYER_TOP stays legal for DRAWING.
  {
    let parentNow: number = PARENT_TARGET.LAYER_TOP;
    for (const i of p.draw) {
      if (i.op === OP.PARENT) { parentNow = i.args[0]; continue; }
      if (i.op !== OP.CLEAR) continue;
      if (parentNow !== PARENT_TARGET.OVERLAY && parentNow !== PARENT_TARGET.BASE) {
        throw new Error(
          "CLEAR under PARENT lv_layer_top: the interpreter refuses this with status=DATUM. " +
          "lv_layer_top is the parent of EVERY page root, ours and Even's, so `PARENT 0; CLEAR` is " +
          "lv_obj_clean() over all of them — and page registration is ONE-WAY, so node[+0x04] is " +
          "then a dangling pointer nothing can repair until reboot, which the next push's reuse " +
          "path hands to lv_obj_set_size. CLEAR is legal only on our overlay (1) or base (2) root; " +
          "lv_layer_top remains legal for DRAWING.");
      }
    }
  }

  const chunks: Uint8Array[] = p.draw.map(insBytes);
  const drawEnd = runLength(p.draw);

  for (const b of p.blocks) {
    const bodyBytes = b.body.map(insBytes);
    const blockLen = runLength(b.body);
    chunks.push(insBytes(Op.on(b.cls, b.dev, b.div, b.raw, blockLen)));
    chunks.push(...bodyBytes);
  }

  const code = concat(chunks);
  if (code.length > FFSP_PROG_CAP) {
    throw new Error(
      `program is ${code.length} B of code[]; the hole holds ${FFSP_PROG_CAP}. ` +
      "Split it, or drop widgets — the interpreter PRINTS its built size so the budget is measured, not assumed.");
  }
  const crc = crc16(code);

  const header = new Uint8Array(FFSP_HDR_SIZE);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, FFSP_MAGIC, true);
  header[4] = FFSP_ABI;
  header[5] = FFSP_SYMGEN;
  dv.setUint16(6, FFSP_FW_BUILD, true);
  dv.setUint16(8, code.length, true);
  dv.setUint16(10, crc, true);
  dv.setUint16(12, drawEnd, true);
  dv.setUint16(14, p.flags, true);

  const image = concat([header, code]);
  const object = new Uint8Array(FFSP_PROG_SIZE);
  object.set(image, 0);

  return {
    code, codeLen: code.length, drawEnd, crc, flags: p.flags,
    header, image, object, slots: p.slots, vars: p.vars,
  };
}

/**
 * Program → patched template → FXP1 frame → base64, ready for `FfsBle.pushPayloadViaImage`.
 *
 * ⚠️ The template is passed in rather than imported: `templates.generated.ts` does not carry an
 * FFSP interpreter yet (the g2flash side ships it), and importing a symbol that does not exist
 * would break every other test in this directory. When `TEMPLATE_PROG` lands, pass it here.
 * `patchTemplate` re-finds the descriptor BY MAGIC — never by the offset baked in at generation
 * time, which moves whenever the interpreter's code size changes.
 */
export function buildProgramPush(tpl: PayloadTemplate, p: Program): string {
  if (tpl.magic !== FFSP_MAGIC) {
    throw new Error(
      `template "${tpl.id}" carries magic 0x${tpl.magic.toString(16)}, not FFSP 0x${FFSP_MAGIC.toString(16)} — ` +
      "refusing to patch a v1 descriptor with a v2 program.");
  }
  return patchTemplate(tpl, assemble(p).object);
}
