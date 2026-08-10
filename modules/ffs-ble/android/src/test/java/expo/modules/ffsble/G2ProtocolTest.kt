package expo.modules.ffsble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Golden byte-vector tests for G2Protocol.kt.
 *
 * WHY THIS EXISTS
 * ---------------
 * `G2Protocol.kt` is a hand translation of `ios/G2Protocol.swift`. Swift has `UInt8` and
 * `UInt16`; Kotlin's `Byte` is SIGNED and its `Int` is 32-bit, so every shift, mask and
 * overflow-wrap in the CRC, the varint encoder and the transport framer had to be
 * reproduced by hand. Get one mask wrong and nothing fails to compile -- you get a packet
 * the glasses silently reject, which is brutal to bisect inside a 3,200-line port and
 * costs an on-glass session to even notice.
 *
 * These vectors were generated from an INDEPENDENT transcription of the Swift source
 * (a Python model), not from the Kotlin. So they cross-check the Kotlin implementation's
 * signedness and shift handling, which is exactly the risk this translation carries.
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 * That the protocol itself is right. Both the Swift and these vectors could encode the
 * same misunderstanding of what the glasses want. Only on-glass proves that (cardinal
 * rule 1) -- and the Swift side already has that proof, which is the point: matching the
 * Swift byte-for-byte inherits its on-glass evidence. That inheritance is only valid while
 * the bytes actually match, which is what these tests enforce.
 *
 * Run: ./gradlew :ffs-ble:test
 */
class G2ProtocolTest {

    private fun hex(b: ByteArray) = b.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    // ---- CRC16 (the custom bit-mix, init 0xFFFF) ----

    @Test
    fun `crc16 of empty input is the 0xFFFF seed`() {
        assertEquals(0xFFFF, g2CRC16(ByteArray(0)))
    }

    @Test
    fun `crc16 golden vectors`() {
        assertEquals(0xB915, g2CRC16("A".toByteArray()))
        assertEquals(0xD26E, g2CRC16("hello".toByteArray()))
        assertEquals(0xAE6D, g2CRC16("FFS".toByteArray()))
    }

    /** Every byte value 0..255 -- catches sign-extension on bytes >= 0x80 specifically. */
    @Test
    fun `crc16 over all 256 byte values catches sign extension`() {
        val all = ByteArray(256) { it.toByte() }
        assertEquals(0x3FBD, g2CRC16(all))
    }

    // ---- varint ----

    private fun varintOf(v: Int): ByteArray {
        val w = G2ProtobufWriter()
        w.writeVarint(v.toLong())
        return w.data
    }

    @Test
    fun `varint encodes small and multibyte values`() {
        assertArrayEquals(bytes(0x00), varintOf(0))
        assertArrayEquals(bytes(0x01), varintOf(1))
        assertArrayEquals(bytes(0x7F), varintOf(127))
        assertArrayEquals(bytes(0x80, 0x01), varintOf(128))
        assertArrayEquals(bytes(0xAC, 0x02), varintOf(300))
        assertArrayEquals(bytes(0xFF, 0xFF, 0xFF, 0xFF, 0x07), varintOf(Int.MAX_VALUE))
    }

    /**
     * The dangerous case. A negative Int32 must sign-extend to 64 bits and emit a full
     * 10-byte varint (Swift: `UInt64(bitPattern: Int64(value))`). A signed shift in the
     * encoder loop would spin forever or truncate here.
     */
    @Test
    fun `varint encodes negatives as 10 bytes`() {
        assertArrayEquals(
            bytes(0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01),
            varintOf(-1)
        )
        assertArrayEquals(
            bytes(0x80, 0x80, 0x80, 0x80, 0xF8, 0xFF, 0xFF, 0xFF, 0xFF, 0x01),
            varintOf(Int.MIN_VALUE)
        )
    }

    // ---- transport framing ----

    @Test
    fun `transport frames a short payload with trailing little-endian CRC`() {
        val pkts = G2Transport.buildPackets(
            syncId = 7, serviceId = G2ServiceID.EVEN_HUB, payload = bytes(0x01, 0x02, 0x03)
        )
        assertEquals(1, pkts.size)
        // 0xAA | (dst<<4)|src | sync | len(+2 CRC) | total | serial | svc | status | data | CRC-LE
        assertArrayEquals(
            bytes(0xAA, 0x21, 0x07, 0x05, 0x01, 0x01, 0xE0, 0x00, 0x01, 0x02, 0x03, 0xAD, 0xAD),
            pkts[0]
        )
    }

    @Test
    fun `reserveFlag sets status bit 5 and empty payload still carries a CRC`() {
        val pkts = G2Transport.buildPackets(
            syncId = 3,
            serviceId = G2ServiceID.DEVICE_SETTINGS,
            payload = ByteArray(0),
            reserveFlag = true
        )
        assertEquals(1, pkts.size)
        assertArrayEquals(bytes(0xAA, 0x21, 0x03, 0x02, 0x01, 0x01, 0x80, 0x20, 0xFF, 0xFF), pkts[0])
    }

    /**
     * The edge the Swift comment calls out: a final chunk of EXACTLY 236 bytes must spill
     * into an extra empty packet to carry the CRC, so a full chunk is never mistaken for a
     * non-terminal one. Off-by-one here corrupts every large image transfer.
     */
    @Test
    fun `exactly 236 bytes spills the CRC into an extra packet`() {
        val payload = ByteArray(236) { 0x5A }
        val pkts = G2Transport.buildPackets(
            syncId = 0, serviceId = G2ServiceID.EVEN_HUB, payload = payload
        )
        assertEquals("236-byte payload must produce 2 packets", 2, pkts.size)

        // First packet: full 236-byte chunk, NOT marked last, so no +2 on the length byte.
        assertEquals(244, pkts[0].size)
        assertArrayEquals(
            bytes(0xAA, 0x21, 0x00, 0xEC, 0x02, 0x01, 0xE0, 0x00),
            pkts[0].copyOfRange(0, 8)
        )
        // Second packet: header + CRC only.
        assertArrayEquals(
            bytes(0xAA, 0x21, 0x00, 0x02, 0x02, 0x02, 0xE0, 0x00, 0xDE, 0x0C),
            pkts[1]
        )
    }

    @Test
    fun `237 bytes splits into two chunks`() {
        val pkts = G2Transport.buildPackets(
            syncId = 1, serviceId = G2ServiceID.EVEN_HUB, payload = ByteArray(237)
        )
        assertEquals(2, pkts.size)
        assertEquals(8 + 236, pkts[0].size)      // header + full chunk
        assertEquals(8 + 1 + 2, pkts[1].size)    // header + 1 byte + CRC
    }

    // ---- counters ----

    @Test
    fun `counters wrap at 8 bits like Swift overflow-add`() {
        val c = G2SendCounters()
        repeat(255) { c.nextSyncId() }
        assertEquals(255, c.nextSyncId())
        assertEquals(0, c.nextSyncId())   // wraps, does not throw or reach 256
    }

    // ---- page builder ----

    /**
     * Every page must carry the full-canvas evt-0 capture container FIRST, or the firmware
     * unbinds input and only the system double-press survives (FUT-160). Asserting on the
     * container count is the cheapest way to catch it going missing.
     */
    @Test
    fun `pageMessage always prepends the evt-0 capture container`() {
        val tc = G2EvenHub.textContainer(
            x = 0, y = 0, width = 576, height = 288, containerID = 1, content = "hi"
        )
        val msg = G2EvenHub.pageMessage(
            textContainers = listOf(tc), imageContainers = emptyList(),
            rebuild = false, magicRandom = 0
        )
        // field1 of the page container is the total count: 1 real + 1 evt-0 = 2.
        // It appears in the encoded stream as varint 0x02 after the 0x08 tag.
        val h = hex(msg)
        assert(h.contains("08 02")) { "expected container total of 2 (evt-0 + 1 text), got: $h" }
        assert(h.contains("65 76 74 2D 30")) { "expected the literal name 'evt-0' in the page: $h" }
    }

    /**
     * The showText path end to end. `textPageMessage` is what puts the first pixel on the HUD,
     * so it gets the same evt-0 assertion plus a check that the caller's text survives the
     * nesting (page -> container -> content) intact as UTF-8.
     */
    @Test
    fun `textPageMessage carries the text and the evt-0 container`() {
        val h = hex(G2EvenHub.textPageMessage("HI", rebuild = false, magicRandom = 0))
        assert(h.contains("08 02")) { "expected container total of 2 (evt-0 + text), got: $h" }
        assert(h.contains("65 76 74 2D 30")) { "expected 'evt-0' in the page: $h" }
        assert(h.contains("66 66 73 2D 74 78 74")) { "expected the name 'ffs-txt': $h" }
        assert(h.contains("48 49")) { "expected the literal text 'HI': $h" }
    }

    /**
     * An EMPTY string must go out as a single space. The firmware treats a zero-length content
     * field as "no content" and leaves the previous page up, which reads on-glass as showText
     * having silently done nothing.
     */
    @Test
    fun `textPageMessage substitutes a space for empty text`() {
        val h = hex(G2EvenHub.textPageMessage("", rebuild = false, magicRandom = 0))
        // field 12 (content), wire type 2 -> tag 0x62, length 1, ' ' = 0x20.
        assert(h.contains("62 01 20")) { "expected a single-space content field, got: $h" }
    }

    /** createStartupPage (cmd 0, sub-field 3) vs rebuildPage (cmd 7, sub-field 7). */
    @Test
    fun `pageMessage picks createStartupPage first and rebuildPage after`() {
        val create = G2EvenHub.textPageMessage("x", rebuild = false, magicRandom = 0)
        val rebuild = G2EvenHub.textPageMessage("x", rebuild = true, magicRandom = 0)
        // f1=Cmd: 0x08 tag then the command id.
        assertArrayEquals(bytes(0x08, 0x00), create.copyOfRange(0, 2))
        assertArrayEquals(bytes(0x08, 0x07), rebuild.copyOfRange(0, 2))
        // The page rides sub-field 3 on create and sub-field 7 on rebuild:
        // (3<<3)|2 = 0x1A, (7<<3)|2 = 0x3A.
        assertEquals(0x1A, create[4].toInt() and 0xFF)
        assertEquals(0x3A, rebuild[4].toInt() and 0xFF)
    }

    // ---- the auth handshake, byte for byte ----
    //
    // These four messages ARE the session. If any one of them is malformed the glasses accept
    // the connection, bind every characteristic, and then ignore everything we send -- which
    // presents as "connected but nothing renders" and costs an on-glass session to localize.

    @Test
    fun `auth handshake golden vectors`() {
        // AuthMgr{secAuth=true, phoneType=3}: f1=cmd(4), f2=magic, f3={f1=1, f2=3}
        assertArrayEquals(
            bytes(0x08, 0x04, 0x10, 0x00, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x03),
            G2DevSettings.authCmd(magicRandom = 0)
        )
        // pipeRoleChange: f1=cmd(5), f2=magic, f4={f1=RIGHT(1)}
        assertArrayEquals(
            bytes(0x08, 0x05, 0x10, 0x00, 0x22, 0x02, 0x08, 0x01),
            G2DevSettings.pipeRoleChange(magicRandom = 0)
        )
        // skipOnboarding: f1=CONFIG(1), f2=magic, f3={f1=FINISH(4)}
        assertArrayEquals(
            bytes(0x08, 0x01, 0x10, 0x00, 0x1A, 0x02, 0x08, 0x04),
            G2Onboarding.skip(magicRandom = 0)
        )
        // gesture_ctrl init: f1=0 opcode, f2=magic
        assertArrayEquals(bytes(0x08, 0x00, 0x10, 0x00), G2GestureCtrl.initCmd(magicRandom = 0))
        // setHeadUpSwitch(false): f1=deviceReceiveInfo(1), f2=magic, f3={f4={f1=0}}
        assertArrayEquals(
            bytes(0x08, 0x01, 0x10, 0x00, 0x1A, 0x04, 0x22, 0x02, 0x08, 0x00),
            G2Setting.setHeadUpSwitch(magicRandom = 0, enabled = false)
        )
    }

    /**
     * timeSync carries a wall-clock value, so it cannot have a fixed golden vector. What CAN be
     * pinned is the framing -- in particular field 128, whose two-byte tag (0x82 0x08) is the
     * only multi-byte field tag in the whole handshake and therefore the one most likely to be
     * mis-encoded.
     */
    @Test
    fun `timeSync frames the timestamp under field 128`() {
        val msg = G2DevSettings.timeSync(magicRandom = 0, nowMillis = 1_700_000_000_000L)
        // f1 = TIME_SYNC(128) -> tag 0x08, varint 0x80 0x01; f2 = magic -> 0x10 0x00.
        assertArrayEquals(bytes(0x08, 0x80, 0x01, 0x10, 0x00), msg.copyOfRange(0, 5))
        // f128, wire type 2 -> tag varint 1026 = 0x82 0x08.
        assertArrayEquals(bytes(0x82, 0x08), msg.copyOfRange(5, 7))
    }

    @Test
    fun `heartbeat is cmd 12 under sub-field 14`() {
        // f1=12, f2=magic, f14={} -> (14<<3)|2 = 0x72, length 0.
        assertArrayEquals(
            bytes(0x08, 0x0C, 0x10, 0x00, 0x72, 0x00),
            G2EvenHub.heartbeat(magicRandom = 0)
        )
    }

    // ---- inbound: reassembly ----

    /**
     * TX -> RX round trip. The reassembler is the only inbound code path and it was written by
     * reading the framer backwards; sending real framed bytes through it is the cheapest way to
     * prove the two halves agree on the header layout, the CRC strip and the chunk boundaries.
     */
    @Test
    fun `reassembler round-trips a multi-packet message`() {
        val payload = ByteArray(600) { (it and 0xFF).toByte() }
        val pkts = G2Transport.buildPackets(
            syncId = 42, serviceId = G2ServiceID.EVEN_HUB, payload = payload
        )
        assertEquals("600 bytes must span 3 packets", 3, pkts.size)

        val rx = G2RxReassembler()
        assertEquals(null, rx.feed(pkts[0]))
        assertEquals(null, rx.feed(pkts[1]))
        val done = rx.feed(pkts[2])
        assertEquals(G2ServiceID.EVEN_HUB, done?.first)
        assertArrayEquals(payload, done?.second)
    }

    @Test
    fun `reassembler round-trips a single-packet message`() {
        val payload = bytes(0xDE, 0xAD, 0xBE, 0xEF)
        val pkts = G2Transport.buildPackets(
            syncId = 1, serviceId = G2ServiceID.G2_SETTING, payload = payload
        )
        val done = G2RxReassembler().feed(pkts[0])
        assertEquals(G2ServiceID.G2_SETTING, done?.first)
        assertArrayEquals(payload, done?.second)
    }

    /** A nonzero resultCode in the status byte (bits 1-4) means the glasses rejected it. */
    @Test
    fun `reassembler drops frames carrying a nonzero result code`() {
        val ok = bytes(0xAA, 0x21, 0x00, 0x03, 0x01, 0x01, 0xE0, 0x00, 0x07, 0xFF, 0xFF)
        assertEquals(1, G2RxReassembler().feed(ok)?.second?.size)
        val bad = ok.copyOf()
        bad[7] = 0x02 // resultCode 1
        assertEquals(null, G2RxReassembler().feed(bad))
    }

    /**
     * A malformed last packet claiming a payload length below the 2-byte CRC would compute a
     * negative slice. Swift trapped; here it must be dropped, because this runs on the BLE
     * callback path and a throw takes the link down over one bad frame.
     */
    @Test
    fun `reassembler survives a truncated frame instead of throwing`() {
        assertEquals(null, G2RxReassembler().feed(bytes(0xAA, 0x21, 0x00, 0x01, 0x01, 0x01, 0xE0, 0x00)))
        assertEquals(null, G2RxReassembler().feed(bytes(0xAA, 0x21)))
        assertEquals(null, G2RxReassembler().feed(bytes(0xBB, 0x21, 0x00, 0x02, 0x01, 0x01, 0xE0, 0x00)))
    }

    // ---- inbound: gesture decode ----

    /** Build the evenhub_main_msg_ctx{cmd=2, f13=SendDeviceEvent{...}} the firmware sends. */
    private fun deviceEvent(subField: Int, sub: ByteArray): ByteArray {
        val ev = G2ProtobufWriter()
        ev.writeMessageField(subField, sub)
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, 2) // rspOsNotifyEvent
        w.writeInt32Field(2, 0) // magic
        w.writeMessageField(13, ev.data)
        return w.data
    }

    @Test
    fun `parseGesture decodes a SysEvent double tap with its source`() {
        val sys = G2ProtobufWriter()
        sys.writeInt32Field(1, 3) // OsEventType.doubleClick
        sys.writeInt32Field(2, 1) // eventSource = temple pad
        val g = G2EvenHub.parseGesture(deviceEvent(3, sys.data))
        assertEquals("double_tap", g?.name)
        assertEquals(1, g?.source)
    }

    /**
     * THE FUT-160 regression. Protobuf omits zero-valued fields, so a single press arrives as a
     * SysEvent with an eventSource and NO eventType at all. Reading "absent" as "not a gesture"
     * is why single-tap went missing on text pages for an entire build.
     */
    @Test
    fun `parseGesture treats an absent SysEvent eventType as a tap`() {
        val sys = G2ProtobufWriter()
        sys.writeInt32Field(2, 3) // eventSource only -- no eventType field
        val g = G2EvenHub.parseGesture(deviceEvent(3, sys.data))
        assertEquals("tap", g?.name)
        assertEquals(3, g?.source)
    }

    /**
     * A tap on a text container arrives as a TextEvent with the type at field 3, and carries NO
     * eventSource -- permanently source-blind, which is precisely why the ring's input route was
     * locked to the phone link instead of this one.
     */
    @Test
    fun `parseGesture decodes a TextEvent swipe with a null source`() {
        val text = G2ProtobufWriter()
        text.writeInt32Field(3, 1) // OsEventType.scrollTop
        val g = G2EvenHub.parseGesture(deviceEvent(2, text.data))
        assertEquals("swipe_up", g?.name)
        assertEquals(null, g?.source)
    }

    @Test
    fun `parseGesture decodes a ListEvent and rejects non-gesture traffic`() {
        val list = G2ProtobufWriter()
        list.writeInt32Field(5, 2) // OsEventType.scrollBottom
        assertEquals("swipe_down", G2EvenHub.parseGesture(deviceEvent(1, list.data))?.name)

        // cmd != 2 is not a device event at all (heartbeat ack, IMU, ...).
        val notAnEvent = G2ProtobufWriter()
        notAnEvent.writeInt32Field(1, 12)
        notAnEvent.writeInt32Field(2, 0)
        assertEquals(null, G2EvenHub.parseGesture(notAnEvent.data))
    }

    /**
     * The exact chain `G2Central.simulateGesture` drives: build the firmware-shaped event ->
     * frame it through the real transport -> reassemble -> decode. Worth pinning as one test,
     * because a simulator that only satisfies its own decoder is worse than no simulator: it
     * would keep reporting green after a protocol change broke the real path.
     */
    @Test
    fun `a simulated gesture survives framing and reassembly end to end`() {
        for ((name, eventType) in listOf(
            "tap" to 0, "swipe_up" to 1, "swipe_down" to 2, "double_tap" to 3
        )) {
            val sys = G2ProtobufWriter()
            sys.writeInt32Field(1, eventType)
            sys.writeInt32Field(2, 1) // eventSource = temple pad
            val msg = G2ProtobufWriter()
            msg.writeInt32Field(1, 2) // rspOsNotifyEvent
            msg.writeInt32Field(2, 0)
            msg.writeMessageField(13, deviceEventBody(3, sys.data))

            val rx = G2RxReassembler()
            var decoded: G2GestureDecode? = null
            for (pkt in G2Transport.buildPackets(
                syncId = 0, serviceId = G2ServiceID.EVEN_HUB, payload = msg.data, reserveFlag = true
            )) {
                rx.feed(pkt)?.let { (svc, payload) ->
                    assertEquals(G2ServiceID.EVEN_HUB, svc)
                    decoded = G2EvenHub.parseGesture(payload)
                }
            }
            assertEquals("simulated '$name' must decode back to itself", name, decoded?.name)
            assertEquals(1, decoded?.source)
        }
    }

    /** SendDeviceEvent{ f<subField> = sub }. */
    private fun deviceEventBody(subField: Int, sub: ByteArray): ByteArray {
        val ev = G2ProtobufWriter()
        ev.writeMessageField(subField, sub)
        return ev.data
    }

    // ---- inbound: image ACK ----

    @Test
    fun `parseImageAck reads session, fragment and the success code`() {
        fun ack(errorCode: Int, session: Int, fragment: Int): ByteArray {
            val res = G2ProtobufWriter()
            res.writeInt32Field(3, session)
            res.writeInt32Field(6, fragment)
            res.writeInt32Field(8, errorCode)
            val w = G2ProtobufWriter()
            w.writeMessageField(6, res.data)
            return w.data
        }
        val ok = G2EvenHub.parseImageAck(ack(4, 7, 2))
        assertEquals(7, ok?.session)
        assertEquals(2, ok?.fragment)
        assertEquals(true, ok?.success)
        // errorCode 4 is the ONLY success value; anything else is a failed fragment.
        assertEquals(false, G2EvenHub.parseImageAck(ack(1, 7, 2))?.success)
        // Not an image ack at all.
        assertEquals(null, G2EvenHub.parseImageAck(bytes(0x08, 0x02)))
    }

    // ---- 4-bit BMP ----

    /**
     * The signedness trap. A white pixel is 0xFF, which as a Kotlin Byte is -1; without an
     * `and 0xFF` mask before the `shr 4` the sign bit drags through and every bright pixel
     * encodes as palette index 15 or 0 depending on the shift, i.e. the image comes out
     * inverted or black. Two pixels is enough to catch it.
     */
    @Test
    fun `build4BitBmp packs high pixel values without sign extension`() {
        val bmp = G2EvenHub.build4BitBmp(bytes(0xFF, 0x00), width = 2, height = 1)!!
        val headerSize = 14 + 40 + 64
        // One row, 1 byte of 4-bit pixels, padded to 4.
        assertEquals(headerSize + 4, bmp.size)
        assertArrayEquals(bytes(0x42, 0x4D), bmp.copyOfRange(0, 2)) // "BM"
        // pixel0 = 0xFF -> index 15 in the high nibble; pixel1 = 0x00 -> index 0 in the low.
        assertEquals(0xF0, bmp[headerSize].toInt() and 0xFF)
        assertArrayEquals(bytes(0x00, 0x00, 0x00), bmp.copyOfRange(headerSize + 1, headerSize + 4))
    }

    @Test
    fun `build4BitBmp rejects a buffer smaller than its dimensions`() {
        assertEquals(null, G2EvenHub.build4BitBmp(ByteArray(3), width = 2, height = 2))
        assertEquals(null, G2EvenHub.build4BitBmp(ByteArray(4), width = 0, height = 2))
    }

    @Test
    fun `testImageBmp produces a well-formed 200x100 bitmap`() {
        val bmp = G2EvenHub.testImageBmp()!!
        // 200 px = 100 bytes per row, already 4-byte aligned; 100 rows.
        assertEquals(14 + 40 + 64 + 100 * 100, bmp.size)
        assertArrayEquals(bytes(0x42, 0x4D), bmp.copyOfRange(0, 2))
    }

    // ---- R1 ring gesture decode ----

    /**
     * The ring's swipe direction is decided by `param < 0x80`. As a signed Kotlin Byte, 0x80 is
     * -128 -- which IS less than 0x80 -- so an unmasked comparison reports every swipe_down as a
     * swipe_up. Exactly one operator separates a working scroll from a scroll that only ever
     * goes one way, and nothing about it fails to compile.
     */
    @Test
    fun `R1Gesture decodes all five gestures with unsigned params`() {
        assertEquals("hold", R1Gesture.parse(bytes(0xFF, 0x03, 0x00)))
        assertEquals("single_tap", R1Gesture.parse(bytes(0xFF, 0x04, 0x01)))
        assertEquals("double_tap", R1Gesture.parse(bytes(0xFF, 0x04, 0x02)))
        assertEquals("swipe_up", R1Gesture.parse(bytes(0xFF, 0x05, 0x7F)))
        assertEquals("swipe_down", R1Gesture.parse(bytes(0xFF, 0x05, 0x80)))
        assertEquals("swipe_down", R1Gesture.parse(bytes(0xFF, 0x05, 0xFF)))
    }

    @Test
    fun `R1Gesture rejects frames it does not understand`() {
        assertEquals(null, R1Gesture.parse(bytes(0xFF, 0x04, 0x09))) // unmapped tap param
        assertEquals(null, R1Gesture.parse(bytes(0xFF, 0x07, 0x01))) // unmapped type
        assertEquals(null, R1Gesture.parse(bytes(0xAA, 0x03, 0x00))) // wrong marker
        assertEquals(null, R1Gesture.parse(bytes(0xFF, 0x03)))       // too short
    }

    // ---- CFW resident-loader status (field 104, LD04) ----

    /**
     * The loader's frame-validation block sits at bytes 52..68 of a 68-byte LD04 record.
     * The parser used to stop at 52, so every refusal reason was discarded — and a refused
     * push is indistinguishable from a dead link without it.
     */
    @Test
    fun `parseDeviceInfo decodes the loader's frame-rejection reason`() {
        fun ld(vararg words: Int): ByteArray {
            val b = ByteArray(4 + words.size * 4)
            "LD04".toByteArray(Charsets.US_ASCII).copyInto(b)
            words.forEachIndexed { i, w ->
                for (k in 0 until 4) b[4 + i * 4 + k] = ((w shr (8 * k)) and 0xFF).toByte()
            }
            return b
        }
        // gen,ran,ret,len, calls,rxlen,first4, disp,svc0..3, rej,rej_code, crc_want,crc_got
        val rec = ld(0, 0, 0, 0, 0, 0, 0, 65, 9, 0xE0, 0xE0, 0x103, 7, 3, 0, 0)
        assertEquals(68, rec.size) // LD04 is 68 bytes; the old parser stopped at 52
        val info = G2Setting.parseDeviceInfo(
            deviceInfoPayload("2.2.7.14", bytes(0xC2, 0x06, rec.size) + rec)
        )
        assertEquals(true, info?.leftVersion?.contains("rej=7/NOMAGIC(no FXP1 — not ours)"))
    }

    /** A CRC refusal additionally reports both CRCs, so corruption is provable, not inferred. */
    @Test
    fun `parseDeviceInfo reports both CRCs when the loader rejects on CRC`() {
        val b = ByteArray(4 + 16 * 4)
        "LD04".toByteArray(Charsets.US_ASCII).copyInto(b)
        fun put(i: Int, w: Int) { for (k in 0 until 4) b[4 + i * 4 + k] = ((w shr (8 * k)) and 0xFF).toByte() }
        put(13, 5)          // rej_code = CRC
        put(14, 0x1234)     // want
        put(15, 0x5678)     // got
        put(12, 1)          // rej count
        val info = G2Setting.parseDeviceInfo(
            deviceInfoPayload("2.2.7.14", bytes(0xC2, 0x06, b.size) + b)
        )
        assertEquals(true, info?.leftVersion?.contains("rej=1/CRC(payload CORRUPT)"))
        assertEquals(true, info?.leftVersion?.contains("crc want=0x1234 got=0x5678"))
    }

    // ---- CFW capability advertisement (field 100) ----

    /** A sid-0x09 device-info response: field 4 = inner{f5 = leftVersion}, plus optional extras. */
    private fun deviceInfoPayload(leftVersion: String, extras: ByteArray = ByteArray(0)): ByteArray {
        val v = leftVersion.toByteArray(Charsets.UTF_8)
        val inner = bytes(0x2A, v.size) + v          // inner field 5, wire type 2
        return bytes(0x22, inner.size) + inner + extras // outer field 4, wire type 2
    }

    /**
     * Field 100 is the CFW's capability string (`patches/settings_ext.c`). The tag is 0xA2 0x06 --
     * a TWO-byte varint, because (100 shl 3) or 2 = 802 does not fit in one. Fields 1..19 are
     * stock and single-byte, so this is the first place the reader's multi-byte tag path carries
     * anything we depend on.
     */
    @Test
    fun `parseDeviceInfo surfaces the CFW capability string from field 100`() {
        val caps = "EVENCFW/1 img576 imgz xordelta stereo fontprobe"
        val c = caps.toByteArray(Charsets.UTF_8)
        val info = G2Setting.parseDeviceInfo(
            deviceInfoPayload("2.2.7.14", bytes(0xA2, 0x06, c.size) + c)
        )
        assertEquals(caps, info?.caps)
        assertEquals(true, info?.caps?.split(" ")?.contains("imgz"))
        assertEquals(true, info?.leftVersion?.contains("⟨CAPS=$caps⟩"))
    }

    /**
     * Stock firmware, or a CFW image built without `settings_ext.c`, sends no field 100 at all.
     * `caps` must then be null rather than an empty string -- the difference between "this image
     * does not advertise capabilities" and "it advertises none" is the whole diagnostic value.
     */
    @Test
    fun `parseDeviceInfo reports null caps when the firmware advertises none`() {
        val info = G2Setting.parseDeviceInfo(deviceInfoPayload("2.2.7.14"))
        assertEquals("2.2.7.14", info?.leftVersion)
        assertEquals(null, info?.caps)
    }
}
