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
    /**
     * ⛔ DO NOT WRITE TO THIS unless you know exactly which field you are touching.
     * `dev_config` (0x80) looks like a settings service but is a set of developer/debug knobs.
     * `reference/g2-kit-unofficial/ble/docs/settings.md` records that poking at them **bricked a
     * pair of glasses** during early RE -- recoverable, but it took a power-cycle and a re-pair.
     * Everything a normal app needs (brightness, wear, silent, head-up, lens x/y) lives on
     * [G2_SETTING] (0x09) instead.
     */
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

    /**
     * ListContainerProperty (FUT-249 / LIST-1). The firmware carries a COMPLETE native list
     * interaction engine -- `common_list_*` -- reachable over this protobuf with no CFW at all.
     * Its own log strings describe the whole chain:
     *
     *   protobuf -> evenhub_ui_page_create -> "List container bound to events"
     *            -> evenhub_list_event_inject_adapter -> common_list_inject_event
     *            -> native focus move + scroll animation + rubber-band at the ends
     *            -> common_list_event_callback: selected_index=%d, item_name=%s
     *
     * That is declare-once / execute-natively / report-on-selection: the phone sends this once
     * and hears nothing again until the user SELECTS, while scrolling happens on-glass. It was
     * never encoded because FUT-153 closed with "List/scroll containers not needed yet".
     *
     * Layout mirrors textContainer for f1-f10, then:
     *   f11 = List_ItemContainerProperty { f1=ItemCount, f2=ItemWidth,
     *                                      f3=IsItemSelectBorderEn, f4=repeated ItemName }
     *   f12 = IsEventCapture
     *
     * ⚠️ The firmware binds events to exactly ONE container per page
     * ("evenhub_bind_event_container: already has event binding"), so a page carrying a
     * capturing list MUST NOT also carry the evt-0 container -- see pageMessage.
     */
    fun listContainer(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        containerID: Int,
        items: List<String>,
        containerName: String? = null,
        isEventCapture: Boolean = true,
        itemWidth: Int = 0,
        selectBorder: Boolean = true,
        borderWidth: Int = 0,
        borderColor: Int = 0,
        borderRadius: Int = 0,
        paddingLength: Int = 0
    ): ByteArray {
        val item = G2ProtobufWriter()
        item.writeInt32Field(1, items.size)
        item.writeInt32Field(2, if (itemWidth > 0) itemWidth else width)
        item.writeInt32Field(3, if (selectBorder) 1 else 0)
        for (name in items) item.writeStringField(4, name)

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
        w.writeMessageField(11, item.data)
        w.writeInt32Field(12, if (isEventCapture) 1 else 0)
        return w.data
    }

    /**
     * CreateStartUpPageContainer: f1=total, f2=repeated ListObject, f3=repeated TextObject,
     * f4=repeated ImageObject.
     */
    private fun createStartupPageContainer(
        textContainers: List<ByteArray>,
        imageContainers: List<ByteArray> = emptyList(),
        listContainers: List<ByteArray> = emptyList()
    ): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, textContainers.size + imageContainers.size + listContainers.size)
        for (lc in listContainers) w.writeMessageField(2, lc)
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
        magicRandom: Int,
        listContainers: List<ByteArray> = emptyList(),
        /**
         * Set when one of [listContainers] carries IsEventCapture=1. The firmware binds events
         * to exactly ONE container per page and logs
         * "evenhub_bind_event_container: already has event binding" for the rest -- so evt-0,
         * which is normally what keeps gestures alive, would STARVE a capturing list of the
         * very swipes it needs. Suppressing it is the difference between a native list that
         * scrolls and one that renders and sits frozen; the frozen case looks exactly like the
         * firmware refusing to do this at all, which is the false negative to avoid.
         */
        listOwnsEvents: Boolean = false
    ): ByteArray {
        val page = createStartupPageContainer(
            textContainers = if (listOwnsEvents) textContainers
            else listOf(eventCaptureContainer()) + textContainers,
            imageContainers = imageContainers,
            listContainers = listContainers
        )
        return if (rebuild) {
            message(G2EvenHubCmd.REBUILD_PAGE, 7, page, magicRandom)
        } else {
            message(G2EvenHubCmd.CREATE_STARTUP_PAGE, 3, page, magicRandom)
        }
    }

    /**
     * A page whose whole content is one native, interactive list. This is the LIST-1 probe and,
     * if it works, the foundation of the launcher: the phone declares it once and the glasses
     * own every scroll.
     */
    fun listPageMessage(
        items: List<String>,
        rebuild: Boolean,
        magicRandom: Int,
        containerID: Int = 3,
        containerName: String = "ffs-list",
        /**
         * Extra containers to co-declare on the list's page. The reason this exists is
         * measured, not theoretical: pushing a CFW payload rides the evenHub IMAGE channel,
         * and `ensureAnimContainerLocked` will REBUILD the whole page to create its landing
         * container if one is not already present -- destroying the list microseconds before
         * the payload runs. container_census_probe caught exactly that (ret=0x6C8780AF: two
         * nodes, lowest id 0, no id 3 -- i.e. evt-0 + the anim container, our list gone).
         * Co-declaring the anim container here keeps ONE page that satisfies both.
         */
        imageContainers: List<ByteArray> = emptyList()
    ): ByteArray {
        val lc = listContainer(
            x = 0, y = 0, width = 576, height = 288, containerID = containerID,
            items = items, containerName = containerName, isEventCapture = true
        )
        return pageMessage(
            textContainers = emptyList(), imageContainers = imageContainers,
            rebuild = rebuild, magicRandom = magicRandom,
            listContainers = listOf(lc), listOwnsEvents = true
        )
    }

    /**
     * Full text page (create or rebuild). The visible text container does NOT capture
     * events -- the evt-0 container does.
     */
    fun textPageMessage(text: String, rebuild: Boolean, magicRandom: Int): ByteArray {
        val tc = textContainer(
            x = 0, y = 0, width = 576, height = 288, containerID = 1,
            content = if (text.isEmpty()) " " else text, containerName = "ffs-txt"
        )
        return pageMessage(
            textContainers = listOf(tc), imageContainers = emptyList(),
            rebuild = rebuild, magicRandom = magicRandom
        )
    }

    /**
     * A text page at EXPLICIT geometry. Proves the container coordinate system rather than
     * assuming it: every page so far has been full-canvas 576x288, so x/y/w/h have never
     * actually been exercised and could be ignored, clamped, or interpreted from a different
     * origin without anyone noticing.
     */
    fun textPageAt(
        text: String,
        x: Int, y: Int, width: Int, height: Int,
        rebuild: Boolean,
        magicRandom: Int,
        borderWidth: Int = 0
    ): ByteArray {
        val tc = textContainer(
            x = x, y = y, width = width, height = height, containerID = 1,
            content = if (text.isEmpty()) " " else text, containerName = "ffs-geo",
            borderWidth = borderWidth
        )
        return pageMessage(
            textContainers = listOf(tc), imageContainers = emptyList(),
            rebuild = rebuild, magicRandom = magicRandom
        )
    }

    /**
     * A page carrying BOTH a capturing list and a text container -- the "can a menu have a
     * header?" question. `pageMessage` has always supported it; nobody has ever sent one.
     *
     * The list keeps the event binding (listOwnsEvents), so evt-0 is suppressed and the text is
     * pure decoration. If the firmware honours it, menu headers are free; if it drops one of the
     * two containers, every menu row has to carry its own context instead.
     */
    fun listWithHeaderPage(
        items: List<String>,
        header: String,
        rebuild: Boolean,
        magicRandom: Int
    ): ByteArray {
        val lc = listContainer(
            x = 0, y = 40, width = 576, height = 248, containerID = 3,
            items = items, containerName = "ffs-list", isEventCapture = true
        )
        val tc = textContainer(
            x = 0, y = 0, width = 576, height = 40, containerID = 1,
            content = header, containerName = "ffs-hdr", isEventCapture = false
        )
        return pageMessage(
            textContainers = listOf(tc), imageContainers = emptyList(),
            rebuild = rebuild, magicRandom = magicRandom,
            listContainers = listOf(lc), listOwnsEvents = true
        )
    }

    /** TextContainerUpgrade (updateTextData, sub-field 9): update a live container. */
    fun updateText(containerID: Int, content: String, magicRandom: Int): ByteArray {
        val u = G2ProtobufWriter()
        u.writeInt32Field(1, containerID)
        u.writeInt32Field(3, 0) // contentOffset
        u.writeInt32Field(4, content.toByteArray(Charsets.UTF_8).size) // contentLength
        u.writeStringField(5, content)
        return message(G2EvenHubCmd.UPDATE_TEXT_DATA, 9, u.data, magicRandom)
    }

    /** EvenHub heartbeat (keep-alive; FUT-159 wants ~5s cadence). */
    fun heartbeat(magicRandom: Int): ByteArray =
        message(G2EvenHubCmd.HEARTBEAT, 14, G2ProtobufWriter().data, magicRandom)

    /**
     * Shut down our EvenHub page so the firmware releases the HUD -- this is how the stock
     * DASHBOARD (or any firmware idle screen) gets to show; while we hold a page it never can.
     * Pairs with pageCreated=false so our next page re-creates fresh. (FUT-170)
     */
    fun shutdownPage(magicRandom: Int, exitMode: Int = 0): ByteArray {
        val c = G2ProtobufWriter()
        c.writeInt32Field(1, exitMode)
        return message(G2EvenHubCmd.SHUTDOWN_PAGE, 11, c.data, magicRandom)
    }

    // ---- Image containers (P4, FUT-153) ----

    /**
     * ImageContainerProperty: f1=x, f2=y, f3=width, f4=height, f5=containerID, f6=name.
     * Firmware max per container/tile = 200x100; larger images must be tiled. Max 4 image
     * containers per page.
     */
    fun imageContainer(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        containerID: Int,
        containerName: String? = null
    ): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, x)
        w.writeInt32Field(2, y)
        w.writeInt32Field(3, width)
        w.writeInt32Field(4, height)
        w.writeInt32Field(5, containerID)
        if (containerName != null) w.writeStringField(6, containerName)
        return w.data
    }

    /**
     * A page (create OR rebuild) containing one image container. Routes through
     * `pageMessage`, so it also carries the evt-0 capture container -- gestures keep working
     * while an image is shown (the image container itself cannot capture). FUT-153.
     */
    fun imagePageMessage(imageContainer: ByteArray, rebuild: Boolean, magicRandom: Int): ByteArray =
        pageMessage(
            textContainers = emptyList(), imageContainers = listOf(imageContainer),
            rebuild = rebuild, magicRandom = magicRandom
        )

    /**
     * ImageRawDataUpdate: f1=containerID, f2=name, f3=mapSessionId, f4=mapTotalSize,
     * f5=compressMode, f6=mapFragmentIndex, f7=mapFragmentPacketSize, f8=mapRawData.
     */
    fun imageRawDataUpdate(
        containerID: Int,
        containerName: String?,
        mapSessionId: Int,
        mapTotalSize: Int,
        compressMode: Int = 0,
        mapFragmentIndex: Int,
        mapFragmentPacketSize: Int,
        mapRawData: ByteArray
    ): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, containerID)
        if (containerName != null) w.writeStringField(2, containerName)
        w.writeInt32Field(3, mapSessionId)
        w.writeInt32Field(4, mapTotalSize)
        w.writeInt32Field(5, compressMode)
        w.writeInt32Field(6, mapFragmentIndex)
        w.writeInt32Field(7, mapFragmentPacketSize)
        w.writeBytesField(8, mapRawData)
        return w.data
    }

    /** Wrap an ImageRawDataUpdate as an evenhub message (cmd updateImageRawData=3, sub-field 5). */
    fun updateImageMessage(update: ByteArray, magicRandom: Int): ByteArray =
        message(G2EvenHubCmd.UPDATE_IMAGE_RAW_DATA, 5, update, magicRandom)

    /**
     * Parse an inbound image-fragment ACK (ImgResCmd = response field 6):
     * inner f8=errorCode (success == 4), f3=session, f6=fragmentIndex. Null if the payload
     * is not an image ACK.
     */
    /**
     * OsEventTypeList -- what the firmware reports a user did. From the generated schema in
     * `reference/g2-kit-unofficial/ble/gen/EvenHub_pb.ts` (MIT).
     *
     * ⚠️ There is NO long-press type. g2-kit's prose `docs/events.md` claims a long-press
     * (`status=1`); the generated schema has no such value and the audit flagged those docs as
     * contradicting their own protos. Do not design a gesture around it without proving it first.
     */
    object EventType {
        const val CLICK = 0          // single tap
        const val SCROLL_TOP = 1
        const val SCROLL_BOTTOM = 2
        const val DOUBLE_CLICK = 3   // double tap
        const val FOREGROUND_ENTER = 4
        const val FOREGROUND_EXIT = 5
        const val ABNORMAL_EXIT = 6
        const val SYSTEM_EXIT = 7

        fun name(v: Int?): String = when (v) {
            CLICK -> "click"; SCROLL_TOP -> "scroll-top"; SCROLL_BOTTOM -> "scroll-bottom"
            DOUBLE_CLICK -> "double-click"; FOREGROUND_ENTER -> "fg-enter"
            FOREGROUND_EXIT -> "fg-exit"; ABNORMAL_EXIT -> "abnormal-exit"
            SYSTEM_EXIT -> "system-exit"; else -> "type($v)"
        }
    }

    /** EventSourceType -- WHICH input produced the event. The ring is a first-class source. */
    object EventSource {
        const val NONE = 0
        const val GLASSES_R = 1
        const val RING = 2
        const val GLASSES_L = 3

        fun name(v: Int?): String = when (v) {
            GLASSES_R -> "glasses-R"; RING -> "ring"; GLASSES_L -> "glasses-L"
            NONE, null -> "none"; else -> "source($v)"
        }
    }

    /** A decoded inbound event from the glasses. */
    data class G2GlassesEvent(
        val kind: String,
        val containerId: Int? = null,
        val containerName: String? = null,
        val itemIndex: Int? = null,
        val itemName: String? = null,
        val eventType: Int? = null,
        val eventSource: Int? = null,
        val eventId: Int? = null,
        val eventData: Int? = null
    ) {
        fun describe(): String = buildString {
            append(kind)
            containerName?.let { append(" container='").append(it).append('\'') }
            containerId?.let { append(" id=").append(it) }
            if (itemIndex != null) append(" index=").append(itemIndex)
            itemName?.let { append(" item='").append(it).append('\'') }
            if (eventType != null) append(" type=").append(EventType.name(eventType))
            if (eventSource != null) append(" src=").append(EventSource.name(eventSource))
            if (eventId != null) append(" eventId=").append(eventId)
            if (eventData != null) append(" eventData=").append(eventData)
        }
    }

    private fun str(v: Any?): String? =
        (v as? ByteArray)?.toString(Charsets.UTF_8)

    /**
     * Decode an inbound EvenHub event -- THE return path of the hybrid architecture. The glasses
     * own the interaction natively and tell us only what the user chose, which is the whole point
     * of declaring a list instead of re-rendering a page per scroll.
     *
     * Envelope (evenhub_main_msg_ctx): Cmd = 1, MagicRandom = 2, DevEvent = 13, DevPrivateEvent = 16.
     *   Cmd 2  (OS_NOITY_EVENT_TO_APP_PACKET) -> DevEvent{ ListEvent=1, TextEvent=2, SysEvent=3 }
     *   Cmd 11 (OS_PRIVATE_EVENT_PACKET)      -> DevPrivateEvent{ ContainerID=1, ContainerName=2,
     *                                                             eventId=3, eventData=4 }
     *   List_ItemEvent: ContainerID=1, ContainerName=2, CurrentSelectItemName=3,
     *                   CurrentSelectItemIndex=4, EventType=5
     *   Text_ItemEvent: ContainerID=1, ContainerName=2, EventType=3
     *   Sys_ItemEvent:  EventType=1, EventSource=2
     *
     * All field numbers from the generated schema, never from the prose docs -- those disagree
     * with their own protos (see docs/G2-CAPABILITY-MAP.md).
     */
    fun decodeEvent(payload: ByteArray): G2GlassesEvent? {
        val f = G2ProtobufReader(payload).parseFields()
        val cmd = f[1] as? Int ?: return null

        (f[13] as? ByteArray)?.let { devEvent ->
            val d = G2ProtobufReader(devEvent).parseFields()
            // ⚠️ PROTO3 DEFAULT OMISSION -- the field that matters most is the one most often
            // ABSENT. Measured on-glass: tapping row 0 yields NO CurrentSelectItemIndex field at
            // all (0 is the default, so it is not encoded), and a plain CLICK yields no EventType
            // (CLICK == 0). Reading these as null would make "the user chose the first row with a
            // single tap" -- by far the commonest event -- look like a decode failure. Absent
            // scalar means 0, not unknown.
            (d[1] as? ByteArray)?.let { le ->
                val e = G2ProtobufReader(le).parseFields()
                return G2GlassesEvent(
                    kind = "list-click",
                    containerId = (e[1] as? Int) ?: 0,
                    containerName = str(e[2]),
                    itemName = str(e[3]) ?: "",
                    itemIndex = (e[4] as? Int) ?: 0,
                    eventType = (e[5] as? Int) ?: EventType.CLICK
                )
            }
            (d[2] as? ByteArray)?.let { te ->
                val e = G2ProtobufReader(te).parseFields()
                return G2GlassesEvent(
                    kind = "text-click",
                    containerId = (e[1] as? Int) ?: 0,
                    containerName = str(e[2]),
                    eventType = (e[3] as? Int) ?: EventType.CLICK
                )
            }
            (d[3] as? ByteArray)?.let { se ->
                val e = G2ProtobufReader(se).parseFields()
                return G2GlassesEvent(
                    kind = "sys-event",
                    eventType = (e[1] as? Int) ?: EventType.CLICK,
                    eventSource = (e[2] as? Int) ?: EventSource.NONE
                )
            }
        }

        (f[16] as? ByteArray)?.let { pe ->
            val e = G2ProtobufReader(pe).parseFields()
            return G2GlassesEvent(
                kind = "private-event",
                containerId = e[1] as? Int,
                containerName = str(e[2]),
                eventId = e[3] as? Int,
                eventData = e[4] as? Int
            )
        }

        // Recognised envelope, unrecognised body -- worth surfacing rather than dropping.
        if (cmd == 2 || cmd == 11) return G2GlassesEvent(kind = "event-cmd$cmd")
        return null
    }

    fun parseImageAck(payload: ByteArray): G2ImageAck? {
        val f = G2ProtobufReader(payload).parseFields()
        val resData = f[6] as? ByteArray ?: return null
        val rf = G2ProtobufReader(resData).parseFields()
        val errorCode = rf[8] as? Int ?: return null
        val session = rf[3] as? Int ?: return null
        val fragment = (rf[6] as? Int) ?: 0
        return G2ImageAck(session = session, fragment = fragment, success = errorCode == 4)
    }

    // ---- 4-bit BMP encoding (the raw-image format updateImageRawData expects) ----

    /**
     * Encode 8-bit grayscale pixels (row-major, top-down) as a 4-bit-indexed BMP (16-level
     * grayscale palette). Null if the buffer is too small for the stated dimensions.
     *
     * SIGNEDNESS: `grayscalePixels` is a Kotlin ByteArray, so every pixel read masks with
     * `and 0xFF` before the `shr 4` that picks the palette index. Without the mask a pixel
     * >= 0x80 sign-extends and `shr` drags in ones -- every bright pixel would come out
     * black. This is the exact class of bug the golden tests exist to catch.
     */
    fun build4BitBmp(grayscalePixels: ByteArray, width: Int, height: Int): ByteArray? {
        if (width <= 0 || height <= 0 || grayscalePixels.size < width * height) return null
        val bytesPerRow4bit = (width + 1) / 2
        val paddedRowSize = (bytesPerRow4bit + 3) and 3.inv()
        val pixelDataSize = paddedRowSize * height
        val headerSize = 14 + 40 + 64
        val fileSize = headerSize + pixelDataSize

        val bmp = ByteArrayOutputStream(fileSize)
        // BMP file header (14)
        bmp.write(0x42); bmp.write(0x4D) // "BM"
        bmp.le32(fileSize)
        bmp.le16(0); bmp.le16(0)
        bmp.le32(headerSize)
        // DIB header BITMAPINFOHEADER (40)
        bmp.le32(40)
        bmp.le32(width)
        bmp.le32(height) // positive -> bottom-up
        bmp.le16(1)      // planes
        bmp.le16(4)      // bpp
        bmp.le32(0)      // compression
        bmp.le32(pixelDataSize)
        bmp.le32(2835); bmp.le32(2835) // ~72 DPI
        bmp.le32(16)     // colors used
        bmp.le32(0)      // important colors
        // Color table: 16 grayscale entries (B,G,R,0)
        for (i in 0 until 16) {
            val v = i * 17
            bmp.write(v); bmp.write(v); bmp.write(v); bmp.write(0)
        }
        // Pixel data (bottom-up, 4-bit packed, rows padded to 4 bytes)
        val rowBuf = ByteArray(paddedRowSize)
        for (row in 0 until height) {
            val srcRow = height - 1 - row
            java.util.Arrays.fill(rowBuf, 0)
            for (col in 0 until width) {
                val gray8 = grayscalePixels[srcRow * width + col].toInt() and 0xFF
                val index4 = gray8 shr 4
                val bytePos = col / 2
                if (col % 2 == 0) rowBuf[bytePos] = (index4 shl 4).toByte()
                else rowBuf[bytePos] = (rowBuf[bytePos].toInt() or index4).toByte()
            }
            bmp.write(rowBuf)
        }
        return bmp.toByteArray()
    }

    /**
     * A recognizable 200x100 test bitmap through the raw-image path: white background,
     * 4px black border, black filled circle centered. Proves encode -> container -> send.
     */
    fun testImageBmp(width: Int = 200, height: Int = 100): ByteArray? {
        val px = ByteArray(width * height) { 0xFF.toByte() }
        val cx = width / 2
        val cy = height / 2
        val r = minOf(width, height) / 2 - 12
        for (y in 0 until height) {
            for (x in 0 until width) {
                val border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4
                val dx = x - cx
                val dy = y - cy
                if (border || (dx * dx + dy * dy <= r * r)) px[y * width + x] = 0
            }
        }
        return build4BitBmp(px, width, height)
    }

    // ---- Inbound gesture decode ----

    /** EvenHub response cmd for a touch/gesture event (glasses -> phone). */
    private const val RSP_OS_NOTIFY_EVENT: Int = 2

    /**
     * Decode an inbound EvenHub (0xE0) payload into a gesture name, or null if it is not a
     * nav gesture (heartbeat ack, foreground/exit, IMU, ...).
     *
     * Chain: evenhub_main_msg_ctx{cmd=2, f13=SendDeviceEvent} -> one of three sub-events,
     * each nesting an OsEventType at a DIFFERENT field number:
     *   f3 = SysEvent  -> inner f1  (system gestures: double-tap, swipe, foreground/exit)
     *   f2 = TextEvent -> inner f3  (tap/swipe on a text container -- what a tap on our HUD emits)
     *   f1 = ListEvent -> inner f5  (interaction on a list container)
     * OsEventType: 0=click(tap), 1=scrollTop(swipe up), 2=scrollBottom(swipe down), 3=doubleClick.
     * (FUT-160: a SysEvent-only decode missed single-tap on text pages -- it arrives as TextEvent.)
     *
     * `source` is `Sys_ItemEvent.eventSource` (inner field 2): 1 and 3 are the temple
     * touchpads; 2 is believed to be the R1 ring and has NEVER been observed. It exists ONLY
     * on Sys events, so a tap on a text/list container is permanently source-blind and
     * reports null. That blindness is why the ring's input route was locked to the phone link.
     */
    fun parseGesture(payload: ByteArray): G2GestureDecode? {
        val f = G2ProtobufReader(payload).parseFields()
        if ((f[1] as? Int) != RSP_OS_NOTIFY_EVENT) return null
        val devEvent = f[13] as? ByteArray ?: return null
        val df = G2ProtobufReader(devEvent).parseFields()
        // SysEvent: absent eventType => CLICK(0) => tap. Protobuf omits zero-value fields, so a
        // single-press arrives as SysEvent{eventSource} with NO eventType field at all --
        // treating "absent" as "not a gesture" was the single-tap miss.
        val sysData = df[3] as? ByteArray
        if (sysData != null) {
            val g = gestureName(sysData, 1, absentIsClick = true)
            if (g != null) return G2GestureDecode(g, eventSource(sysData))
        }
        val textData = df[2] as? ByteArray
        if (textData != null) {
            val g = gestureName(textData, 3)
            if (g != null) return G2GestureDecode(g, null)
        }
        val listData = df[1] as? ByteArray
        if (listData != null) {
            // absentIsClick, same protobuf zero-omission rule that hid single-tap on SysEvent
            // (FUT-160): a selection at index 0 with eventType CLICK omits BOTH fields.
            val g = gestureName(listData, 5, absentIsClick = true)
            if (g != null) return G2GestureDecode(g, null)
        }
        return null
    }

    /**
     * Field-by-field dump of an inbound EvenHub payload, for learning a message shape we have
     * never seen rather than guessing at it.
     *
     * The native ListContainer's reply carries a selected-item index, but its field number is
     * not documented anywhere we have and the stale `.ts` cannot be trusted for it. Printing
     * what actually arrives is faster and more honest than encoding a guess and then debugging
     * why the guess is silent. Nested length-delimited fields are recursed one level, which is
     * enough to reach SysEvent/TextEvent/ListEvent inside SendDeviceEvent.
     */
    fun describePayload(payload: ByteArray, depth: Int = 2): String {
        fun render(bytes: ByteArray, d: Int, indent: String): String {
            val sb = StringBuilder()
            for ((field, value) in G2ProtobufReader(bytes).parseFields()) {
                when (value) {
                    is Int -> sb.append("$indent f$field=$value\n")
                    is ByteArray -> {
                        val hex = value.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
                        val ascii = value.toString(Charsets.UTF_8).filter { it.code in 32..126 }
                        sb.append("$indent f$field=[${value.size}B] $hex")
                        if (ascii.length >= 2) sb.append("  \"$ascii\"")
                        sb.append("\n")
                        if (d > 0 && value.isNotEmpty()) sb.append(render(value, d - 1, "$indent  "))
                    }
                }
            }
            return sb.toString()
        }
        return render(payload, depth, "  ")
    }

    /**
     * `Sys_ItemEvent.eventSource` -- inner field 2. Null when the firmware omitted it
     * (protobuf zero-omission means source 0, if it exists, is indistinguishable from absent).
     */
    private fun eventSource(sysData: ByteArray): Int? =
        G2ProtobufReader(sysData).parseFields()[2] as? Int

    /**
     * Read the OsEventType at [field] inside a sub-event and map it to a nav-gesture name, or
     * null if it is not a nav gesture. For the SysEvent path, [absentIsClick] makes a MISSING
     * eventType decode as CLICK(0)/tap -- the firmware omits the field when its value is 0.
     */
    private fun gestureName(data: ByteArray, field: Int, absentIsClick: Boolean = false): String? {
        val f = G2ProtobufReader(data).parseFields()
        val eventType = (f[field] as? Int) ?: (if (absentIsClick) 0 else -1)
        return when (eventType) {
            0 -> "tap"
            1 -> "swipe_up"
            2 -> "swipe_down"
            3 -> "double_tap"
            else -> null
        }
    }
}

/** An inbound image-fragment ACK. */
data class G2ImageAck(val session: Int, val fragment: Int, val success: Boolean)

/** A decoded inbound gesture plus, where the firmware provides it, its input source. */
data class G2GestureDecode(val name: String, val source: Int?)

// MARK: - Little-endian byte helpers (BMP construction)

private fun ByteArrayOutputStream.le16(v: Int) {
    write(v and 0xFF); write((v ushr 8) and 0xFF)
}

private fun ByteArrayOutputStream.le32(v: Int) {
    for (i in 0 until 4) write((v ushr (8 * i)) and 0xFF)
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

// MARK: - Minimal protobuf reader (field# -> value)

/**
 * Parses the subset of protobuf we need to walk EvenHub response messages: varint fields
 * become `Int`, length-delimited fields become `ByteArray`, everything else is skipped.
 *
 * Unlike the Swift original this is defensive about malformed input at every bounds check.
 * It has to be: on iOS a bad frame would trap in `subdata`, which at least crashes loudly in
 * a debuggable place. Here `copyOfRange` would throw on a BLE callback thread, inside the
 * notification handler, and take the link down for a frame the glasses may simply have
 * truncated. Returning null and dropping the frame is the right failure mode for a radio.
 */
class G2ProtobufReader(private val data: ByteArray) {
    private var offset = 0

    private fun hasMore(): Boolean = offset < data.size

    private fun readVarint(): Long? {
        var result = 0L
        var shift = 0
        while (offset < data.size) {
            val b = data[offset].toInt() and 0xFF
            offset += 1
            result = result or ((b and 0x7F).toLong() shl shift)
            if (b and 0x80 == 0) return result
            shift += 7
            if (shift > 63) return null
        }
        return null
    }

    private fun readBytes(): ByteArray? {
        val len = readVarint() ?: return null
        if (len < 0 || len > Int.MAX_VALUE) return null
        val n = len.toInt()
        if (offset + n > data.size || offset + n < 0) return null
        val r = data.copyOfRange(offset, offset + n)
        offset += n
        return r
    }

    private fun skip(wire: Int) {
        when (wire) {
            0 -> readVarint()
            1 -> offset += 8
            2 -> readBytes()
            5 -> offset += 4
            else -> offset = data.size
        }
    }

    /** Parse into field# -> Int (varint) or ByteArray (length-delimited). */
    fun parseFields(): Map<Int, Any> {
        val out = HashMap<Int, Any>()
        while (hasMore()) {
            val tag = readVarint() ?: break
            val field = (tag ushr 3).toInt()
            when (val wire = (tag and 0x07L).toInt()) {
                // Swift stored these as Int32(truncatingIfNeeded:); Long.toInt() truncates
                // to the same low 32 bits, so a >32-bit varint decodes identically.
                0 -> readVarint()?.let { out[field] = it.toInt() }
                2 -> readBytes()?.let { out[field] = it }
                else -> skip(wire)
            }
        }
        return out
    }
}

// MARK: - Inbound transport reassembly

/**
 * Reassembles inbound 0xAA transport packets. ONE INSTANCE PER SIDE -- the left and right
 * lenses run independent syncId streams, so a shared reassembler would splice two messages
 * together whenever both arms happened to be mid-message on the same service id.
 * Mirrors the TX framing in reverse.
 */
class G2RxReassembler {
    private val partials = HashMap<String, ByteArray>()

    /**
     * Feed one raw notification packet. Returns (serviceId, fullPayload) when a message
     * completes, else null (needs more packets, or not a 0xAA frame).
     */
    fun feed(raw: ByteArray): Pair<Int, ByteArray>? {
        if (raw.size < 8) return null
        fun b(i: Int) = raw[i].toInt() and 0xFF
        if (b(0) != G2Wire.HEADER_BYTE) return null
        val payloadLen = b(3)
        if (raw.size < payloadLen + 8) return null
        val totalPackets = b(4)
        val serialNum = b(5)
        val serviceId = b(6)
        val status = b(7)
        if (((status shr 1) and 0x0F) != 0) return null // resultCode != 0
        val isLast = serialNum == totalPackets
        val end = 8 + payloadLen - (if (isLast) 2 else 0) // strip trailing CRC on last
        // Guard the Swift original could not: a last packet claiming payloadLen < 2 would
        // produce end < 8 and throw out of copyOfRange on the BLE callback thread.
        if (end < 8 || end > raw.size) return null
        val chunk = raw.copyOfRange(8, end)
        val key = "$serviceId-${b(2)}" // serviceId-syncId
        if (totalPackets > 1) {
            partials[key] = if (serialNum == 1) chunk else (partials[key] ?: ByteArray(0)) + chunk
        }
        if (!isLast) return null
        val full = if (totalPackets > 1) (partials.remove(key) ?: chunk) else chunk
        return Pair(serviceId, full)
    }

    /** Drop any half-assembled message (called when the side drops -- the stream is broken). */
    fun reset() = partials.clear()
}

// MARK: - DevSettings (auth handshake, service 0x80)

object G2DevSettings {
    /**
     * AUTHENTICATION -- AuthMgr{secAuth=true, phoneType=3}.
     *
     * phoneType 3 is PHONE_IOS, and it stays 3 on Android DELIBERATELY. It is the value the
     * handshake has been proven on-glass with; the Android-specific value is unknown and
     * unproven, and this byte gates the whole session (a rejected auth means no page, no
     * gestures, nothing). Cardinal rule 1 cuts both ways -- do not "fix" this to a guessed
     * constant without an on-glass A/B. If the glasses ever behave differently for an Android
     * host, this line is the first suspect.
     */
    fun authCmd(magicRandom: Int): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, G2DevCfgCmd.AUTHENTICATION)
        w.writeInt32Field(2, magicRandom)
        val auth = G2ProtobufWriter()
        auth.writeBoolField(1, true)
        auth.writeInt32Field(2, 3) // PHONE_IOS -- see the note above before changing
        w.writeMessageField(3, auth.data)
        return w.data
    }

    /** PIPE_ROLE_CHANGE -- asCmdRole = RIGHT(1). */
    fun pipeRoleChange(magicRandom: Int): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, G2DevCfgCmd.PIPE_ROLE_CHANGE)
        w.writeInt32Field(2, magicRandom)
        val role = G2ProtobufWriter()
        role.writeInt32Field(1, 1) // RIGHT
        w.writeMessageField(4, role.data)
        return w.data
    }

    /** TIME_SYNC -- f1 = (unix seconds + tz offset), pre-shifted so UTC reads local. */
    fun timeSync(magicRandom: Int, nowMillis: Long = System.currentTimeMillis()): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, G2DevCfgCmd.TIME_SYNC)
        w.writeInt32Field(2, magicRandom)
        val ts = G2ProtobufWriter()
        val nowSec = nowMillis / 1000L
        val tzSec = (java.util.TimeZone.getDefault().getOffset(nowMillis) / 1000L)
        ts.writeInt32Field(1, (nowSec + tzSec).toInt()) // truncate to 32 bits, like Swift
        w.writeMessageField(128, ts.data)
        return w.data
    }
}

// MARK: - Onboarding (service 0x10)

object G2Onboarding {
    /**
     * Tell the glasses onboarding is FINISHED. Until the firmware considers onboarding
     * complete, the touchpad drives its own on-glass onboarding UI and only the reserved
     * double-tap reaches the host -- single-tap + swipe are consumed locally.
     * OnboardingDataPackage{cmd=CONFIG(1), magic, config{processId=FINISH(4)}}.
     */
    fun skip(magicRandom: Int): ByteArray {
        val config = G2ProtobufWriter()
        config.writeInt32Field(1, 4) // processId = FINISH
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, 1) // commandId = CONFIG
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, config.data)
        return w.data
    }
}

// MARK: - Gesture control (service 0x0D)

object G2GestureCtrl {
    /**
     * Register the app with the on-glass gesture controller. This is what makes the firmware
     * FORWARD single-tap + swipe to the host -- without it the firmware consumes those for
     * its own UI and only the reserved double-tap reaches us. (FUT-160)
     */
    fun initCmd(magicRandom: Int): ByteArray {
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, 0) // init/register opcode
        w.writeInt32Field(2, magicRandom)
        return w.data
    }
}

// MARK: - Even AI (service 7) -- native "thinking" swirl via the AI session lifecycle

/**
 * The G2 firmware renders a GPU-smooth, dual-lens animation (the "Even AI thinking" swirl)
 * while an even_ai session is active. We drive that session over BLE to light the NATIVE
 * animation with zero pixel streaming:
 *   CTRL{status=ENTER} opens the AI card, ASK{text} holds the awaiting-reply state,
 *   CTRL{status=EXIT}  closes it.
 * EvenAIDataPackage { f1=commandId, f2=magicRandom, f3=ctrl, f5=askInfo }. (FUT-165, Path A.)
 */
object G2EvenAI {
    const val STATUS_WAKE_UP: Int = 1
    const val STATUS_ENTER: Int = 2
    const val STATUS_EXIT: Int = 3

    /** EvenAIDataPackage{ f1=commandId=CTRL(1), f2=magic, f3=EvenAIControl{ f1=status } }. */
    fun ctrl(status: Int, magicRandom: Int): ByteArray {
        val ctrlW = G2ProtobufWriter()
        ctrlW.writeInt32Field(1, status)
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, 1) // commandId = CTRL
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, ctrlW.data)
        return w.data
    }

    /** EvenAIDataPackage{ f1=ASK(3), f2=magic, f5=EvenAIAskInfo{ f2=streamEnable, f4=text } }. */
    fun ask(text: String, streamEnable: Int = 0, magicRandom: Int): ByteArray {
        val askW = G2ProtobufWriter()
        askW.writeInt32Field(2, streamEnable)
        askW.writeBytesField(4, text.toByteArray(Charsets.UTF_8))
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, 3) // commandId = ASK
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(5, askW.data)
        return w.data
    }
}

// MARK: - Device settings/info (service 0x09) -- battery + firmware version (FUT-169)

/**
 * The glasses answer a "basic settings" request with their real battery %, charging state and
 * per-lens firmware version STRING, replying on CHAR_NOTIFY. This is the ONLY real battery
 * source and the read-back the canary flash uses to prove a flash took (FUT-167).
 * G2SettingPackage{ f1=commandId, f2=magic, f4=DeviceReceiveRequestFromApp }.
 */
object G2Setting {
    /** G2SettingCommandId.deviceReceiveRequest -- "request info FROM glasses". */
    const val CMD_DEVICE_RECEIVE_REQUEST: Int = 2
    /** G2SettingCommandId.deviceReceiveInfo -- "send settings TO glasses". */
    const val CMD_DEVICE_RECEIVE_INFO: Int = 1

    /**
     * Toggle the firmware's native head-up DASHBOARD -- the stock panel that pops on the
     * look-up gesture and fights our OS for the HUD. `enabled=false` makes our OS own the
     * display; fully reversible.
     */
    fun setHeadUpSwitch(magicRandom: Int, enabled: Boolean): ByteArray {
        val headUp = G2ProtobufWriter()
        headUp.writeInt32Field(1, if (enabled) 1 else 0)
        val info = G2ProtobufWriter()
        info.writeMessageField(4, headUp.data)
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, CMD_DEVICE_RECEIVE_INFO)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, info.data)
        return w.data
    }

    /**
     * HUD BRIGHTNESS. Field numbers cross-checked against the generated schema in
     * `reference/g2-kit-unofficial/ble/gen/g2_setting_pb.ts` (MIT) -- the same file confirms our
     * existing [setHeadUpSwitch] encoding byte for byte (deviceReceiveHeadUpSetting = 4,
     * headUpSwitch = 1), which is why that envelope is reused here rather than re-derived.
     *
     *     DeviceReceive_Brightness { autoAdjust = 1, brightnessLevel = 2,
     *                                leftCalibration = 3, rightCalibration = 4 }
     *     DeviceReceiveInfoFromAPP { deviceReceiveBrightness = 1, ... }
     *
     * ⚠️ The scale is 0-100 but the mapping to actual lens output is **NONLINEAR** -- the
     * firmware converts level -> luminance -> drive current (`SVC_Settings_BrightnessLevelToLumAndCurrent`,
     * "Convert brightness level %d to current %d, lum=%d"). Do not assume 50 is "half".
     *
     * ⚠️ `level = 0` blanks the lens VISUALLY but does NOT enter any power-saving state.
     *
     * [autoAdjust] hands control to the ambient-light sensor (the firmware's ALS drives it:
     * "ALSSyncHandler, recv brightness_level:%d"). Turn it OFF to hold a level -- otherwise the
     * ALS will move the brightness back and any measurement taken through the camera rig is
     * against a moving target.
     *
     * PRACTICAL NOTE: a LOWER brightness makes the HUD markedly easier for the phone camera to
     * focus on, so this is also an instrument control for every visual proof this project makes.
     */
    fun setBrightness(
        magicRandom: Int,
        level: Int,
        autoAdjust: Boolean = false,
        leftCalibration: Int = 0,
        rightCalibration: Int = 0
    ): ByteArray {
        val b = G2ProtobufWriter()
        b.writeInt32Field(1, if (autoAdjust) 1 else 0)
        b.writeInt32Field(2, level.coerceIn(0, 100))
        if (leftCalibration != 0) b.writeInt32Field(3, leftCalibration)
        if (rightCalibration != 0) b.writeInt32Field(4, rightCalibration)
        val info = G2ProtobufWriter()
        info.writeMessageField(1, b.data)
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, CMD_DEVICE_RECEIVE_INFO)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, info.data)
        return w.data
    }

    /**
     * The rest of the sid-0x09 surface. Every one of these is the SAME envelope as
     * [setBrightness] / [setHeadUpSwitch], differing only in which `DeviceReceiveInfoFromAPP`
     * sub-field is populated:
     *
     *   deviceReceiveBrightness = 1   deviceReceiveYCoordinate = 2   deviceReceiveXCoordinate = 3
     *   deviceReceiveHeadUpSetting = 4  deviceReceiveWearDetection = 5  deviceReceiveSilentMode = 6
     *   deviceReceiveAppPage = 7      deviceReceiveAdvancedSetting = 8
     *
     * Field numbers from the generated schema, not the prose docs.
     */
    private fun infoEnvelope(magicRandom: Int, subField: Int, sub: ByteArray): ByteArray {
        val info = G2ProtobufWriter()
        info.writeMessageField(subField, sub)
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, CMD_DEVICE_RECEIVE_INFO)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, info.data)
        return w.data
    }

    private fun oneField(field: Int, value: Int): ByteArray =
        G2ProtobufWriter().apply { writeInt32Field(field, value) }.data

    /** Suppress the audio cue on container pushes and notifications. */
    fun setSilentMode(magicRandom: Int, enabled: Boolean): ByteArray =
        infoEnvelope(magicRandom, 6, oneField(1, if (enabled) 1 else 0))

    /**
     * Wear detection -- the nose-bridge PROXIMITY sensor. When it transitions worn/unworn the
     * glasses emit an async state-change event on sid 0x0d. Prefer subscribing over polling.
     */
    fun setWearDetection(magicRandom: Int, enabled: Boolean): ByteArray =
        infoEnvelope(magicRandom, 5, oneField(1, if (enabled) 1 else 0))

    /**
     * Lens X offset. Fine IPD/centering calibration -- the firmware applies it to EVERY rendered
     * frame, so it physically moves the image in the wearer's view. Range is small (~ ±20 px) and
     * it is PER-ARM.
     *
     * Also an INSTRUMENT control: this is the only way to improve the camera rig's FRAMING without
     * a human physically re-aiming the phone. See docs/VERIFICATION-RIG.md.
     */
    fun setLensX(magicRandom: Int, level: Int): ByteArray =
        infoEnvelope(magicRandom, 3, oneField(1, level))

    /** Lens Y offset. See [setLensX]. */
    fun setLensY(magicRandom: Int, level: Int): ByteArray =
        infoEnvelope(magicRandom, 2, oneField(1, level))

    /** APPRequestSettingType. Used as `settingInfoType` (field 1) on a read request. */
    const val REQ_BRIGHTNESS_INFO: Int = 0
    const val REQ_BASIC_SETTING: Int = 1

    /**
     * Decode the settings snapshot the device returns (`deviceReceiveRequestFromApp`, envelope
     * field 4). Field numbers per the generated schema; the ones marked (x) are corroborated by
     * MentraOS and faceclaw independently.
     *
     * ⚠️ `chargingStatus` is field 13 per g2-kit, but Even-G2-RE decoded a real packet on the much
     * older 2.0.7.16 and put charging at f18 with brightness at f8. Treat charging as UNVERIFIED
     * on 2.2.7.14 until we see it move on our own hardware.
     */
    data class G2SettingsSnapshot(
        val battery: Int? = null,
        val chargingStatus: Int? = null,
        val leftFirmware: String? = null,
        val rightFirmware: String? = null,
        val autoBrightnessLevel: Int? = null,
        val autoBrightnessSwitch: Int? = null,
        val headUpSwitch: Int? = null,
        val headUpAngle: Int? = null,
        val wearDetectionSwitch: Int? = null,
        val silentModeSwitch: Int? = null,
        val lensX: Int? = null,
        val lensY: Int? = null
    ) {
        fun describe(): String =
            "batt=$battery charging=$chargingStatus L=$leftFirmware R=$rightFirmware " +
                "brightness=$autoBrightnessLevel auto=$autoBrightnessSwitch " +
                "headUp=$headUpSwitch angle=$headUpAngle wear=$wearDetectionSwitch " +
                "silent=$silentModeSwitch lensX=$lensX lensY=$lensY"
    }

    fun parseSettingsSnapshot(payload: ByteArray): G2SettingsSnapshot? {
        val f = G2ProtobufReader(payload).parseFields()
        val body = f[4] as? ByteArray ?: return null
        val r = G2ProtobufReader(body).parseFields()
        return G2SettingsSnapshot(
            battery = r[12] as? Int,                       // (x)
            chargingStatus = r[13] as? Int,                // UNVERIFIED — see note above
            leftFirmware = (r[5] as? ByteArray)?.toString(Charsets.UTF_8),   // (x)
            rightFirmware = (r[6] as? ByteArray)?.toString(Charsets.UTF_8),  // (x)
            autoBrightnessLevel = r[2] as? Int,
            autoBrightnessSwitch = r[18] as? Int,
            headUpSwitch = r[7] as? Int,
            headUpAngle = r[8] as? Int,
            wearDetectionSwitch = r[10] as? Int,
            silentModeSwitch = r[14] as? Int,
            // ⚠️ x = field 4, y = field 3. Fields 15/16 are left/rightCalibrationRestored —
            // BRIGHTNESS calibration, not lens position. The wrong pair was read here until a
            // non-zero lensX set on hardware stubbornly read back absent.
            lensX = r[4] as? Int,
            lensY = r[3] as? Int
        )
    }

    /**
     * Read settings back. The reply is a full snapshot (battery, firmware, autoBrightnessLevel,
     * head-up angle, wear/silent switches, x/y lens coords) -- see `deviceReceiveRequestFromApp`
     * in the generated schema. [REQ_BRIGHTNESS_INFO] is the narrow brightness read.
     */
    fun querySettings(magicRandom: Int, settingInfoType: Int = REQ_BASIC_SETTING): ByteArray {
        val req = G2ProtobufWriter()
        req.writeInt32Field(1, settingInfoType)
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, CMD_DEVICE_RECEIVE_REQUEST)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(4, req.data)
        return w.data
    }

    /**
     * Basic-info request: G2SettingPackage{ f1=cmd(2), f2=magic,
     * f4=DeviceReceiveRequestFromApp{ f1=settingInfoType=APP_REQUIRE_BASIC_SETTING(1) } }.
     */
    fun requestDeviceInfo(magicRandom: Int): ByteArray {
        val req = G2ProtobufWriter()
        req.writeInt32Field(1, 1)
        val w = G2ProtobufWriter()
        w.writeInt32Field(1, CMD_DEVICE_RECEIVE_REQUEST)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(4, req.data)
        return w.data
    }

    data class DeviceInfo(
        var leftVersion: String? = null,
        var rightVersion: String? = null,
        var battery: Int? = null,
        var charging: Boolean? = null,
        /**
         * The raw CFW capability string, e.g. "EVENCFW/1 img576 imgz xordelta stereo fontprobe",
         * or null on stock firmware / a CFW build without `settings_ext.c`. Kept as its own field
         * (not just appended to [leftVersion]) so callers can test for a token programmatically
         * instead of substring-matching a display string.
         */
        var caps: String? = null
    )

    /** Read a little-endian u32 as a Long, so the value stays unsigned when formatted. */
    private fun u32(b: ByteArray, o: Int): Long =
        (b[o].toLong() and 0xFF) or
            ((b[o + 1].toLong() and 0xFF) shl 8) or
            ((b[o + 2].toLong() and 0xFF) shl 16) or
            ((b[o + 3].toLong() and 0xFF) shl 24)

    /**
     * Parse a service-0x09 response payload into DeviceInfo, or null if it is not a
     * device-info response. The inner DeviceReceiveRequestFromApp (field 4, or field 5 =
     * DeviceSendInfoToApp on some firmwares) carries f5=leftVersion, f6=rightVersion,
     * f12=battery, f13=charging.
     *
     * We do NOT hard-gate on the command id -- instead we require the inner message to
     * actually contain a known field, which safely rejects other service-0x09 traffic.
     *
     * Fields 101-104 at the OUTER level are OUR CFW's diagnostic channels (fontpeek, FreeType
     * font log, RAM-exec probe, resident-loader counters). They ride the version string
     * because that string is already displayed and already shipped to glog -- no new UI, no
     * new event. FUT-188 / FUT-191 / FUT-214 / FUT-216.
     */
    fun parseDeviceInfo(payload: ByteArray): DeviceInfo? {
        val f = G2ProtobufReader(payload).parseFields()
        val inner = (f[4] as? ByteArray) ?: (f[5] as? ByteArray) ?: return null
        val inf = G2ProtobufReader(inner).parseFields()
        val out = DeviceInfo()
        (inf[5] as? ByteArray)?.let { out.leftVersion = String(it, Charsets.UTF_8) }
        (inf[6] as? ByteArray)?.let { out.rightVersion = String(it, Charsets.UTF_8) }
        (inf[12] as? Int)?.let { if (it in 0..100) out.battery = it }
        (inf[13] as? Int)?.let { out.charging = it != 0 }

        // The CFW capability advertisement: field 100 = "EVENCFW/<ver> <space-separated tokens>"
        // (`g2flash/patches/settings_ext.c`). This is the ONLY way to know which CFW extensions
        // are live in the image that is actually flashed, rather than which ones are in the
        // source tree -- and it was the one extension field this parser never read, while 101-104
        // below were all wired up. That gap is load-bearing: `imgz` is the zlib image dispatch
        // that mode 2 rides on (`patches/zlib_glue.c`), so without this token an absent hook and
        // a broken encoder look exactly the same from the phone -- both just draw whatever the
        // stock BMP loader makes of the bytes. Read the token before blaming an encoder.
        (f[100] as? ByteArray)?.let { cp ->
            val caps = String(cp, Charsets.UTF_8).trim()
            out.caps = caps
            out.leftVersion = (out.leftVersion ?: "") + "  ⟨CAPS=" + caps + "⟩"
        }
        // FUT-188 "fontpeek": field 101 = the first 127 bytes of the XIP font slot 0.
        (f[101] as? ByteArray)?.let { fp ->
            val hex = fp.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
            out.leftVersion = (out.leftVersion ?: "") + "  ⟨FONTS=" + hex + "⟩"
        }
        // FUT-191: field 102 = the runtime FreeType font-name log (newline separated).
        (f[102] as? ByteArray)?.let { fl ->
            val names = String(fl, Charsets.UTF_8).split("\n").filter { it.isNotEmpty() }
                .joinToString(", ")
            out.leftVersion = (out.leftVersion ?: "") +
                "  ⟨FTFONTS=" + (if (names.isEmpty()) "(none)" else names) + "⟩"
        }
        // FUT-214 RAM-exec probe: field 103 = "RX01" + 5 LE u32s. ret == 0x2A means executing
        // RAM-pushed code WORKS (the green light for the resident loader).
        (f[103] as? ByteArray)?.let { pr ->
            if (pr.size >= 24) {
                val marker = String(pr.copyOfRange(0, 4), Charsets.US_ASCII)
                val ret = u32(pr, 4)
                val verdict = when (ret) {
                    0x2AL -> "EXEC_OK"
                    0xDEAD0000L -> "OOM"
                    else -> "UNEXPECTED"
                }
                out.leftVersion = (out.leftVersion ?: "") + String.format(
                    "  ⟨RAMEXEC %s %s ret=0x%X mpu_ctrl=0x%X mpu_type=0x%X ccr=0x%X buf=0x%08X⟩",
                    marker, verdict, ret, u32(pr, 8), u32(pr, 12), u32(pr, 16), u32(pr, 20)
                )
            }
        }
        // FUT-216 resident OTA loader: field 104 = "LD01" + gen + ran_gen + last_ret + len.
        // gen = payloads received, ran = payloads executed. ran==gen + ret==0x0A/0x0B confirms
        // the payload ran on-glass.
        (f[104] as? ByteArray)?.let { ld ->
            if (ld.size >= 20) {
                val sb = StringBuilder(
                    String.format(
                        "  ⟨LOADER gen=%d ran=%d ret=0x%X len=%d",
                        u32(ld, 4), u32(ld, 8), u32(ld, 12), u32(ld, 16)
                    )
                )
                if (ld.size >= 32) {
                    sb.append(
                        String.format(
                            " calls=%d rxlen=%d first4=0x%08X", u32(ld, 20), u32(ld, 24), u32(ld, 28)
                        )
                    )
                }
                if (ld.size >= 52) {
                    sb.append(
                        String.format(
                            " disp=%d svc=[0x%X,0x%X,0x%X,0x%X]",
                            u32(ld, 32), u32(ld, 36), u32(ld, 40), u32(ld, 44), u32(ld, 48)
                        )
                    )
                }
                // FUT-244 frame-validation block (LD04, bytes 52..68). The loader records a
                // DISTINCT reason for every frame it refuses, and we were dropping it on the
                // floor — the record is 68 bytes and this parser stopped at 52.
                //
                // That gap costs real time: a refused push and a dead BLE link look identical
                // from the phone (nothing happens, no error), which is precisely the ambiguity
                // ldr_rej_code exists to remove. See patches/loader.c LDR_REJ_*.
                if (ld.size >= 68) {
                    val rej = u32(ld, 52)
                    val code = u32(ld, 56)
                    val why = when (code) {
                        0L -> "NONE(accepted)"
                        1L -> "SHORT(no header)"
                        2L -> "CAP(over max payload)"
                        3L -> "NOMAGIC(no FXP1 — not ours)"
                        4L -> "BADLEN(body_len 0 or > arrived)"
                        5L -> "CRC(payload CORRUPT)"
                        6L -> "OOM(malloc failed)"
                        else -> "UNKNOWN($code)"
                    }
                    sb.append(String.format(" rej=%d/%s", rej, why))
                    if (code == 5L) {
                        sb.append(String.format(" crc want=0x%X got=0x%X", u32(ld, 60), u32(ld, 64)))
                    }
                }
                out.leftVersion = (out.leftVersion ?: "") + sb.toString() + "⟩"
            }
        }

        if (out.leftVersion == null && out.rightVersion == null &&
            out.battery == null && out.charging == null
        ) {
            return null
        }
        return out
    }
}

// MARK: - Stock dashboard content (service 0x01) -- FUT-170

/**
 * The firmware's native head-up dashboard renders widgets via LVGL; its CONTENT and widget
 * order are driven over BLE with a hand-rolled DashboardDataPackage on service 0x01. We can
 * (a) reorder/select which widgets appear and (b) push custom content into the SCHEDULE
 * widget. News/Stock/Weather content is Even-cloud-owned; layout/fonts need a CFW patch.
 * WidgetType: 1=News 2=Stock 3=Schedule 4=Quicklist 5=Health.
 */
object G2Dashboard {
    const val CMD_RECEIVE: Int = 2 // Dashboard_Receive (phone -> glasses push)

    /**
     * DashboardDisplayConfig: pick + order the visible widgets (+ status order, 12/24h, C/F).
     * [widgetOrder] is a packed list of WidgetType IDs; list order = on-screen order.
     */
    fun displayConfig(
        magicRandom: Int,
        widgetOrder: List<Int>,
        halfDay: Boolean = true,
        celsius: Boolean = true
    ): ByteArray {
        val orderBytes = ByteArray(widgetOrder.size) { (widgetOrder[it] and 0xFF).toByte() }
        val cfg = G2ProtobufWriter()
        cfg.writeInt32Field(1, 4)                              // displayMode
        cfg.writeInt32Field(2, 3)                              // statusDisplayCount
        cfg.writeBytesField(3, byteArrayOf(1, 2, 3))           // statusDisplayOrder
        cfg.writeInt32Field(4, widgetOrder.size)               // widgetDisplayCount
        cfg.writeBytesField(5, orderBytes)                     // widgetDisplayOrder
        cfg.writeInt32Field(6, if (halfDay) 1 else 0)          // halfDayFormat
        cfg.writeInt32Field(7, if (celsius) 1 else 2)          // temperatureUnit
        val recv = G2ProtobufWriter()
        recv.writeMessageField(2, cfg.data)                    // DashboardReceiveFromApp.f2
        val pkg = G2ProtobufWriter()
        pkg.writeInt32Field(1, CMD_RECEIVE)
        pkg.writeInt32Field(2, magicRandom)
        pkg.writeMessageField(4, recv.data)                    // DashboardDataPackage.f4
        return pkg.data
    }

    /**
     * Push ONE Schedule entry into the native dashboard's Schedule widget. For MULTI-event,
     * call once per event with [scheduleTotal] = the total count and [scheduleNum] = the
     * 0-based index (the firmware assembles the list).
     */
    fun pushSchedule(
        magicRandom: Int,
        scheduleId: Int,
        title: String,
        location: String,
        time: String,
        endTimestamp: Int,
        scheduleTotal: Int = 1,
        scheduleNum: Int = 0
    ): ByteArray {
        val sched = G2ProtobufWriter()
        sched.writeInt32Field(1, scheduleId)
        sched.writeStringField(2, title)          // <- custom display text
        sched.writeStringField(3, location)
        sched.writeStringField(4, time)
        sched.writeInt32Field(5, endTimestamp)
        val rSched = G2ProtobufWriter()
        rSched.writeInt32Field(1, scheduleTotal)  // scheduleTotal (0 = clear)
        rSched.writeInt32Field(2, scheduleNum)    // scheduleNum (0-based)
        rSched.writeMessageField(3, sched.data)   // Schedule
        rSched.writeInt32Field(4, 1)              // scheduleAuthority
        val comp = G2ProtobufWriter()
        comp.writeMessageField(3, rSched.data)    // rWidgetComponent.f3 = Schedule
        val content = G2ProtobufWriter()
        content.writeMessageField(2, comp.data)   // DashboardContent.f2
        val recv = G2ProtobufWriter()
        recv.writeInt32Field(1, 1)                // packageId
        recv.writeMessageField(3, content.data)   // DashboardReceiveFromApp.f3
        val pkg = G2ProtobufWriter()
        pkg.writeInt32Field(1, CMD_RECEIVE)
        pkg.writeInt32Field(2, magicRandom)
        pkg.writeMessageField(4, recv.data)
        return pkg.data
    }

    /** Clear the Schedule widget (scheduleTotal=0, no stale entry). */
    fun calendarClear(magicRandom: Int): ByteArray {
        val rSched = G2ProtobufWriter()
        rSched.writeInt32Field(1, 0) // scheduleTotal = 0
        rSched.writeInt32Field(2, 0) // scheduleNum
        rSched.writeInt32Field(4, 1) // scheduleAuthority
        val comp = G2ProtobufWriter()
        comp.writeMessageField(3, rSched.data)
        val content = G2ProtobufWriter()
        content.writeMessageField(2, comp.data)
        val recv = G2ProtobufWriter()
        recv.writeInt32Field(1, 1)
        recv.writeMessageField(3, content.data)
        val pkg = G2ProtobufWriter()
        pkg.writeInt32Field(1, CMD_RECEIVE)
        pkg.writeInt32Field(2, magicRandom)
        pkg.writeMessageField(4, recv.data)
        return pkg.data
    }
}
