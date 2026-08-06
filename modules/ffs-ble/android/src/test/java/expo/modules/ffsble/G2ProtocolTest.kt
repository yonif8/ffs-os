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
}
