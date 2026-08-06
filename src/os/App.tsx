// FFS Glasses OS — launcher / home shell (FUT-163).
//
// The real app entry (index.ts points here). Our OWN stack end-to-end, NO @mentra:
//   useFfsBluetooth (driver session) → useConnectionSupervisor (health + reclaim-on-ready)
//   → PhoneNav (on-glass phone-OS navigation) → screenOwner (paints via FfsBle.showText/Image).
//
// The star is ON THE GLASSES: a stock-phone-style OS (status bar + app menu + nested
// screens) you drive entirely by touchpad — swipe up/down to move, tap to open, double-tap
// to go back. The phone screen here is just a connection dashboard + a couple of debug
// controls (Home / Back / snap a photo) — everything real happens on the HUD.
//
// FUT-220 UX pass — this is a DENSE single-page control surface ON PURPOSE (Yoni: "keep
// every probe/debug control visible, optimise for speed not safety"). Nothing is hidden
// behind a Developer section and no confirm ceremony was added. What changed is
// SCANNABILITY, so the right control is found and fired fast:
//   • status pinned outside the scroll — link state never scrolls away
//   • flash progress pinned + a real bar (was a 13px Menlo line during a ~5-min brick window)
//   • the nine near-identical green flash buttons became a data-driven row list with a
//     coloured badge per image, a plain-language name, and a WRITES / no-writes tag
// Patterns lifted from real shipped apps via the Mobbin MCP — see FUT-220 for the refs.

import { StatusBar } from "expo-status-bar";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import FfsBle, { toNavGesture } from "../../modules/ffs-ble";
import { theme } from "./theme";
import Constants from "expo-constants";
import CalibrationScreen from "./calibration/CalibrationScreen";
import { initLoggerCore, glog } from "./log";
import { useFfsBluetooth } from "./useFfsBluetooth";
import { useConnectionSupervisor, healthLabel, type ConnectionHealth } from "./connection";
import { screenOwner } from "./reclaim";
import { PhoneNav, type PhoneCtx } from "./phone/nav";
import { homeScreen, textTestScreen, setTextTestContent } from "./phone/screens";
import { Group, Progress, Row, SectionLabel } from "./ui";
import { GENERATED_PAYLOADS } from "./payloads.generated";

// Read the REAL shipped version rather than a hand-maintained copy. A hardcoded
// "0.11.1" had drifted three releases behind app.json, so telemetry reported the
// wrong build — which is actively dangerous: reading a log and believing it came
// from a build it didn't come from sends every diagnosis in the wrong direction.
// (FUT-233, 2026-07-28: a log said 0.11.1 while 0.11.4 was installed.)
const APP_VERSION = (Constants.expoConfig?.version ?? "unknown") as string;

// FUT-167 Stage 2 — CFW + stock-restore images (hosted on the private slsrc server, NOT
// bundled: this repo is public and the firmware is Even's copyrighted image). Downloaded
// + SHA-verified natively before any write.
const CFW_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_cfw.bin";
const CFW_SHA = "5c1539fd39c599e6035f6a8ec0779ba687c250d342a24c21a39952fed6c56aa0";
const STOCK_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_stock.bin";
const STOCK_SHA = "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa";
// FUT-167 canary — Even's EXACT stock 2.2.6.10 with ONLY the reported firmware-version
// string changed 2.2.6.10 → 2.2.6.77 (10 rodata literals, length-preserving, checksums
// recomputed; bootloader byte-identical, validate PASS). The safe FIRST real flash: if it
// boots, "Read battery + firmware version" shows 2.2.6.77 → the write→commit→reboot→readback
// loop is proven on-hardware, with a payload that is behaviorally stock. Restore Stock reverts.
const CANARY_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_canary.bin";
const CANARY_SHA = "67759cd67ed7031d7b4c8a613b8b0fe9dc9bd51c11e82260c35f5bc807159b5e";
// FUT-188 "fontpeek" — the shipped CFW + one injected READ that appends the XIP font-slot-0
// header (127 B from 0x80100000) to the sid=0x09 device-info response. After flashing, tap
// "Read battery + firmware version" and the font header shows on the firmware-L version line
// as ⟨FONT0=…hex…⟩ → gives us the s200_font.bin format ground-truth for native Hebrew. Pure
// read, no new flash-write behavior; Restore Stock reverts. Same golden-vector safety gate.
const FONTPEEK_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_fontpeek.bin";
const FONTPEEK_SHA = "70332b9822806a546e028ffb1b88b49a44593fe88236a3daa70866185acbb4f0";
// FUT-179 NATIVE HEBREW — staged flash (do these IN ORDER).
// Stage 1 (BIDI-ONLY, FUT-190): RTL reorder only, NO glyph changes. Flash this first and
// check normal English/Chinese text still renders correctly — it isolates the shared
// label-draw hook's blast radius before Hebrew is added. Hebrew won't appear yet.
const HEBREW_BIDI_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_bidi_only.bin";
const HEBREW_BIDI_SHA = "33404e1977aa7d1abaeedfb34a64f1b81e470b6ea818a1d21f61a0187ca5be1c";
// Stage 2 (FULL, FUT-189+190): bidi + Hebrew glyphs (embedded TTF via the FreeType-cache
// requester hook). This is the one that renders Hebrew, correctly ordered, system-wide.
const HEBREW_FULL_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_hebrew_full.bin";
const HEBREW_FULL_SHA = "45a481fc13b3cb864a9c6b63a4c428c248ab1f3a8ab770715b71965bad09ed5f";
// FUT-191 — Hebrew v2 + font probe: full-coverage Hebrew (gershayim/geresh/shekel/
// presentation forms; no niqqud) + a diagnostic that logs the scalable font names the
// firmware opens (read back via "Read battery + firmware version"). Supersedes the FULL
// build above. Flash this, browse the UI, then do the firmware-version read.
const HEBREW_PROBE_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_hebrew_probe.bin";
const HEBREW_PROBE_SHA = "39ea04a2964c443a1434310d929d64cf22c24ef908255f0f8d07a4b01e72cbfd";
// FUT-197 — FFS UI probe (ALWAYS-ON): Hebrew-full CFW + our OWN native-LVGL element via CFW.
// A styled rounded box AUTO-SHOWS on the home HUD (no gesture) whose child label LIVE-TICKS
// an MM:SS counter (1 Hz, driven by a firmware lv_timer armed at boot). First on-glass proof
// that our own native UI renders + live-updates firmware-side with zero phone — the de-risk
// step before owning the idle screen (FUT-195 Phase B).
const FFSUI_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_ffsui.bin";
const FFSUI_SHA = "3a673c966658216ecbb9397d65682e8131ea4465f8915c941250985f8368d8ce";
// FUT-214 — RAM-exec probe: the "flash-once, push-forever" de-risk build. After flashing,
// tap "Read battery + firmware version": the CFW runs a RAM-exec test and returns the result
// on the firmware-L line as ⟨RAMEXEC RX01 EXEC_OK ret=0x2A …⟩ (ret==0x2A => pushing native
// code into RAM and running it WORKS — green light for the resident OTA loader).
const RAMEXEC_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_ramexec.bin";
const RAMEXEC_SHA = "913a7f28cc79957ed8a5991c7434d993583070fc3d369b6c6a9e1683fd6f3f86";
// FUT-216 — resident OTA loader ("flash-once, push-forever"). Flash ONCE (inert, no seize —
// glasses behave normally) then tap Push Payload A / B to change on-glass UI OVER THE AIR with
// NO reflash. Loader status shows on the device-info read as ⟨LOADER LD01 gen=… ret=0x…⟩.
const LOADER_URL = "https://slsrc.x36.site/fw/g2_2.2.6.10_loader.bin";
// FUT-217: no gesture hooks (left touchpad); FUT-216: dispatch probe (logs service keys → svc[]).
const LOADER_SHA = "373bfe9aa3645f1cda5b0204df1db3516e16347f31dcc9a39846442022c43103";
// FUT-246 — the SAME loader rebased onto stock 2.2.7.14, which is what Yoni's glasses now run.
// Every payload in payloads.generated.ts is built against THIS base; pushing them at the
// 2.2.6.10 loader above would branch into unrelated code. Also carries the FUT-244 pair:
// loader body-CRC (a corrupt frame is refused as LD04 instead of being executed) and the
// ffs_ui_patch prop-id migration. ⚠️ The payload frame gained an 8-byte CRC header, so app
// and firmware MUST ship together — an old app against this loader is refused rej_code=4.
const LOADER_2_2_7_14_URL = "https://slsrc.x36.site/fw/g2_2.2.7.14_loader.bin";
const LOADER_2_2_7_14_SHA = "7ecf5f4948e510469cc85cd77c1a291e67bf78800f93a40cb918cf5f326eb9a6";
// Stock 2.2.7.14, kept as the restore-to-stock escape hatch for the current base.
const STOCK_2_2_7_14_URL = "https://slsrc.x36.site/fw/g2_2.2.7.14_stock.bin";
const STOCK_2_2_7_14_SHA = "0fced0aebcc6c88db6f76dba34f91b805d842a5fc297bfd7fa6d6a34ec83cecb";
const CFW_SERVICE = 0x90; // custom CFW loader BLE service id
// FUT-238 — STYLE PROPS ORACLE (one tap, one answer). Runs the firmware's OWN
// lv_style_set_* thunks, then asks lv_style_set_prop whether the prop it wrote is the
// id we claim: an id already held is OVERWRITTEN (prop_cnt unchanged), an id not held is
// APPENDED (prop_cnt+1). prop_cnt's struct offset is DISCOVERED at runtime, not assumed.
// Returns a bitmask on the firmware-L line as ret=0x……  Decode (full table on FUT-238):
//   0x5B18FFFD / 0x5B18FFFE = ✅ full PASS (layout A / layout B) — the recovered v9.3.0 map is right
//   0x5B1F000D = 🔴 the OLD numbering was right; 0x5B00000D = thunk addresses wrong
//   0x5BE10000 / 0x5BE00000 = oracle couldn't run (bad struct layout / no layer_top)
// It should ALSO draw a rounded outlined box with legible "FUT238 OK" mid-HUD — the
// semantic proof, because the same intent under the OLD ids rendered an invisible label
// (FUT-197). Built from payloads/payload_style_props.c, blob 2420 B,
// sha256 8b035cdb…49143a, + the 4-byte FXP1 magic = 2424 B on the wire.
const PAYLOAD_STYLE_PROPS_B64 =
  "RlhQMS3p8E+DsE/2v0GCRgAmwPJEAQAgxfbhNohH4LNE9tNJBEbA8kcJICDIRwAoAPCehAdGQvZpCAAgwPJICDhweHC4cPhwOHF4cbhx+HE4cnhyuHL4cjhzeHO4c/hzOHR4dLh0+HQ4dXh1uHX4dTh2eHa4dvh2OHd4d7h3+Hc4RgwhESLARzh5CCgJ0Th6ASgG0QEnCCUN4Kb1gDYA8Ge8OHoIKEDwY4Q4ewEoQPBfhAInDCUgIMhHYLMAIQFwQXCBcMFwAXFBcYFxwXEBckFygXLBcgFzQXOBc8FzAXRBdIF0wXQBdUF1gXXBdQF2QXaBdsF2AXdBd4F3wXcMIQEiBkbARzBGDCECIsBHcF0BKAi/BDcgIMhHYLMAIQFwQXCBcMFwAXFBcYFxwXEBckFygXLBcgFzQXOBc8FzAXRBdIF0wXQBdUF1gXXBdQF2QXaBdsF2AXdBd4F3wXcMIQEiBkbARzBGHSECIsBHcF0CKAi/CDdE9iEbICDA8k0LyEeIswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/WUcjBGACGQR3BdASgH0TBGWiEiIsBHcF0BKAi/EDcgIMhHeLMGRgAgMHBwcLBw8HAwcXBxsHHwcTBycHKwcvByMHNwc7Bz8HMwdHB0sHTwdDB1cHWwdfB1MHZwdrB28HYwd3B3sHfwdzBGACHYR3BdASgH0TBGMCEiIsBHcF0BKAi/IDcgIMhHiLMGRgAgMHBwcLBw8HAwcXBxsHHwcTBycHKwcvByMHNwc7Bz8HMwdHB0sHTwdDB1cHWwdfB1MHZwdrB28HYwd3B3sHfwd6vxDgIwRgAhkEdwXQEoB9EwRjIhIiLAR3BdASgIv0A3ICDIR4izBkYAIDBwcHCwcPBwMHFwcbBx8HEwcnBysHLwcjBzcHOwc/BzMHRwdLB08HQwdXB1sHXwdTB2cHawdvB2MHdwd7B38Her8VwCMEYAIZBHcF0BKAfRMEYdISIiwEdwXQEoCL+ANyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/WncjBGACGQR3BdASgI0TBGDCEiIsBHcF0BKAi/B/WAdyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3q/G+AjBGACGQR3BdASgI0TBGECEiIsBHcF0BKAi/B/UAdyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/HaAjBGACGQR3BdASgI0TBGUCEiIsBHcF0BKAi/B/WAZyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/G0AjBGACGQR3BdASgI0TBGSCEiIsBHcF0BKAi/B/UAZyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/WacjBGACGQR3BdASgI0TBGXCEiIsBHcF0BKAi/B/WAVyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3q/E0AjBGACGQR3BdASgI0TBGKCEiIsBHcF0BKAi/B/UAVyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/WHcjBGACGQR3BdASgI0TBGWCEiIsBHcF0BKAi/B/WARyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3q/EoAjBGACGQR3BdASgI0TBGMSEiIsBHcF0BKAi/B/UARyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/WUcjBGACGQR3BdASgI0TBGMiEiIsBHcF0BKAi/B/WANyAgyEeQswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3C/WHcjBGACGQR3BdASgI0TBGMCEiIsBHcF0BKAi/B/UANyAgyEeAswZGACAwcHBwsHDwcDBxcHGwcfBxMHJwcrBy8HIwc3BzsHPwczB0cHSwdPB0MHVwdbB18HUwdnB2sHbwdjB3cHewd/B3MEYAIdhHcF0BKAjRMEYoISIiwEdwXQEoCL8H9YAnRPLcYMLyBwAGaE32g2HA8kMBIEYALhi/B/WAF4hHACgA8MOAT/LBQ0v2GxtP8psEwPJDA0/0lnFaIgVGwPJEC8DyQwTK+AAAmEcoRoohYyKgRyAgyEfIswAhAXBBcIFwwXABcUFxgXHBcQFyQXKBcsFyAXNBc4FzwXMBdEF0gXTBdAF1QXWBdcF1AXZBdoF2wXYBd0F3gXfBdx0hACIERsBHIEYwIQMiwEcgRjIh/yLARyBGMSFv8H9CwEcgRgwhDCLARyhGIUYAIthH2kZJ8hdLwPJJCyhG2EcAKGXQBEYgIMhHmLMFRgAgKHBocKhw6HAocWhxqHHocShyaHKocuhyKHNoc6hz6HModGh0qHTodCh1aHWodeh1KHZodqh26HYod2h3qHfodx6xKEZaITJGwEcoRlghb/B/QsBHKEZZIf8iwEcgRilGACLQR0YgjfgCAFUgjfgDAFQgjfgEADIgjfgFADMgjfgGADggjfgHACAgjfgIAE8gjfgJAEsgjfgKAAAgjfgLAAvxGAIN8QIBIEaQR0/ymwMgRhQhHiLA8kMDmEdH9AAnB/G2RjBGA7C96PCP";
// ── The 26 pushable payloads now come from GENERATED DATA ──────────────────────
// FUT-228: these used to be 26 hand-pasted base64 literals with no record of what
// produced them. They now live in ./payloads.generated.ts, emitted by
//   cd ~/Downloads/g2cfw/g2flash && ./tools/ffs-sdk gen
// from g2flash/payloads/manifest.json (source .c + exact -D flags per variant).
// The generator reproduces the previously-shipped strings BYTE-EXACT — that 26-way
// comparison is the migration's regression test (tools/ffs_sdk/tests/test_parity.py).
// The notes below are kept because they explain what each payload DOES; only the
// base64 moved. The FUT238 STYLE PROBE above is deliberately still a literal: it is
// published and load-bearing, so it is not regenerated.

// Demo payloads = "FXP1" magic + a compiled PIC blob (payload_main draws a bordered box +
// label on lv_layer_top). Pushing B after A visibly replaces A. (patches/payloads/payload_*.c)
//   -> ffs-sdk id "PAYLOAD_A_B64"
//   -> ffs-sdk id "PAYLOAD_B_B64"
// FUT-234 — THE FIRST ANIMATION. A box slides left→right across the HUD, 3× over 4.5 s,
// driven by the firmware's own lv_anim engine (lv_anim_init → set_values → lv_anim_start)
// with a custom exec_cb living inside the payload itself. Even's SDK has no animation
// primitive at all, so this is capability we have and they structurally cannot offer.
// Source: g2flash/payloads/payload_anim.c. Verified by disassembly before first push —
// notably +0x20 (path_cb, a CODE POINTER whose corruption reboots the glasses) is never
// written; lv_anim_init installs lv_anim_path_linear there.
//   -> ffs-sdk id "PAYLOAD_ANIM_B64"

// FUT-234 crash bisect. payload_anim (above) crashed the glasses: right lens blank ~15-20 s,
// then a watchdog reboot of both. The three lv_anim addresses have since been VERIFIED GENUINE
// by disassembly against a known-good control, so a bad address is NOT the cause. These two
// stages split what's left. Source: g2flash/payloads/payload_anim_bisect.c
//   AN1 — box + lv_anim_init + set_values + all field writes, but NO lv_anim_start. Nothing is
//         ever ticked. Answers: does our payload render AT ALL?  (returns 0xB1)
//   AN2 — AN1 + lv_anim_start with a NO-OP exec_cb. The engine ticks and calls into our RAM
//         blob 60x/s, touching nothing. Answers: do the engine + a callback into our resident
//         payload survive?  (returns 0xB2)
// AN1 crashes → not the animation at all. AN1 ok, AN2 crashes → calling our RAM blob from the
// tick. Both ok → the per-frame lv_obj_set_pos redraw is the culprit.
//   -> ffs-sdk id "PAYLOAD_AN1_B64"
//   -> ffs-sdk id "PAYLOAD_AN2_B64"

// FUT-232 — THE GENERIC WIDGET DOOR. Constructs lv_arc, a widget Even's own firmware
// NEVER creates ("orphan" in g2fw.h), via lv_obj_class_create_obj + lv_obj_class_init_obj.
// LVGL v9's create is TWO calls — allocate, then run the constructor chain; we only had
// the first until class_init_obj was resolved 2026-07-28. If this works, ~25 widgets open.
// Proof is STRUCTURAL, not visual (lv_layer_top has no theme, so appearance is unreliable):
// the payload reads back obj->class_p (+0x00) and reports via the loader's ret=
//   0xC7 = arc constructed AND class verified   0xE1 = create returned NULL
//   0xE2 = created but class_p mismatch (our class table is wrong)   0xE0 = no layer_top
// Source: g2flash/payloads/payload_widget.c
//   -> ffs-sdk id "PAYLOAD_WIDGET_B64"

// FUT-232 sweep — ALL 22 ORPHAN widget classes in one push. Each is created via the
// generic door, its obj->class_p verified, then immediately DELETED (so nothing is ever
// drawn and nothing accumulates). Result is a 32-bit BITMASK in the loader's ret=:
//   ret = 0x5A?????? where the low 22 bits are the widgets that constructed + verified.
//   bit0=arc(CONTROL, must be set) 1=slider 2=switch 3=checkbox 4=led 5=line 6=scale
//   7=spinner 8=spinbox 9=table 10=textarea 11=chart 12=menu 13=menu_page 14=menu_cont
//   15=menu_section 16=tabview 17=win 18=keyboard 19=calendar 20=cal_hdr_arrow 21=cal_hdr_drop
// A visible arc is left behind. Source: g2flash/payloads/payload_widgets_all.c
//   -> ffs-sdk id "PAYLOAD_WIDGETS_ALL_B64"

// FUT-232 bisect ladder — the full 22-widget sweep HARDFAULTED (no ret at all), so a
// prefix ladder finds the culprit. Each returns the 0x5A|mask for the first N widgets,
// so a passing rung is not just a bisect step, it PROVES those N widgets.
//   -> ffs-sdk id "PAYLOAD_WA12_B64"

//   -> ffs-sdk id "PAYLOAD_WA16_B64"

//   -> ffs-sdk id "PAYLOAD_WA18_B64"

//   -> ffs-sdk id "PAYLOAD_WA20_B64"

// FUT-232 menu bisect — W12 returned 0x5A000FFF (bits 0-11 ALL set: 12 widgets proven,
// control included) and W16 crashed, so the fault is in bits 12-15, the menu family.
// These rungs isolate which one, and MND separates constructor vs destructor.
//   -> ffs-sdk id "PAYLOAD_WA_13_B64"

//   -> ffs-sdk id "PAYLOAD_WA_14_B64"

//   -> ffs-sdk id "PAYLOAD_WA_15_B64"

//   -> ffs-sdk id "PAYLOAD_WA_MENUND_B64"

// FUT-232 upper range — M13 returned 0x5A001FFF (13 widgets incl. lv_menu) and W16
// crashed, so the fault is in bits 13-15. -DFROM lets us probe bits 16-21 WITHOUT
// touching the menu family, so a bad index in the middle can't mask everything above.
//   -> ffs-sdk id "PAYLOAD_WA_U16_B64"

//   -> ffs-sdk id "PAYLOAD_WA_U16B_B64"

// FUT-232 narrow range probes. Confirmed: bit 13 (lv_menu_page) crashes — M13 (bits
// 0-12) passed and M14 (bits 0-13) did not. And U16 (bits 16-21, which skips the menu
// family entirely) ALSO crashed, so there is a SECOND independent crasher up there.
// These probes isolate each remaining suspect without any known-bad index in the way.
//   -> ffs-sdk id "PAYLOAD_WA_P14_B64"

//   -> ffs-sdk id "PAYLOAD_WA_P16_B64"

//   -> ffs-sdk id "PAYLOAD_WA_P18_B64"

//   -> ffs-sdk id "PAYLOAD_WA_P19_B64"

// FUT-232 endgame. 17 of 22 proven: bits 0-12 (M13), 14-15 (R14 0xC000), 16 (R16),
// 18 (R18). Remaining: 13 menu_page (confirmed crasher), 17 win (never tested alone),
// and 19-21 calendar (R19 crashed, so >=1 of the three is bad). Single-bit probes.
//   -> ffs-sdk id "PAYLOAD_WA_S17_B64"

//   -> ffs-sdk id "PAYLOAD_WA_S19_B64"

//   -> ffs-sdk id "PAYLOAD_WA_S20_B64"

//   -> ffs-sdk id "PAYLOAD_WA_S21_B64"

//   -> ffs-sdk id "PAYLOAD_WA_S13_B64"


const WARRANTY_PHRASE = "my warranty is void";

// FUT-167 soft precheck — a self-attested readiness checklist that must be
// acknowledged (AND the warranty phrase) before a real flash arms. Right-sized to
// the ACTUAL risk: Yoni's clean on-face official flash proved the battery-brick
// vector is minor (near-zero power), so the battery floor is a SOFT self-confirm,
// not a device read. The real risk is BLE dropping across the ~5-min window, so the
// high-value items are stay-close / stay-foregrounded / screen-on. Items are user
// attestations (the app does not read battery or hold a wake-lock — those are
// offered later follow-ups), so the wording claims nothing the app doesn't enforce.
const PRECHECK_ITEMS: string[] = [
  "Glasses are charged (≥25% — soft floor; near-zero power flash, so just insurance)",
  "Phone stays within ~1 m of the glasses the whole time — I won't walk away (~5 min)",
  "I'll keep this app open + foregrounded and my screen ON so it won't lock mid-flash",
  "Glasses are stable/worn and won't be handled or moved during the flash",
];

// FUT-220 — the flashable images as DATA, not nine copy-pasted Pressables. Order is the
// order you'd actually run them. `badge`/`tint` group by family (baseline / Hebrew / FFS OS
// / full CFW / revert) so a row is identifiable at a glance; risk lives in the tag, not the
// colour. Every image that was reachable before is still reachable here — nothing removed.
type FwImage = {
  key: string;
  badge: string;
  tint: string;
  name: string;
  desc: string;
  trace: string;
  url: string;
  sha: string;
};

const FW_IMAGES: FwImage[] = [
  {
    key: "loader27",
    badge: "LD7",
    tint: theme.tint.green,
    name: "OTA loader 2.2.7.14 — FLASH THIS ONE",
    desc: "Rebased onto the stock firmware you're actually running. Flash once, then push payloads forever. After it reboots, read device info — an ⟨LD04⟩ record means the rebase is correct.",
    trace: "FUT-246",
    url: LOADER_2_2_7_14_URL,
    sha: LOADER_2_2_7_14_SHA,
  },
  {
    key: "stock27",
    badge: "S7",
    tint: theme.tint.blue,
    name: "Restore stock 2.2.7.14",
    desc: "Unmodified Even firmware for the current base — the escape hatch. Verified md5 against Even's own CDN.",
    trace: "FUT-246",
    url: STOCK_2_2_7_14_URL,
    sha: STOCK_2_2_7_14_SHA,
  },
  {
    key: "canary",
    badge: "CN",
    tint: theme.tint.blue,
    name: "Canary — do this first",
    desc: "Stock + version marker → 2.2.6.77. Proves write→commit→reboot→readback on hardware.",
    trace: "FUT-167",
    url: CANARY_URL,
    sha: CANARY_SHA,
  },
  {
    key: "fontpeek",
    badge: "FP",
    tint: theme.tint.purple,
    name: "Font-peek",
    desc: "Adds a font-header read. Flash, then tap Read device info → ⟨FONT0=…⟩.",
    trace: "FUT-188",
    url: FONTPEEK_URL,
    sha: FONTPEEK_SHA,
  },
  {
    key: "bidi",
    badge: "he1",
    tint: theme.tint.amber,
    name: "Hebrew ① — BIDI only",
    desc: "RTL reorder, no glyph changes. Check English/Chinese still render.",
    trace: "FUT-190",
    url: HEBREW_BIDI_URL,
    sha: HEBREW_BIDI_SHA,
  },
  {
    key: "hebfull",
    badge: "he2",
    tint: theme.tint.amber,
    name: "Hebrew ② — full",
    desc: "bidi + glyphs. This is the one that actually renders Hebrew, system-wide.",
    trace: "FUT-189",
    url: HEBREW_FULL_URL,
    sha: HEBREW_FULL_SHA,
  },
  {
    key: "hebprobe",
    badge: "heV",
    tint: theme.tint.amber,
    name: "Hebrew v2 + probe",
    desc: "Full glyph coverage + font-name diagnostic. Browse the UI, then read device info.",
    trace: "FUT-191",
    url: HEBREW_PROBE_URL,
    sha: HEBREW_PROBE_SHA,
  },
  {
    key: "ffsui",
    badge: "OS",
    tint: theme.tint.green,
    name: "FFS OS seize",
    desc: "Our own screen replaces Even's — “FFS OS” + a live MM:SS ticker, phone-independent.",
    trace: "FUT-197",
    url: FFSUI_URL,
    sha: FFSUI_SHA,
  },
  {
    key: "ramexec",
    badge: "RX",
    tint: theme.tint.green,
    name: "RAM-exec probe",
    desc: "Proves pushing code into RAM runs. Read device info → ret=0x2A means go.",
    trace: "FUT-214",
    url: RAMEXEC_URL,
    sha: RAMEXEC_SHA,
  },
  {
    key: "loader",
    badge: "LD",
    tint: theme.tint.green,
    name: "OTA loader — 2.2.6.10 base (LEGACY)",
    desc: "⚠️ WRONG BASE for your glasses — this targets stock 2.2.6.10 and you are on 2.2.7.14. Use the LD7 image above. Kept only for a deliberate downgrade.",
    trace: "FUT-216",
    url: LOADER_URL,
    sha: LOADER_SHA,
  },
  {
    key: "cfw",
    badge: "FW",
    tint: theme.tint.red,
    name: "Full CFW",
    desc: "The complete custom firmware image.",
    trace: "FUT-167",
    url: CFW_URL,
    sha: CFW_SHA,
  },
  {
    key: "stock",
    badge: "↩",
    tint: theme.tint.grey,
    name: "Restore stock",
    desc: "Back to Even 2.2.6.10. The way out of anything above.",
    trace: "FUT-173",
    url: STOCK_URL,
    sha: STOCK_SHA,
  },
];

function healthColor(h: ConnectionHealth): string {
  switch (h) {
    case "healthy":
      return theme.accent;
    case "degraded":
    case "connecting":
    case "reconnecting":
      return theme.warn;
    case "disconnected":
      return theme.textDim;
  }
}

// FUT-253: catch any render/lifecycle crash in the OS tree and ship it off-device
// (glog.error was defined but never wired — an uncaught throw used to vanish into a
// blank screen with no trace). Keeps the app alive with a minimal fallback.
class GlogErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  componentDidCatch(err: unknown, info: { componentStack?: string }): void {
    try {
      glog.error("react_boundary", err);
      glog.emit("error", "boundary", { stack: String(info?.componentStack ?? "").slice(0, 800) });
    } catch {
      /* logging must never re-throw out of the boundary */
    }
  }
  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <Text style={styles.help}>FFS OS hit a render error — it was logged to the collector. Reopen the app.</Text>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <GlogErrorBoundary>
      <AppInner />
    </GlogErrorBoundary>
  );
}

function AppInner() {
  // FUT-236 — the calibration run owns the whole screen when active, and on a fresh
  // install it comes up FIRST, before the OS shell. Yoni asked for it to start "when I
  // open the app for the first time with both glasses and ring unpaired". Resolved
  // synchronously from a persisted flag so there is no flash of the normal UI first.
  const [calibrating, setCalibrating] = useState<boolean>(() => {
    try {
      return FfsBle.getPref("calib.v1.completed") === null;
    } catch {
      return false; // never block the app on the harness
    }
  });

  const bt = useFfsBluetooth({ autoScan: true });
  // FUT-253: feed every connection-health transition to the collector (the FUT-136
  // "drop → reconnect → home" sequence — the single highest-value miss). glog.conn was
  // defined but never wired; the supervisor already calls onEvent on each transition.
  const sup = useConnectionSupervisor(bt, { onEvent: glog.conn });
  const [session, setSession] = useState<string>("");
  const [swirlOn, setSwirlOn] = useState(false);
  const [flashProbe, setFlashProbe] = useState<string>("");
  // FUT-233 — R1 ring. Independent of the glasses link by design.
  const [ringState, setRingState] = useState<string>("—");
  const [ringFrames, setRingFrames] = useState(0);
  const [ringLog, setRingLog] = useState<string[]>([]);
  /** advStart needs the glasses' MAC, which only a lens scan reveals. */
  const glassesMac = bt.devices.find((d) => d.side !== "ring" && d.mac)?.mac ?? null;

  // Ring events. Mounted unconditionally — NOT gated on the glasses link, because the
  // test that matters is performed with the glasses off (FUT-233).
  useEffect(() => {
    const subs = [
      // Bluetooth being off is the single most likely reason a scan finds nothing, and
      // the panel used to just say "scanning…" forever while the driver logged the real
      // reason where only Rico could see it. Say it on screen. (FUT-233, 2026-07-28.)
      FfsBle.addListener("onStateChange", (p) => {
        if (p.state !== "poweredOn") {
          setRingState(`Bluetooth is ${p.state} — turn Bluetooth on`);
          setRingLog((l) => [`bluetooth ${p.state}`, ...l].slice(0, 12));
        }
      }),
      FfsBle.addListener("onRingConnected", (p) => {
        setRingState(`connected — ${p.name}`);
        setRingLog((l) => [`READY: ${p.name}`, ...l].slice(0, 12));
        glog.emit("ring", "connected", { name: p.name }); // FUT-253: ring normal-path telemetry
      }),
      FfsBle.addListener("onRingDisconnected", (p) => {
        setRingState("—");
        setRingLog((l) => [`disconnected${p.reason ? ` (${p.reason})` : ""}`, ...l].slice(0, 12));
        glog.emit("ring", "disconnected", { reason: p.reason ?? null });
      }),
      // Every frame, decoded or not — an unmapped code is a finding, not noise.
      FfsBle.addListener("onRingRaw", (p) => {
        setRingFrames((n) => n + 1);
        setRingLog((l) => [`rx ${p.hex}`, ...l].slice(0, 12));
        glog.emit("ring", "raw", { hex: p.hex }); // sampled 1-in-N at the source (HOT_KEYS "ring:raw")
      }),
      FfsBle.addListener("onRingBattery", (p) => {
        setRingLog((l) => [`battery ${p.battery}%`, ...l].slice(0, 12));
        glog.emit("ring", "battery", { battery: p.battery });
      }),
      FfsBle.addListener("onGesture", (g) => {
        if (g.device !== "ring") return;
        setRingLog((l) => [`👆 ${g.gesture}`, ...l].slice(0, 12));
        glog.emit("ring", "gesture", { gesture: g.gesture });
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  const [flashMsg, setFlashMsg] = useState<string>("");
  const [flashFrac, setFlashFrac] = useState<number>(0);
  const [flashBusy, setFlashBusy] = useState<boolean>(false);
  const [warranty, setWarranty] = useState<string>("");
  const [textTest, setTextTest] = useState<string>("");
  const [precheck, setPrecheck] = useState<boolean[]>(() => PRECHECK_ITEMS.map(() => false));
  // FUT-237 — the loader guard. Pushing a payload with no resident OTA loader is
  // DESTRUCTIVE, not inert: the stock image decoder parses our Thumb-2 code as a bitmap
  // → blank lens → watchdog reboot, identically for every payload. Cost on 2026-07-28:
  // a whole session and three lens crashes. `pushMsg` is the refusal/confirmation line.
  const [pushMsg, setPushMsg] = useState<string>("");
  // FUT-237 fix: the guard demanded positive proof of the loader, but deviceInfo starts
  // empty — so the first tap only fired the read and the user had to tap AGAIN (Yoni hit
  // three taps). A guard that makes you repeat yourself is a bad guard. We now park the
  // push here and fire it automatically the moment the readback lands.
  const pendingPushRef = useRef<{ label: string; event: string; b64: string } | null>(null);
  // FUT-237 fix #2. My first fix assumed the problem was "never read the firmware yet".
  // WRONG — device-info arrives as SEVERAL events and only some carry the ⟨LOADER⟩ markers
  // (they ride the L-lens version string), so a marker-less event pushed us down the
  // blocked path and Yoni still had to tap repeatedly. Loader presence cannot vanish
  // without a reflash, so LATCH it: once seen in any readback, it stays seen.
  const loaderSeenRef = useRef<boolean>(false);
  const [loaderSeen, setLoaderSeen] = useState(false);
  const readTriesRef = useRef<number>(0);

  // FUT-252 TEST WIZARD — one-tap guided on-glass capture. The wizard payload runs a
  // timer state machine on-glass and writes a rolling 32-bit record into the loader's
  // ret= field every tick; here we poll device-info at ~2 Hz for the run's duration,
  // decode each ⟨WIZARD⟩ record out of ret=, and stream it to the glasses log so Rico
  // reads the full multi-step capture from the server file. The tag nibble is 0x7,
  // unique among live payloads. See payloads/wizard.c for the encoding.
  const [wizardMsg, setWizardMsg] = useState<string>("");
  const wizardRunRef = useRef<boolean>(false);
  const wizardTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wizardStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wizardLastRawRef = useRef<number>(-1);
  const stopWizardRef = useRef<((done: boolean) => void) | null>(null);
  const WIZ_STEP_NAMES = ["intro", "TEMPLE TAP", "RING TAP", "RING UP", "RING DOWN", "DONE"];

  // Live refs so the nav's context getters always read current session state.
  const btRef = useRef(bt);
  btRef.current = bt;

  // One PhoneNav for the whole session. Its onChange re-asserts the current surface
  // through screenOwner (which serializes BLE writes so repaints never interleave).
  const navRef = useRef<PhoneNav | null>(null);
  if (!navRef.current) {
    const ctx: PhoneCtx = {
      pairReady: () => btRef.current.pairReady,
      sides: () => btRef.current.sides,
      // Real battery read back from the glasses (FUT-169); -1 = not read yet → HUD shows "?".
      battery: () => btRef.current.deviceInfo?.battery ?? -1,
      version: () => APP_VERSION,
      gestures: () => navRef.current?.gestureCount ?? 0,
    };
    navRef.current = new PhoneNav(homeScreen, ctx, () => {
      screenOwner.reclaimNow();
      // FUT-253: on-glass screen transitions (nav.ts had no telemetry hook).
      try { glog.emit("os", "nav", navRef.current?.describe() ?? {}); } catch { /* never break nav */ }
    });
  }

  // Off-device telemetry (FUT-144 collector).
  useEffect(() => {
    initLoggerCore({ app: "ffs-os-phone", harness: "App" });
    setSession(glog.session());
    // FUT-253: log every HUD surface repaint (glog.reclaim was a dead sink).
    screenOwner.setOnReclaim(glog.reclaim);
    glog.emit("os", "launcher_start", { session: glog.session(), version: APP_VERSION });
  }, []);

  // FUT-253: raw connection snapshot — emit whenever any observable link field changes
  // (glog.connState was defined but never called). Cheap: fires only on state transitions.
  useEffect(() => {
    glog.connState({
      connected: bt.sides.L || bt.sides.R,
      ready: bt.pairReady,
      rawState: bt.state,
      battery: bt.deviceInfo?.battery ?? null,
    });
  }, [bt.sides.L, bt.sides.R, bt.pairReady, bt.state, bt.deviceInfo?.battery]);

  // FUT-167 Stage 1: receive the zero-write flash-channel probe result.
  useEffect(() => {
    const sub = FfsBle.addListener("onFlashProbe", (e) => {
      const ready = e.leftReady && e.rightReady;
      setFlashProbe(`${e.detail}\n→ ${ready ? "READY — flasher can reach both lenses ✓" : "NOT ready"}`);
      glog.emit("os", "flash_probe", { leftReady: e.leftReady, rightReady: e.rightReady });
    });
    return () => sub.remove();
  }, []);

  // FUT-167 Stage 2: CFW flash / validate progress.
  useEffect(() => {
    const sub = FfsBle.addListener("onFlashProgress", (e) => {
      setFlashMsg(e.message);
      setFlashFrac(e.progress);
      if (e.done) setFlashBusy(false);
      glog.emit("os", "flash_progress", { message: e.message, progress: e.progress, done: e.done, ok: e.ok });
    });
    return () => sub.remove();
  }, []);

  // FUT-165 diagnostics (Yoni ask): stream EVERY native driver log line + disconnects +
  // device-info to the off-device collector, so a full trace of what the driver actually
  // did (anim frame sizes, gen time, queue depth, disconnect reasons) is visible remotely.
  useEffect(() => {
    const subs = [
      FfsBle.addListener("onLog", (e) => glog.emit("drv", "log", { m: e.message })),
      // FUT-253: the connect lifecycle — previously only the hook consumed these, so the
      // collector never saw a link come up. Handlers here are telemetry-only (no behaviour).
      FfsBle.addListener("onDeviceFound", (d) =>
        glog.emit("drv", "device_found", { side: d.side, name: d.name ?? null, mac: d.mac ?? null, rssi: d.rssi ?? null })),
      FfsBle.addListener("onConnected", (e) => glog.emit("drv", "connected", { side: e.side })),
      FfsBle.addListener("onPairReady", () => glog.emit("drv", "pair_ready", {})),
      FfsBle.addListener("onStateChange", (p) => glog.emit("drv", "adapter_state", { state: p.state })),
      FfsBle.addListener("onDisconnected", (e) =>
        glog.emit("drv", "disconnected", { side: e.side, reason: e.reason ?? null, code: e.code, domain: e.domain })),
      FfsBle.addListener("onDeviceInfo", (e) => {
        glog.emit("drv", "device_info", { batt: e.battery, chg: e.charging, l: e.leftVersion, r: e.rightVersion });
        if (`${e.leftVersion ?? ""} ${e.rightVersion ?? ""}`.includes("LOADER")) {
          loaderSeenRef.current = true;
          setLoaderSeen(true);
        }
        // FUT-252 wizard capture: decode the ⟨WIZARD⟩ record out of the loader's ret=.
        if (wizardRunRef.current) {
          const ver = `${e.leftVersion ?? ""} ${e.rightVersion ?? ""}`;
          const m = ver.match(/ret=0x([0-9A-Fa-f]+)/);
          if (m) {
            const v = parseInt(m[1], 16) >>> 0;
            if ((v >>> 28) === 0x7 && v !== wizardLastRawRef.current) {
              wizardLastRawRef.current = v;
              const kind = (v >>> 27) & 1;
              const step = (v >>> 24) & 7;
              const name = WIZ_STEP_NAMES[step] ?? `step${step}`;
              if (kind === 0) {
                const S = (v >>> 16) & 0xff;
                const U = (v >>> 8) & 0xff;
                const fl = v & 0xff;
                glog.emit("wizard", "rec", {
                  raw: "0x" + v.toString(16).padStart(8, "0"),
                  kind: "header", step, input: name,
                  S: "0x" + S.toString(16).padStart(2, "0"),
                  U: "0x" + U.toString(16).padStart(2, "0"),
                  control_ok: (fl >>> 7) & 1, font_ok: (fl >>> 6) & 1,
                  changed: (fl >>> 5) & 1, captured: (fl >>> 4) & 1,
                  in_capture: (fl >>> 3) & 1, ctr: fl & 7,
                });
              } else {
                glog.emit("wizard", "rec", {
                  raw: "0x" + v.toString(16).padStart(8, "0"),
                  kind: "id", step, input: name,
                  id24: "0x" + (v & 0xffffff).toString(16).padStart(6, "0"),
                });
              }
              setWizardMsg(
                step >= 5
                  ? "✅ glasses say DONE — capture streamed to the log. You can stop."
                  : `🧙 Wizard running… step ${step}/4 (${name}) — follow the glasses; say 'done' when they say DONE.`,
              );
              if (step >= 5) stopWizardRef.current?.(true);
            }
          }
        }
        const p = pendingPushRef.current;
        if (!p) return;
        if (loaderSeenRef.current) {
          pendingPushRef.current = null;
          setPushMsg(`✅ loader confirmed — pushed ${p.label}`);
          glog.emit("os", p.event, {});
          FfsBle.pushPayloadViaImage(p.b64);
          return;
        }
        // Marker-less readback. Some events legitimately lack it, so try a few times
        // before concluding the loader really is absent.
        readTriesRef.current += 1;
        if (readTriesRef.current >= 3) {
          pendingPushRef.current = null;
          setPushMsg("⛔ BLOCKED — no OTA loader on the glasses (stock firmware). Pushing would crash a lens. Flash g2_2.2.6.10_loader.bin first.");
          glog.emit("os", "push_blocked", { label: p.label, reason: "no_loader" });
        } else {
          FfsBle.requestDeviceInfo();
        }
      }),
      // FUT-253 Step 3: native BLE link-level observability. cat:"ble" for link signals
      // (rssi/mtu/throughput/backpressure), cat:"drv" for the render-pipeline ack. All are
      // telemetry-only — non-throwing, and glog.emit itself never throws into the app.
      FfsBle.addListener("onRssi", (e) => glog.emit("ble", "rssi", { side: e.side, rssi: e.rssi })),
      FfsBle.addListener("onMtu", (e) => glog.emit("ble", "mtu", { side: e.side, mtu: e.mtu })),
      FfsBle.addListener("onConnectFailed", (e) =>
        glog.emit("ble", "connect_failed", { side: e.side, code: e.code, domain: e.domain, desc: e.desc })),
      FfsBle.addListener("onTxMeter", (e) =>
        glog.emit("ble", "tx_meter", { side: e.side, bytes: e.bytes, pkts: e.pkts, depth: e.queueDepth })),
      FfsBle.addListener("onTxStall", (e) => glog.emit("ble", "tx_stall", { side: e.side, depth: e.queueDepth })),
      FfsBle.addListener("onTxResume", (e) => glog.emit("ble", "tx_resume", { side: e.side, depth: e.queueDepth })),
      FfsBle.addListener("onSubscribe", (e) =>
        glog.emit("ble", "subscribe", { side: e.side, characteristic: e.characteristic, on: e.on })),
      FfsBle.addListener("onImgAck", (e) =>
        glog.emit("drv", "img_ack", { session: e.session, fragment: e.fragment, ok: e.ok, timedOut: e.timedOut })),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // FUT-167 soft precheck: a real flash arms ONLY when the warranty phrase is typed
  // AND every readiness item is acknowledged. Single source of truth — both the FLASH
  // CFW and Restore Stock buttons gate on `armed`; there is no other arming path.
  const precheckDone = precheck.every(Boolean);
  const armed = warranty.trim() === WARRANTY_PHRASE && precheckDone;
  // FUT-237 — GUARD: never push a payload unless the resident OTA loader has actually
  // been SEEN in a device-info readback. The CFW appends ⟨LOADER gen=… ran=… ret=0x…⟩ to
  // the firmware version string (G2Protocol.swift field 104); on stock that field is
  // absent entirely, so the version line is a bare "2.2.6.10".
  //
  // We deliberately require POSITIVE evidence rather than trying to detect stock: an
  // unread deviceInfo is treated as "not proven", which fails safe. First tap with no
  // reading triggers the read; tap again once it lands.
  const loaderPresent = (): boolean => {
    if (loaderSeenRef.current) return true;
    const di = bt.deviceInfo;
    return `${di?.leftVersion ?? ""} ${di?.rightVersion ?? ""}`.includes("LOADER");
  };
  const guardedPush = (label: string, event: string, b64: string) => {
    if (!bt.pairReady) return;
    if (loaderPresent()) {
      loaderSeenRef.current = true;
      setPushMsg(`✅ loader confirmed — pushed ${label}`);
      glog.emit("os", event, {});
      FfsBle.pushPayloadViaImage(b64);
      return;
    }
    // Not proven yet — park the push and let the readback fire it. ONE tap.
    pendingPushRef.current = { label, event, b64 };
    readTriesRef.current = 0;
    setPushMsg("⏳ checking the glasses for the OTA loader… this push will go automatically.");
    FfsBle.requestDeviceInfo();
  };

  // FUT-252 — run the on-glass TEST WIZARD end to end: push it ONCE, then poll
  // device-info at ~2 Hz for the run's duration so every ⟨WIZARD⟩ record the payload
  // writes into ret= is decoded (in the onDeviceInfo listener above) and streamed to the
  // glasses log. ~45 s covers the full run (intro + 4 steps + DONE) with margin; the
  // wizard's own timer self-cleans on-glass (finite repeat_count).
  const stopWizard = (done: boolean) => {
    if (wizardTimerRef.current) { clearInterval(wizardTimerRef.current); wizardTimerRef.current = null; }
    if (wizardStopRef.current) { clearTimeout(wizardStopRef.current); wizardStopRef.current = null; }
    if (!wizardRunRef.current) return;
    wizardRunRef.current = false;
    glog.emit("wizard", "stop", { done });
    if (!done) setWizardMsg("🧙 Wizard poll window closed — capture is in the log.");
  };
  stopWizardRef.current = stopWizard;
  const runWizard = () => {
    if (!bt.pairReady || wizardRunRef.current) return;
    const wiz = GENERATED_PAYLOADS.find((p) => p.id === "wizard");
    if (!wiz) { setWizardMsg("⛔ wizard payload missing from the build — run `ffs-sdk gen`."); return; }
    wizardRunRef.current = true;
    wizardLastRawRef.current = -1;
    setWizardMsg("🧙 Starting the wizard… put the glasses on and follow the prompts.");
    glog.emit("wizard", "start", { payload: wiz.id });
    guardedPush(wiz.pushLabel, wiz.pushKey, wiz.b64);
    // Poll device-info at ~2 Hz (the native side dedups reads under 300 ms).
    wizardTimerRef.current = setInterval(() => FfsBle.requestDeviceInfo(), 500);
    // Hard stop after the full run + margin, even if we never see the DONE record.
    wizardStopRef.current = setTimeout(() => stopWizard(false), 45000);
  };

  const startFlash = (url: string, sha: string, dryRun: boolean) => {
    if (!bt.pairReady || flashBusy) return;
    setFlashBusy(true);
    setFlashMsg("starting…");
    setFlashFrac(0);
    glog.emit("os", "flash_start", { dryRun, url, precheckAcked: dryRun ? null : precheckDone });
    FfsBle.startCfwFlash(url, sha, dryRun);
    // Real-flash safety: disarm immediately so the button can't be re-fired by accident.
    // A second real flash must re-type the warranty phrase AND re-confirm the checklist.
    if (!dryRun) {
      setWarranty("");
      setPrecheck(PRECHECK_ITEMS.map(() => false));
    }
  };

  // Own the screen while the pair is ready: start the reclaim manager, paint the current
  // phone-OS screen, and route touchpad gestures into navigation. Tear down on disconnect.
  useEffect(() => {
    if (!bt.pairReady) return;
    // FUT-236: while a calibration run is active the OS must NOT act on gestures.
    // Measured 2026-07-28: during the temple-touchpad steps, taps were routed into
    // navigation, which activated a menu item and started streaming an 11.6 KB image
    // animation to the glasses — and BOTH lenses then dropped with "connection has
    // timed out unexpectedly", corrupting that step and the two after it.
    // An instrument that changes the thing it is measuring is not an instrument.
    if (calibrating) return;
    const nav = navRef.current!;
    screenOwner.start();
    void screenOwner.setSurface(() => nav.paint());
    glog.emit("os", "phone_os_up", {});
    const sub = FfsBle.addListener("onGesture", (g) => {
      // Input can now arrive from the glasses' touchpads OR the R1 ring (FUT-233).
      // `device`/`source` are logged so telemetry can tell them apart after the fact.
      const nav_gesture = toNavGesture(g);
      glog.emit("os", "nav_gesture", {
        gesture: g.gesture,
        side: g.side,
        device: g.device,
        source: g.source,
        nav: nav_gesture,
      });
      if (nav_gesture) nav.handleGesture(nav_gesture);
    });
    return () => {
      sub.remove();
      screenOwner.stop();
    };
  }, [bt.pairReady, calibrating]);

  // Keep the HUD status-bar clock live: re-paint the current screen at each minute
  // boundary while the pair is ready — but skip while the image screen is up (a re-paint
  // there would needlessly re-stream the bitmap). Minute-ALIGNED, 1/min (well under the
  // FUT-136 keep-alive cadence that provoked firmware evictions).
  useEffect(() => {
    if (!bt.pairReady) return;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNextMinute = () => {
      const msToNextMinute = 60_000 - (Date.now() % 60_000);
      timer = setTimeout(() => {
        const nav = navRef.current!;
        if (!nav.ownsHudSurface()) screenOwner.reclaimNow();
        scheduleNextMinute();
      }, msToNextMinute + 50);
    };
    scheduleNextMinute();
    return () => clearTimeout(timer);
  }, [bt.pairReady]);

  const health = sup.health;
  const hc = healthColor(health);
  const canAct = bt.pairReady && !flashBusy;
  const batt = bt.deviceInfo?.battery;

  // Placed AFTER every hook above, so hook order stays identical whether or not the
  // harness is showing — an early return above any hook would break the rules of hooks.
  if (calibrating) {
    return (
      <CalibrationScreen
        appVersion={APP_VERSION}
        onExit={(completed) => {
          // Record completion either way: an abandoned run should not re-ambush Yoni
          // on every launch. It stays re-runnable from the Developer section.
          try {
            FfsBle.setPref("calib.v1.completed", completed ? "done" : "skipped");
          } catch {
            /* non-fatal — worst case it offers again next launch */
          }
          setCalibrating(false);
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      {/* Pinned status — the link state is the one thing that must never scroll away. */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>FFS Glasses OS</Text>
          <View style={styles.pill}>
            <View style={[styles.dot, { backgroundColor: hc }]} />
            <Text style={[styles.pillText, { color: hc }]}>{healthLabel(health)}</Text>
          </View>
        </View>
        <Text style={styles.headerMeta}>
          L {bt.sides.L ? "●" : "○"}  R {bt.sides.R ? "●" : "○"}  ·  pair {bt.pairReady ? "ready" : "—"}
          {batt == null ? "" : `  ·  ${batt}%`}
          {bt.deviceInfo?.charging ? " ⚡" : ""}  ·  v{APP_VERSION}
        </Text>
      </View>

      {/* Pinned flash progress. A ~5-min brick-risk window deserves better than a text
          line buried in a scroll — bar + percent + the "don't walk away" reminder, held
          on screen the whole time (Meta AI / IKEA / Fitbit device-update pattern). */}
      {flashMsg ? (
        <View style={[styles.flashBar, flashBusy && styles.flashBarActive]}>
          <View style={styles.flashRow}>
            <Text style={styles.flashPct}>{Math.round(flashFrac * 100)}%</Text>
            <Text style={styles.flashMsg} numberOfLines={1}>
              {flashBusy ? "⏳ " : ""}
              {flashMsg}
            </Text>
          </View>
          <Progress frac={flashFrac} tint={flashBusy ? theme.warn : theme.accent} />
          {flashBusy ? (
            <Text style={styles.flashWarn}>
              Keep the app open and stay within ~1 m of the glasses until this finishes.
            </Text>
          ) : null}
        </View>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={true}
      >
        {/* FUT-233 — the R1 ring is the SDK's input device. Deliberately FIRST and
            deliberately NOT gated on `pairReady`: the discriminating test is run with
            the glasses POWERED OFF, so anything requiring a lens link would make the
            test impossible to perform. */}
        {/* FUT-236 — re-runnable on demand, not just on a fresh install. Every run is
            a fresh labelled dataset, so re-running after a firmware or app change is
            the cheapest way to re-establish ground truth. */}
        <SectionLabel note="FUT-236 · ~5 min, guided">Calibration run</SectionLabel>
        <Group>
          <Row
            badge="◎"
            tint={theme.tint.amber}
            title="Run SDK calibration"
            subtitle="Guided capture of everything the ring and glasses expose"
            trace="FUT-236"
            onPress={() => setCalibrating(true)}
          />
        </Group>

        <SectionLabel note="FUT-233 · works with the glasses OFF">R1 ring — input test</SectionLabel>
        <Group>
          <Row
            badge="💍"
            tint={theme.tint.purple}
            title={ringState === "—" ? "Scan for ring" : "Rescan ring"}
            subtitle={
              ringState === "—"
                ? "Wear the ring, then tap — glasses can stay off"
                : ringState
            }
            tag={ringFrames > 0 ? `${ringFrames} frames` : undefined}
            tagTint={theme.accent}
            trace="FUT-233"
            onPress={() => {
              setRingLog((l) => ["scanning for ring…", ...l].slice(0, 12));
              FfsBle.ringScan();
            }}
          />
          <Row
            badge="⛓"
            tint={theme.tint.blue}
            title="Ring → also connect to glasses"
            subtitle={
              glassesMac
                ? `advStart → ${glassesMac} (does both links coexist?)`
                : "Scan for the glasses first — needs their MAC"
            }
            divider
            disabled={!glassesMac}
            onPress={() => {
              const ok = FfsBle.ringConnectToGlasses(glassesMac!);
              setRingLog((l) =>
                [`advStart ${ok ? "sent" : "REJECTED — ring not connected?"}`, ...l].slice(0, 12)
              );
            }}
          />
          <Row
            badge="✕"
            tint={theme.tint.blue}
            title="Forget ring"
            subtitle="Unpair, so the next scan starts fresh"
            divider
            onPress={() => {
              FfsBle.ringForget();
              setRingState("—");
              setRingFrames(0);
              setRingLog([]);
            }}
          />
        </Group>
        <Text style={styles.help}>
          Glasses OFF → Scan → do all five: single tap · double tap · swipe up · swipe down ·
          hold. Every frame below is also sent to telemetry, so Rico reads the result.
        </Text>
        {ringLog.length > 0 ? (
          <Text style={styles.mono}>{ringLog.join("\n")}</Text>
        ) : null}

        <SectionLabel note="swipe up/down · tap · double-tap">Drive on-glass</SectionLabel>
        <Group>
          <Row
            badge="⌂"
            tint={theme.tint.green}
            title="Home"
            subtitle="Jump the HUD back to the launcher"
            disabled={!bt.pairReady}
            onPress={() => navRef.current?.goHome()}
          />
          <Row
            badge="‹"
            tint={theme.tint.blue}
            title="Back"
            subtitle="Pop one screen on the HUD"
            divider
            disabled={!bt.pairReady}
            onPress={() => {
              const nav = navRef.current;
              if (nav?.back()) screenOwner.reclaimNow();
            }}
          />
          <Row
            badge={swirlOn ? "■" : "▶"}
            tint={theme.tint.purple}
            title={swirlOn ? "Stop AI swirl" : "Start AI swirl"}
            subtitle="Even's swirl animation on the HUD"
            tag={swirlOn ? "ON" : undefined}
            tagTint={theme.accent}
            divider
            disabled={!bt.pairReady}
            onPress={() => {
              const next = !swirlOn;
              setSwirlOn(next);
              glog.emit("os", "ai_swirl", { on: next });
              FfsBle.showAiSwirl(next);
            }}
          />
        </Group>
        {/* Gesture readout — kept visible: it's how you tell the touchpad is actually
            reaching the phone when the HUD looks stuck. */}
        {bt.lastGesture ? (
          <Text style={styles.mono}>
            last gesture: {bt.lastGesture.gesture} ({bt.lastGesture.side})
          </Text>
        ) : null}

        <SectionLabel>Link</SectionLabel>
        <Group>
          <Row
            badge="↯"
            tint={theme.tint.green}
            title="Connect"
            subtitle="Scan + reclaim both lenses"
            onPress={() => sup.reconnect()}
          />
          <Row
            badge="✕"
            tint={theme.tint.grey}
            title="Disconnect"
            subtitle="Drop the session"
            divider
            onPress={() => sup.disconnect()}
          />
          <Row
            badge="i"
            tint={theme.tint.blue}
            title="Read battery + firmware version"
            subtitle={
              bt.deviceInfo
                ? `L ${bt.deviceInfo.leftVersion ?? "?"} · R ${bt.deviceInfo.rightVersion ?? "?"}`
                : bt.pairReady
                  ? "not read yet — auto-reads ~2 s after connect"
                  : "connect both lenses first"
            }
            trace="FUT-169"
            divider
            disabled={!canAct}
            onPress={() => bt.requestDeviceInfo()}
          />
        </Group>

        <SectionLabel note="FUT-191">Text test — Hebrew / English scroll</SectionLabel>
        <View style={styles.card}>
          <TextInput
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            multiline
            value={textTest}
            onChangeText={setTextTest}
            placeholder="Paste a long story (English + Hebrew) to display on the glasses…"
            placeholderTextColor={theme.textDim}
          />
          <Pressable
            style={[styles.btn, (!canAct || !textTest.trim()) && styles.btnDisabled]}
            disabled={!canAct || !textTest.trim()}
            onPress={() => {
              setTextTestContent(textTest);
              navRef.current?.openScreen(textTestScreen);
              screenOwner.reclaimNow();
            }}
          >
            <Text style={styles.btnText}>Send to glasses → Text test</Text>
          </Pressable>
          <Text style={styles.help}>
            On the glasses: swipe up/down to scroll, double-tap to exit. Also on the on-glass
            menu (Home → Text test).
          </Text>
        </View>

        <SectionLabel note="no writes — safe to spam">Firmware checks</SectionLabel>
        <Group>
          <Row
            badge="~"
            tint={theme.tint.blue}
            title="Channel probe"
            subtitle="Can the flasher reach both lenses?"
            tag="no writes"
            trace="FUT-167"
            disabled={!canAct}
            onPress={() => {
              setFlashProbe("probing… (zero writes)");
              FfsBle.flashDryRun();
            }}
          />
          <Row
            badge="✓"
            tint={theme.tint.blue}
            title="Validate canary"
            subtitle="Download + verify the canary image, write nothing"
            tag="no writes"
            divider
            disabled={!canAct}
            onPress={() => startFlash(CANARY_URL, CANARY_SHA, true)}
          />
          <Row
            badge="✓"
            tint={theme.tint.blue}
            title="Validate CFW"
            subtitle="Download + verify the full CFW image, write nothing"
            tag="no writes"
            divider
            disabled={!canAct}
            onPress={() => startFlash(CFW_URL, CFW_SHA, true)}
          />
        </Group>
        {flashProbe ? <Text style={styles.mono}>{flashProbe}</Text> : null}

        <SectionLabel note={armed ? "ARMED" : "not armed"}>Arm a real flash</SectionLabel>
        <View style={[styles.card, armed && styles.cardArmed]}>
          <Text style={styles.help}>
            Self-attested — the app does not read your battery or hold your screen awake, you do.
          </Text>
          {PRECHECK_ITEMS.map((item, i) => (
            <Pressable
              key={i}
              style={styles.checkRow}
              disabled={flashBusy}
              onPress={() =>
                setPrecheck((prev) => {
                  const next = prev.slice();
                  next[i] = !next[i];
                  return next;
                })
              }
            >
              <Text style={[styles.checkBox, precheck[i] && styles.checkBoxOn]}>
                {precheck[i] ? "☑" : "☐"}
              </Text>
              <Text style={styles.checkLabel}>{item}</Text>
            </Pressable>
          ))}
          <Text style={styles.warnText}>
            Biggest real risk is BLE dropping mid-flash — phone right next to the glasses, app
            open, the whole ~5 min. A cleanly interrupted write can brick.
          </Text>
          <Text style={styles.dangerText}>
            Type “{WARRANTY_PHRASE}” to arm{precheckDone ? "" : " (after the checks above)"}:
          </Text>
          <TextInput
            style={styles.input}
            value={warranty}
            onChangeText={setWarranty}
            placeholder={WARRANTY_PHRASE}
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <SectionLabel note={armed ? "tap to flash" : "arm above first"}>Flash images</SectionLabel>
        <Group>
          {FW_IMAGES.map((img, i) => (
            <Row
              key={img.key}
              badge={img.badge}
              tint={img.tint}
              title={img.name}
              subtitle={img.desc}
              tag="WRITES"
              tagTint={theme.danger}
              trace={img.trace}
              divider={i > 0}
              disabled={!armed || !canAct}
              onPress={() => startFlash(img.url, img.sha, false)}
            />
          ))}
        </Group>

        <SectionLabel note="FUT-252 · one tap · fully on-glass · auto-saved to the log">
          Test wizard
        </SectionLabel>
        {wizardMsg ? <Text style={styles.dim}>{wizardMsg}</Text> : null}
        <Group>
          <Row
            badge="🧙"
            tint={theme.tint.green}
            title="🧙 RUN TEST WIZARD — TAP THIS ONE"
            subtitle="Put the glasses on and follow the prompts (TEMPLE TAP · RING TAP · RING UP · RING DOWN). Everything is captured on-glass and streamed to the log automatically — say 'done' when the glasses say DONE. No typing, no hex."
            tag="no flash"
            tagTint={theme.tint.green}
            trace="FUT-252"
            divider={false}
            disabled={!bt.pairReady || wizardRunRef.current}
            onPress={runWizard}
          />
        </Group>

        <SectionLabel
          note={
            loaderSeen || loaderPresent()
              ? "FUT-216 · ✅ OTA loader detected — pushes are safe"
              : bt.deviceInfo
                ? "FUT-216 · ⛔ NO loader (stock firmware) — pushes are BLOCKED"
                : "FUT-216 · loader unverified — read the firmware version first"
          }
        >
          Push over the air
        </SectionLabel>
        {pushMsg ? <Text style={styles.dim}>{pushMsg}</Text> : null}
        <Group>
          <Row
            badge="★"
            tint={theme.tint.red}
            title="⭐ FUT238 STYLE PROBE — TAP THIS ONE"
            subtitle="THE NEW ROW. One tap → read back ret=0x… from the firmware-L line, and look for a rounded outlined box with legible “FUT238 OK” mid-HUD."
            tag="no flash"
            trace="FUT-238"
            divider
            disabled={!bt.pairReady}
            onPress={() => {
              guardedPush("FUT238 STYLE PROBE", "push_style_props", PAYLOAD_STYLE_PROPS_B64);
            }}
          />
          {GENERATED_PAYLOADS.map((p) =>
            // The wizard has its own one-tap section above (push + poll + log); skip its
            // bare-push row here so it isn't offered twice.
            p.id === "wizard" ? null : (
              <Row
                key={p.id}
                badge={p.badge}
                tint={p.tint}
                title={p.title}
                subtitle={p.subtitle}
                tag={p.tag}
                tagTint={p.tagTint}
                trace={p.trace}
                divider={p.divider}
                disabled={!bt.pairReady}
                onPress={() => {
                  guardedPush(p.pushLabel, p.pushKey, p.b64);
                }}
              />
            ),
          )}
        </Group>

        <SectionLabel note={session || "starting…"}>Connection log</SectionLabel>
        <View style={styles.logBox}>
          {sup.log.length === 0 ? (
            <Text style={styles.dim}>no transitions yet…</Text>
          ) : (
            sup.log
              .slice()
              .reverse()
              .slice(0, 30)
              .map((e, i) => (
                <Text key={i} style={styles.logLine}>
                  {new Date(e.at).toLocaleTimeString()}  {e.health}
                  {e.note ? ` — ${e.note}` : ""}
                </Text>
              ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },

  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.surfaceAlt,
  },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: theme.text, fontSize: 20, fontWeight: "700" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.surface,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  pillText: { fontSize: 12, fontWeight: "700" },
  headerMeta: { color: theme.textDim, fontSize: 11.5, fontFamily: "Menlo", marginTop: 6 },

  flashBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.surfaceAlt,
  },
  flashBarActive: { backgroundColor: "#1A1508" },
  flashRow: { flexDirection: "row", alignItems: "baseline" },
  flashPct: { color: theme.text, fontSize: 15, fontWeight: "800", width: 52 },
  flashMsg: { color: theme.textDim, fontSize: 12, fontFamily: "Menlo", flex: 1 },
  flashWarn: { color: theme.warn, fontSize: 11.5, marginTop: 7, lineHeight: 15 },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 56 },

  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  cardArmed: { borderColor: theme.danger },

  btn: {
    backgroundColor: theme.accentDim,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  btnDisabled: { backgroundColor: theme.surfaceAlt, opacity: 0.5 },
  btnText: { color: theme.text, fontWeight: "600", fontSize: 14 },

  input: {
    backgroundColor: "#010409",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
    color: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 6,
    fontFamily: "Menlo",
    fontSize: 13,
  },

  checkRow: { flexDirection: "row", alignItems: "flex-start", marginTop: 10 },
  checkBox: { color: theme.textDim, fontSize: 18, marginRight: 8, lineHeight: 20 },
  checkBoxOn: { color: theme.accent },
  checkLabel: { color: theme.text, fontSize: 13, flex: 1, lineHeight: 18 },

  help: { color: theme.textDim, fontSize: 12, lineHeight: 16, marginTop: 8 },
  mono: { color: theme.textDim, fontSize: 12, fontFamily: "Menlo", marginTop: 8, lineHeight: 16 },
  warnText: { color: theme.warn, fontSize: 12, marginTop: 12, lineHeight: 16 },
  dangerText: { color: theme.danger, fontSize: 12, marginTop: 12, lineHeight: 16 },
  dim: { color: theme.textDim, fontSize: 12 },

  logBox: {
    backgroundColor: "#010409",
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
  },
  logLine: { color: theme.accent, fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
});
