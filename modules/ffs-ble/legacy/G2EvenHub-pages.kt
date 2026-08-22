// modules/ffs-ble/legacy/G2EvenHub-pages.kt
// QUARANTINED 2026-08-22 -- see docs/APK-CLEANUP-PLAN.md and modules/ffs-ble/legacy/README.md
//
// NOT COMPILED. Verbatim reference copy of the EvenHub PAGE / IMAGE builders removed from the
// G2EvenHub object in G2Protocol.kt when the app was trimmed to a pure BLE bridge. These were
// members of `object G2EvenHub` (they call the still-live private `message(...)`/`G2ProtobufWriter`)
// plus the top-level `G2ImageAck` data class and the ByteArrayOutputStream.le16/le32 BMP helpers.
// Kept for the on-glass parity record only; will not compile on its own.
// ==========================================================================================

// ---- extracted block 1 ----
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

// ---- extracted block 2 ----
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
        // DE-EVEN (2026-08-22): never send CREATE_STARTUP_PAGE. Constructing Even's EvenHub page is
        // exactly what the firmware-level EvenHub kill faults on (its base-page ctor is redirected),
        // and our push transport no longer needs that page (page-independent FXP1 route, sid 0x90).
        // Only a CREATE (cmd 0/subtype 3) constructs the page; a REBUILD (cmd 7) with no page is a
        // harmless no-op. Downgrading CREATE->REBUILD means the glasses never construct EvenHub, so
        // they stay on our dashboard and the kill firmware never crashes. Flip SEND_EVENHUB_CREATE
        // to true only to restore Even's original summon behaviour.
        val SEND_EVENHUB_CREATE = false
        return if (rebuild || !SEND_EVENHUB_CREATE) {
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

// ---- extracted block 3 ----
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

// ---- extracted block 4 ----

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

// ---- extracted block 5 ----
/** An inbound image-fragment ACK. */
data class G2ImageAck(val session: Int, val fragment: Int, val success: Boolean)


// ---- extracted block 6 ----
// MARK: - Little-endian byte helpers (BMP construction)

private fun ByteArrayOutputStream.le16(v: Int) {
    write(v and 0xFF); write((v ushr 8) and 0xFF)
}

private fun ByteArrayOutputStream.le32(v: Int) {
    for (i in 0 until 4) write((v ushr (8 * i)) and 0xFF)
}



// ---- extracted block 7: G2Dashboard (stock dashboard content, service 0x01) ----
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
