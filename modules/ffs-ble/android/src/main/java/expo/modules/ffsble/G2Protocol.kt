package expo.modules.ffsble

import java.io.ByteArrayOutputStream

/**
 * G2Protocol.kt — Android twin of `ios/G2Protocol.swift`.
 *
 * The EvenHub wire protocol: hand-rolled protobuf codec + the 0xAA-header transport
 * framing with CRC16, plus the EvenHub message builders.
 *
 * This file is a MECHANICAL translation of the Swift original, which is pure `Foundation`
 * with zero CoreBluetooth in it. That is deliberate and worth preserving: the wire format
 * is the one part of the driver that is genuinely platform-independent, so the two files
 * should stay readable side by side. If you change one, change the other, and keep the
 * field numbers and byte layout identical -- they are the glasses' protocol, not ours.
 *
 * MIT attribution: protocol constants/field numbers derived from MentraOS
 * (https://github.com/Mentra-Community/MentraOS), MIT License. Same provenance as the
 * Swift file; see its header for the full note.
 *
 * BYTE-SIGNEDNESS WARNING. Swift has `UInt8`; Kotlin's `Byte` is SIGNED. Every read of a
 * byte-as-number here must mask with `and 0xFF`, and every write of a number-as-byte must
 * `.toByte()`. A missing mask is a silent wrong-value bug that will only show up as the
 * glasses rejecting a packet. Arithmetic is done in `Int` and masked back to width.
 */

// MARK: - Transport constants

object G2Wire {
    const val HEADER_BYTE: Int = 0xAA
    const val SOURCE_PHONE: Int = 1
    const val DEST_GLASSES: Int = 2
    const val MAX_PACKET_PAYLOAD: Int = 236
}

/** BLE service IDs (byte [6] of the transport header). */
object G2ServiceID {
    const val DASHBOARD: Int = 1
    const val EVEN_AI: Int = 7
    const val NAVIGATION: Int = 8
    const val G2_SETTING: Int = 9
    const val GESTURE_CTRL: Int = 13
    const val ONBOARDING: Int = 16
    const val DEVICE_SETTINGS: Int = 0x80
    const val EVEN_HUB_CTRL: Int = 0x81
    const val EVEN_HUB: Int = 0xE0
}

/** EvenHub command IDs (field 1 of an evenhub_main_msg_ctx). */
object G2EvenHubCmd {
    const val CREATE_STARTUP_PAGE: Int = 0
    const val UPDATE_IMAGE_RAW_DATA: Int = 3
    const val UPDATE_TEXT_DATA: Int = 5
    const val REBUILD_PAGE: Int = 7
    const val SHUTDOWN_PAGE: Int = 9
    const val HEARTBEAT: Int = 12
    const val AUDIO_CONTROL: Int = 15
    const val IMU_CONTROL: Int = 19
}

/** DevCfg command IDs (field 1 of a DevCfgDataPackage on service 0x80). */
object G2DevCfgCmd {
    const val AUTHENTICATION: Int = 4
    const val PIPE_ROLE_CHANGE: Int = 5
    const val TIME_SYNC: Int = 128
    const val BASE_CONN_HEART_BEAT: Int = 14
}

// MARK: - CRC16 (G2's custom bit-mix; init 0xFFFF)

/**
 * The glasses' CRC16. NOT a stock CCITT: it is a custom bit-mix, confirmed
 * CCITT-FALSE-family in FUT-159 section 8. Ported verbatim from `g2CRC16` in the Swift file.
 *
 * Swift did this in `UInt16`, where `<<` discards the overflow. Kotlin has no UInt16, so
 * every step masks back to 16 bits to reproduce that truncation exactly.
 */
fun g2CRC16(data: ByteArray): Int {
    var crc = 0xFFFF
    for (b in data) {
        crc = (((crc ushr 8) or ((crc shl 8) and 0xFF00)) xor (b.toInt() and 0xFF)) and 0xFFFF
        crc = (crc xor ((crc and 0xFF) ushr 4)) and 0xFFFF
        crc = (crc xor ((crc shl 12) and 0xFFFF)) and 0xFFFF
        crc = (crc xor (((crc and 0xFF) shl 5) and 0xFFFF)) and 0xFFFF
    }
    return crc and 0xFFFF
}

// MARK: - Minimal protobuf writer (hand-rolled, field-number-pinned)

class G2ProtobufWriter {
    private val out = ByteArrayOutputStream()

    val data: ByteArray get() = out.toByteArray()

    fun writeVarint(value: Long) {
        var v = value
        while (true) {
            // Note `0x7FL.inv()` and `ushr`: a NEGATIVE value must sign-extend to 64 bits and
            // emit the full 10-byte varint, matching Swift's
            // `writeVarint(UInt64(bitPattern: Int64(value)))`. A signed `shr` here would loop
            // forever on negatives.
            if ((v and 0x7FL.inv()) == 0L) {
                out.write(v.toInt())
                return
            }
            out.write(((v and 0x7FL) or 0x80L).toInt())
            v = v ushr 7
        }
    }

    fun writeInt32Field(field: Int, value: Int) {
        writeVarint(((field shl 3) or 0).toLong()) // wire type 0 (varint)
        writeVarint(value.toLong())
    }

    fun writeInt64Field(field: Int, value: Long) {
        writeVarint(((field shl 3) or 0).toLong())
        writeVarint(value)
    }

    fun writeBoolField(field: Int, value: Boolean) {
        writeInt32Field(field, if (value) 1 else 0)
    }

    fun writeStringField(field: Int, value: String) {
        writeVarint(((field shl 3) or 2).toLong()) // wire type 2 (length-delimited)
        val utf8 = value.toByteArray(Charsets.UTF_8)
        writeVarint(utf8.size.toLong())
        out.write(utf8)
    }

    fun writeBytesField(field: Int, value: ByteArray) {
        writeVarint(((field shl 3) or 2).toLong())
        writeVarint(value.size.toLong())
        out.write(value)
    }

    /** Embed a length-delimited sub-message. */
    fun writeMessageField(field: Int, sub: ByteArray) = writeBytesField(field, sub)
}

// MARK: - Transport framing (0xAA header + CRC16)

object G2Transport {
    /**
     * Split [payload] into <=236-byte transport packets. Byte layout per packet:
     *   [0]=0xAA - [1]=(dst<<4)|src=0x21 - [2]=syncId - [3]=payloadLen(+2 on last, for CRC)
     *   - [4]=packetTotalNum - [5]=packetSerialNum(1-based) - [6]=serviceId
     *   - [7]=status(bit5=reserveFlag) - payload chunk - (CRC16 LE on last packet).
     *
     * Edge case, kept from the Swift original: if the last chunk is EXACTLY 236 bytes,
     * append an empty packet to carry the CRC, so a full final chunk is not mistaken for a
     * non-terminal one.
     */
    fun buildPackets(
        syncId: Int,
        serviceId: Int,
        payload: ByteArray,
        reserveFlag: Boolean = false
    ): List<ByteArray> {
        val maxPayload = G2Wire.MAX_PACKET_PAYLOAD

        val chunks = ArrayList<ByteArray>()
        var offset = 0
        while (offset < payload.size) {
            val end = minOf(offset + maxPayload, payload.size)
            chunks.add(payload.copyOfRange(offset, end))
            offset = end
        }
        if (chunks.isEmpty()) chunks.add(ByteArray(0))
        if (chunks.last().size == maxPayload) chunks.add(ByteArray(0)) // extra-CRC-packet edge

        val totalPackets = chunks.size
        val crc = g2CRC16(payload)
        val status = if (reserveFlag) 0x20 else 0x00

        val packets = ArrayList<ByteArray>(chunks.size)
        for ((i, chunk) in chunks.withIndex()) {
            val serialNum = i + 1
            val isLast = serialNum == totalPackets
            val payloadLen = chunk.size + (if (isLast) 2 else 0)

            val pkt = ByteArrayOutputStream()
            pkt.write(G2Wire.HEADER_BYTE)
            pkt.write((G2Wire.DEST_GLASSES shl 4) or G2Wire.SOURCE_PHONE)
            pkt.write(syncId and 0xFF)
            pkt.write(payloadLen and 0xFF)
            pkt.write(totalPackets and 0xFF)
            pkt.write(serialNum and 0xFF)
            pkt.write(serviceId and 0xFF)
            pkt.write(status)
            pkt.write(chunk)
            if (isLast) {
                pkt.write(crc and 0xFF)          // CRC16 little-endian
                pkt.write((crc ushr 8) and 0xFF)
            }
            packets.add(pkt.toByteArray())
        }
        return packets
    }
}

// MARK: - EvenHub message builders (service 0xE0)

object G2EvenHub {
    /**
     * TextContainerProperty. `isEventCapture` (field 11) is THE gate for input: the firmware
     * only forwards single-press + swipe to the app when a container on the page has
     * isEventCapture=1. Without it, only the system-level double-press reaches us. Only ONE
     * container per page may capture. (FUT-160)
     */
    fun textContainer(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        containerID: Int,
        content: String,
        containerName: String? = null,
        isEventCapture: Boolean = false,
        borderWidth: Int = 0,
        borderColor: Int = 0,
        borderRadius: Int = 0,
        paddingLength: Int = 0
    ): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, x)
        w.writeInt32Field(2, y)
        w.writeInt32Field(3, width)
        w.writeInt32Field(4, height)
        w.writeInt32Field(5, borderWidth)
        w.writeInt32Field(6, borderColor)
        w.writeInt32Field(7, borderRadius)
        w.writeInt32Field(8, paddingLength)
        w.writeInt32Field(9, containerID)
        if (containerName != null) w.writeStringField(10, containerName)
        w.writeInt32Field(11, if (isEventCapture) 1 else 0)
        w.writeStringField(12, content)
        return w.data
    }

    /** CreateStartUpPageContainer: f1=total, f3=repeated TextObject, f4=repeated ImageObject. */
    private fun createStartupPageContainer(
        textContainers: List<ByteArray>,
        imageContainers: List<ByteArray> = emptyList()
    ): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, textContainers.size + imageContainers.size)
        for (tc in textContainers) w.writeMessageField(3, tc)
        for (ic in imageContainers) w.writeMessageField(4, ic)
        return w.data
    }

    /** evenhub_main_msg_ctx wrapper: f1=Cmd, f2=MagicRandom, f<sub>=payload. */
    private fun message(cmd: Int, subField: Int, sub: ByteArray, magicRandom: Int): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, cmd)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(subField, sub)
        return w.data
    }

    /**
     * A dedicated FULL-CANVAS invisible event-capture container, prepended (rendered behind)
     * on every page. It must be FULL-CANVAS, not 1x1: the arm touchpad maps to a screen
     * region, so a tiny hit-target at (0,0) misses ~70% of gestures (the build18
     * "30% detection" bug). Empty content + no border = invisible. FUT-160/FUT-153.
     */
    private fun eventCaptureContainer(): ByteArray = textContainer(
        x = 0, y = 0, width = 576, height = 288, containerID = 0,
        content = "", containerName = "evt-0", isEventCapture = true
    )

    /**
     * Build a page, always prepending the evt-0 capture container so gestures work on EVERY
     * page. `rebuild=false` -> createStartupPage (cmd 0, only valid for the FIRST page of a
     * session); `rebuild=true` -> rebuildPage (cmd 7). Sending createStartupPage twice is
     * silently ignored by the firmware -- that was the "stuck on the image, can't show text
     * again" bug (FUT-153).
     */
    fun pageMessage(
        textContainers: List<ByteArray>,
        imageContainers: List<ByteArray>,
        rebuild: Boolean,
        magicRandom: Int
    ): ByteArray {
        val page = createStartupPageContainer(
            textContainers = listOf(eventCaptureContainer()) + textContainers,
            imageContainers = imageContainers
        )
        return if (rebuild) {
            message(G2EvenHubCmd.REBUILD_PAGE, 7, page, magicRandom)
        } else {
            message(G2EvenHubCmd.CREATE_STARTUP_PAGE, 3, page, magicRandom)
        }
    }
}

// MARK: - Rolling counters

/**
 * Rolling syncId/magicRandom for the wire protocol. Both wrap at 8 bits, matching Swift's
 * `&+` overflow-add on `UInt8`.
 */
class G2SendCounters {
    private var syncId: Int = 0
    private var magic: Int = 0

    fun nextSyncId(): Int {
        val v = syncId
        syncId = (syncId + 1) and 0xFF
        return v
    }

    fun nextMagic(): Int {
        val v = magic
        magic = (magic + 1) and 0xFF
        return v
    }

    /** Build the transport packets for a service-framed payload, consuming a syncId. */
    fun packets(serviceId: Int, payload: ByteArray, reserveFlag: Boolean = false): List<ByteArray> =
        G2Transport.buildPackets(
            syncId = nextSyncId(),
            serviceId = serviceId,
            payload = payload,
            reserveFlag = reserveFlag
        )
}
