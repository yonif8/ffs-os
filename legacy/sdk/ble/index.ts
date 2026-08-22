// The pure-TS BLE command surface: CRC primitives, the aa21 transport envelope, the FXP1 CFW-push
// builder, and typed frame-level command builders. Everything here is pure and unit-tested — it
// produces the exact bytes the RN/native CoreBluetooth transport writes, and nothing does I/O.
//
// One SDK, no protobufs/addresses/BLE exposed to callers (GOAL §7); frames buildable and byte-
// checkable offline, so a screen can be proven without glasses (GOAL §1).

export * from "./crc";
export * from "./envelope";
export * from "./fxp1";
export * from "./commands";
