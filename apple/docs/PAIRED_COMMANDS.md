# Paired command transport

The same implementation serves macOS and iOS. AppLibrary, appData, voice FFSC and
FFSA/FFSC developer pushes pass through PairedCommands. Raw diagnostic payloads
retain their existing transport and cannot overwrite an active paired operation.

An existing validated FXP1 body is wrapped in a new FXP1 frame whose body is:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 4 | FFSQ |
| 4 | 4 | Nonzero host session, little endian |
| 8 | 4 | Monotonic nonzero sequence within the session |
| 12 | 4 | CRC32 of the original FFSA/FFSC body |
| 16 | remaining | Original body, without its FXP1 header |

Firmware must coordinate identical commands, render/present their agreed frame,
and release both receive buffers before emitting system event 0x25 from the right
lens. Its 24-byte payload contains six little-endian words: host session, sequence,
body CRC32, presented frame, right error, left error. Both errors must be zero.
A Bluetooth write completing, a right-only 0x24 ACK, or a stale 0x25 is insufficient.
The frame identifies a paired firmware transaction; it is not an optical measurement.

The host serializes every producer and associates send failures/timeouts with the
exact pending sequence. An uncertain delivery, disconnect during delivery or
asymmetric execution error blocks subsequent writes. There is no automatic replay
into an arena that might still be owned. A paired glasses restart and bridge restart
establish a fresh session. A symmetric explicit rejection reports its error and
allows another command. App-load requests are deduplicated by app ID and token.

Run `python3 tools/test_app_library.py` on macOS for persistence and actual queue
checks, including wrong session, sequence, CRC, lens, delayed ACK, split failure,
disconnect and timeout. Build both Xcode targets for platform compilation checks.
