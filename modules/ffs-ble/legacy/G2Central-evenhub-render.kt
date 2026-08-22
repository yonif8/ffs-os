// modules/ffs-ble/legacy/G2Central-evenhub-render.kt
// QUARANTINED 2026-08-22 -- see docs/APK-CLEANUP-PLAN.md and modules/ffs-ble/legacy/README.md
//
// NOT COMPILED. This is a verbatim reference copy of the EvenHub-page / render / animation /
// image-transfer / dashboard / SDK-page methods that were removed from G2Central.kt when the
// app was trimmed to a pure BLE bridge. They depend on removed private state (pageCreated,
// pageLatches, imgAck*, anim*) and on the EvenHub page builders in legacy/G2EvenHub-pages.kt,
// so this file will not compile on its own. Kept for the on-glass parity record only.
//
// package expo.modules.ffsble  (class G2Central body fragments)
// ==========================================================================================

// ---- extracted block 1 ----
    private fun sendDashboardLocked(payload: ByteArray, target: G2Target) {
        enqueueLocked(counters.packets(G2ServiceID.DASHBOARD, payload, reserveFlag = true), target)
    }


// ---- extracted block 2 ----
    // MARK: - Display: text (the P3 "first pixel" path)

    /** Public: run the auth handshake if needed, then render [text] on the HUD. */
    fun showText(text: String) = post {
        if (!pairReadyLocked()) {
            log("showText ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        if (sessionAuthed) {
            sendTextPageLocked(text)
        } else {
            runAuthLocked {
                sendTextPageLocked(text)
                startHeartbeatsLocked()
            }
        }
    }

    /**
     * LIST-1 / the launcher primitive: declare a NATIVE list and let the glasses own it.
     *
     * Unlike [showText], this is sent once and then the phone is silent. If the firmware
     * behaves as its log strings describe, swiping scrolls and animates ON-GLASS with zero BLE
     * traffic, and we hear back only when the user selects an item. That is the whole hybrid
     * architecture in one message -- which is why this is the experiment everything else waits
     * on rather than just another render call.
     *
     * Turns [dumpInbound] on for the duration, because the reply's shape is unknown.
     */
    /**
     * Declare a native list and push a payload at it as ONE atomic action.
     *
     * The two-step form (broadcast the list, then broadcast the payload) is not runnable from a
     * remote driver: the round trip between two external commands is tens of seconds, and this
     * link drops and re-pairs on roughly that cadence. Every time it does, JS re-renders its home
     * page via [showText] and the list the payload was built to find no longer exists -- which is
     * exactly what container_census_probe measured (ret=0x6C8780AF: two nodes, lowest id 0, no
     * id 3). Sequencing both on this queue collapses that window to [settleMs].
     *
     * The wait is a real requirement, not padding: the firmware needs time to build the page
     * before a payload can find its container. It is deliberately short so the pair has little
     * chance to churn in between.
     */
    fun showListThenPush(items: List<String>, base64: String, settleMs: Long = 1500) = post {
        if (!pairReadyLocked()) {
            log("showListThenPush ignored -- pair not ready")
            return@post
        }
        showListLocked(items)
        log("showListThenPush: list declared, payload push in ${settleMs}ms")
        schedule(settleMs) {
            if (!pairReadyLocked()) {
                log("showListThenPush: pair dropped during settle -- payload NOT pushed")
                return@schedule
            }
            pushPayloadViaImageLocked(base64)
        }
    }

    fun showList(items: List<String>) = post { showListLocked(items) }

    private fun showListLocked(items: List<String>) {
        if (!pairReadyLocked()) {
            log("showList ignored -- pair not ready (connect both lenses first)")
            return
        }
        if (items.isEmpty()) {
            log("showList ignored -- no items")
            return
        }
        dumpInbound = true
        withSessionLocked {
            stopAnimationLocked()
            val rebuild = pageCreated
            // Co-declare the anim/payload landing container ON THE LIST'S PAGE. Without this,
            // the first pushPayloadViaImage rebuilds the page to create it and the list is gone
            // before the payload executes -- measured, not guessed (container_census_probe
            // ret=0x6C8780AF). Declaring it here and asserting animContainerReady makes
            // ensureAnimContainerLocked short-circuit, so the push leaves the page alone.
            val ic = G2EvenHub.imageContainer(
                x = 0, y = 0, width = 576, height = 288,
                containerID = ANIM_CID, containerName = ANIM_NAME
            )
            val msg = G2EvenHub.listPageMessage(
                items, rebuild, counters.nextMagic(), imageContainers = listOf(ic)
            )
            sendEvenHubLocked(msg, G2Target.RIGHT)
            pageCreated = true
            animContainerReady = true
            log(
                "showList: ${if (rebuild) "rebuilt" else "created"} NATIVE list page, " +
                    "${items.size} items, ${msg.size}B -> right. Swipe now: if the highlight " +
                    "moves with NO tx traffic, the glasses own the interaction."
            )
        }
    }

    private fun sendTextPageLocked(text: String) {
        stopAnimationLocked() // a text surface replaces the page -- never push frames into it
        val rebuild = pageCreated
        val msg = G2EvenHub.textPageMessage(text, rebuild, counters.nextMagic())
        // Display content goes to the RIGHT lens (the protocol channel); the firmware mirrors
        // the page to both lenses. (P0 spec: default target = RIGHT.)
        sendEvenHubLocked(msg, G2Target.RIGHT)
        pageCreated = true
        val bytes = text.toByteArray(Charsets.UTF_8).size
        log("showText: ${if (rebuild) "rebuilt" else "created"} text page (${bytes}B) -> right")
    }

    // MARK: - Display: image (FUT-153)

    /** Public: render a test image on the HUD through our own raw-image path. */
    fun showImage() = post {
        if (!pairReadyLocked()) {
            log("showImage ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        withSessionLocked { sendImagePageLocked() }
    }

    private fun sendImagePageLocked() {
        stopAnimationLocked() // the static Image Test replaces the page -- stop any anim loop
        val bmp = G2EvenHub.testImageBmp()
        if (bmp == null) {
            log("showImage: BMP build failed")
            return
        }
        val cid = 1
        val name = "ffs-img"
        // Center a 200x100 image container on the 576x288 canvas.
        val ic = G2EvenHub.imageContainer(
            x = 188, y = 94, width = 200, height = 100, containerID = cid, containerName = name
        )
        val rebuild = pageCreated
        val page = G2EvenHub.imagePageMessage(ic, rebuild, counters.nextMagic())
        sendEvenHubLocked(page, G2Target.RIGHT)
        pageCreated = true
        log("showImage: ${if (rebuild) "rebuilt" else "created"} image page, bmp=${bmp.size}B -- 700ms settle")
        // Firmware needs ~700ms after container create/rebuild before it accepts pixels.
        schedule(700) {
            sendImageDataLocked(cid, name, bmp, 1) { ok -> log("showImage: transfer done success=$ok") }
        }
    }

    /**
     * Stream [bmp] as ACK-gated 4096-byte fragments (one image session per attempt; retry the
     * whole image with a fresh session on any fragment failure/timeout).
     */
    private fun sendImageDataLocked(
        containerID: Int,
        name: String,
        bmp: ByteArray,
        attempt: Int,
        done: (Boolean) -> Unit
    ) {
        if (bmp.isEmpty()) {
            done(false)
            return
        }
        imgSessionCounter = (imgSessionCounter + 1) and 0xFF
        val session = imgSessionCounter
        log("img: send start session=$session attempt=$attempt bytes=${bmp.size}")
        sendImageFragmentLocked(containerID, name, bmp, session, 0, 0, attempt, done)
    }

    private fun sendImageFragmentLocked(
        containerID: Int,
        name: String,
        bmp: ByteArray,
        session: Int,
        fragmentIndex: Int,
        offset: Int,
        attempt: Int,
        done: (Boolean) -> Unit
    ) {
        if (offset >= bmp.size) {
            log("img: complete session=$session fragments=$fragmentIndex")
            done(true)
            return
        }
        val end = minOf(offset + IMG_FRAGMENT_SIZE, bmp.size)
        val fragment = bmp.copyOfRange(offset, end)
        val update = G2EvenHub.imageRawDataUpdate(
            containerID = containerID, containerName = name, mapSessionId = session,
            mapTotalSize = bmp.size, compressMode = 0, mapFragmentIndex = fragmentIndex,
            mapFragmentPacketSize = fragment.size, mapRawData = fragment
        )
        val msg = G2EvenHub.updateImageMessage(update, counters.nextMagic())
        // Arm the ACK gate BEFORE sending so a fast ACK cannot race us.
        armImageAckLocked(session, fragmentIndex) { ok ->
            if (ok) {
                sendImageFragmentLocked(
                    containerID, name, bmp, session, fragmentIndex + 1, end, attempt, done
                )
            } else {
                log("img: fragment $fragmentIndex failed (session=$session) attempt=$attempt")
                if (attempt < IMG_MAX_ATTEMPTS) {
                    sendImageDataLocked(containerID, name, bmp, attempt + 1, done)
                } else {
                    log("img: FAILED after $IMG_MAX_ATTEMPTS attempts")
                    done(false)
                }
            }
        }
        sendEvenHubLocked(msg, G2Target.RIGHT)
    }

    /** Register the resolver + timeout for the fragment we are about to send. */
    private fun armImageAckLocked(session: Int, fragment: Int, completion: (Boolean) -> Unit) {
        imgAckTimer?.let { handler.removeCallbacks(it) }
        imgAckSession = session
        imgAckFragment = fragment
        imgAckResolve = completion
        val timer = guarded("imgAckTimeout") {
            if (imgAckSession != session || imgAckFragment != fragment) return@guarded
            imgAckSession = -1
            imgAckFragment = -1
            val resolve = imgAckResolve
            imgAckResolve = null
            imgAckTimer = null
            log("img: ack TIMEOUT session=$session fragment=$fragment")
            onImgAck?.invoke(session, fragment, false, true)
            resolve?.invoke(false)
        }
        imgAckTimer = timer
        handler.postDelayed(timer, IMG_ACK_TIMEOUT_MS)
    }

    /**
     * Resolve the in-flight fragment ACK (called from the notify handler). Ignores ACKs that do
     * not match the fragment we are waiting on (stale L/R dup, retry).
     */
    private fun handleImageAckLocked(session: Int, fragment: Int, success: Boolean) {
        if (imgAckSession != session || imgAckFragment != fragment) return
        imgAckSession = -1
        imgAckFragment = -1
        imgAckTimer?.let { handler.removeCallbacks(it) }
        imgAckTimer = null
        onImgAck?.invoke(session, fragment, success, false)
        // S-TRAP tier 2: a refusal means the EvenHub PAGE went away under us (the container
        // lookup the firmware fails is the same word the page's EXIT handler frees), so our
        // cached page state is now a lie and every later push would be refused identically.
        // Clears BOTH latches -- only a CREATE re-summons the page. See the class doc for the
        // mechanism and for the honest limit (this is gate A only; gate B ACKs success=true).
        pageLatches.onImageAck(success)
        val resolve = imgAckResolve
        imgAckResolve = null
        resolve?.invoke(success)
    }

    // MARK: - Animation container + frame fragmenter
    //
    // The frame GENERATOR (G2Anim / FfsDashboard rasterization) is Phase 3. What lives here is
    // the container lifecycle and the raw-bytes-over-image fragmenter, because the FUT-216
    // payload push rides exactly the same channel and needs neither of those renderers.


// ---- extracted block 3 ----
    /** Render text at explicit geometry — proves the container coordinate system. */
    fun showTextAt(text: String, x: Int, y: Int, w: Int, h: Int, border: Int = 0) = post {
        if (!pairReadyLocked()) { log("showTextAt ignored -- pair not ready"); return@post }
        withSessionLocked {
            stopAnimationLocked()
            val rebuild = pageCreated
            val msg = G2EvenHub.textPageAt(text, x, y, w, h, rebuild, counters.nextMagic(), border)
            sendEvenHubLocked(msg, G2Target.RIGHT)
            pageCreated = true
            log("showTextAt: '${text.take(20)}' at ($x,$y ${w}x$h) border=$border, ${msg.size}B -> right")
        }
    }

    /** A list with a text header on the SAME page — the mixed-container question. */
    fun showListWithHeader(items: List<String>, header: String) = post {
        if (!pairReadyLocked()) { log("showListWithHeader ignored -- pair not ready"); return@post }
        dumpInbound = true
        withSessionLocked {
            stopAnimationLocked()
            val rebuild = pageCreated
            val msg = G2EvenHub.listWithHeaderPage(items, header, rebuild, counters.nextMagic())
            sendEvenHubLocked(msg, G2Target.RIGHT)
            pageCreated = true
            log("showListWithHeader: ${items.size} items + header '$header', ${msg.size}B -> right")
        }
    }

    /** Public: stop the running animation. The next text/image surface rebuilds the page. */
    fun stopAnimation() = post { stopAnimationLocked() }

    /**
     * Stop the frame loop AND forget the landing container. Correct only for callers that
     * REPLACE the page (text/image/list surfaces, disconnects) -- after those the container
     * genuinely no longer exists on-glass.
     */
    private fun stopAnimationLocked() {
        stopAnimationLoopLocked()
        animContainerReady = false
    }

    /**
     * Stop the frame loop ONLY, leaving [animContainerReady] alone.
     *
     * The distinction matters: a caller that merely wants to avoid interleaving its own frames
     * with a running animation must NOT also declare the container gone, or the next
     * [ensureAnimContainerLocked] rebuilds the whole page. That rebuild is what silently
     * destroyed a declared list microseconds before a payload ran looking for it.
     */
    private fun stopAnimationLoopLocked() {
        if (animActive) log("anim: stop $animId")
        animActive = false
        animId = ""
    }

    private fun ensureAnimContainerLocked(done: () -> Unit) {
        if (animContainerReady) {
            done()
            return
        }
        val ic = G2EvenHub.imageContainer(
            x = 0, y = 0, width = 576, height = 288,
            containerID = ANIM_CID, containerName = ANIM_NAME
        )
        val rebuild = pageCreated
        val page = G2EvenHub.imagePageMessage(ic, rebuild, counters.nextMagic())
        sendEvenHubLocked(page, G2Target.RIGHT)
        pageCreated = true
        animContainerReady = true
        log("anim: ${if (rebuild) "rebuilt" else "created"} 576x288 container -- 700ms settle")
        schedule(700) { done() }
    }

    /**
     * Fragment a payload into updateImageRawData messages and enqueue all their transport
     * packets as ONE contiguous fire-and-forget message (no per-fragment ACK).
     */
    private fun sendAnimFrameLocked(payload: ByteArray) {
        if (payload.isEmpty()) return
        animSession = (animSession + 1) and 0xFF
        val packets = ArrayList<ByteArray>()
        var offset = 0
        var fragIdx = 0
        while (offset < payload.size) {
            val end = minOf(offset + IMG_FRAGMENT_SIZE, payload.size)
            val chunk = payload.copyOfRange(offset, end)
            val update = G2EvenHub.imageRawDataUpdate(
                containerID = ANIM_CID, containerName = ANIM_NAME, mapSessionId = animSession,
                mapTotalSize = payload.size, compressMode = 0, mapFragmentIndex = fragIdx,
                mapFragmentPacketSize = chunk.size, mapRawData = chunk
            )
            val msg = G2EvenHub.updateImageMessage(update, counters.nextMagic())
            packets.addAll(counters.packets(G2ServiceID.EVEN_HUB, msg, reserveFlag = true))
            offset = end
            fragIdx += 1
        }
        // ⛔ DO NOT CHANGE THIS TO G2Target.BOTH. Tried 2026-08-21 01:13 and it REBOOTS THE
        // PAIR on the first push: disp 11968 -> 31, gen 5 -> 0, apps 2 -> 0, dash=built ->
        // none, i.e. both lenses restarted and every installed app was wiped. [proven, once]
        //
        // Why RIGHT-only is not merely a convention: the firmware gates image-completion on
        // LENS_SIDE()==1 (the right/master lens) -- see docs/S-TRAP-report.md Gate B. A slave
        // lens receiving image-container fragments it can never complete is an untested path,
        // and it does not survive contact.
        //
        // The real problem this was an attempt to solve remains OPEN and is worth solving:
        // a payload can only be pushed to ONE lens, so the left lens cannot be probed at all
        // and everything we believe about it is inference. That is why the same class of bug
        // (left eye with no data) has been found twice by Yoni WEARING the glasses while every
        // mask stayed green -- the rig camera sees one eyebox and `ret=` is deduped across two
        // lenses that diverge. The right fix is almost certainly the sid-0x90 route
        // (`pushToService`, which already targets BOTH and is reassembled before any page
        // exists) -- S-FIX Tier 3 -- not this line.
        enqueueLocked(packets, G2Target.RIGHT)
    }


// ---- extracted block 4 ----
    /**
     * THE SDK's OUTBOUND TRANSPORT: send one EvenHub payload that the TypeScript SDK encoded.
     *
     * Not `pushToService(0xE0, ...)`, which fans out to BOTH arms -- an EvenHub page must go to
     * the RIGHT lens only, the same target every native render path uses. It also runs inside
     * `withSessionLocked`, so the first page from JS authenticates and starts the heartbeat
     * instead of being dropped on an unauthenticated link.
     *
     * The SDK decides CREATE-vs-REBUILD in its own PageSlot, but this still marks `pageCreated`,
     * because that flag means "the FIRMWARE holds a page" -- which is true no matter who put it
     * there. Leaving it false let the two models disagree: after the SDK created a page, the next
     * native render still believed the slot was empty, sent a CREATE, and the firmware silently
     * ignored it. The HUD kept showing the SDK's page and the native call looked like it had
     * simply done nothing.
     */
    fun sendEvenHubFromSdk(base64: String) = post {
        if (!pairReadyLocked()) {
            log("sendEvenHub ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        val data = decodeBase64(base64)
        if (data == null || data.isEmpty()) {
            log("sendEvenHub ignored -- bad/empty base64")
            return@post
        }
        withSessionLocked {
            sendEvenHubLocked(data, G2Target.RIGHT)
            pageCreated = true
            log("sendEvenHub: ${data.size}B -> right (SDK-encoded)")
        }
    }

    /**
     * Hand page ownership to the TypeScript SDK and report whether the firmware ALREADY holds a
     * page.
     *
     * The firmware has one page slot and silently ignores a second CREATE, so the SDK's first
     * declare must know what the native driver already did on this link -- otherwise a debug
     * render before OS boot makes the OS's opening CREATE a no-op and the HUD never changes.
     * Also stops any animation loop, which rebuilds the page underneath whatever is declared.
     */
    fun sdkTakeoverPage(): Boolean {
        // Stopping the loop is ordered onto the serial queue; the flag read is a volatile
        // snapshot. Safe to read first because no animation path ever writes `pageCreated`.
        post { stopAnimationLocked() }
        return pageCreated
    }

    /**
     * ⚠️ LEGACY TRANSPORT (quarantined 2026-08-22) — deliver a base64 native-code payload to the
     * resident CFW loader over the evenHub IMAGE channel (service 0xE0). The blob ALREADY begins
     * with the "FXP1" magic (baked in at build time) and is sent AS-IS -- the CFW strips exactly
     * one FXP1, so a second prefix would leave "FXP1" as the code's first bytes and `blx` would
     * execute the magic as garbage instructions (crash -> blank -> reboot).
     *
     * THE OLD DOC HERE WAS INVERTED. It claimed this "REPLACES the dead svc-0x90 push". The
     * opposite is now true: the CFW's FXP1 transport gate (`ffs_msgrx_gate.c`, S-FIX 2026-08-21)
     * reassembles a service message and hands it to `cfw_loader_ingest` BEFORE any page exists,
     * so a plain transport message on sid 0x90 IS the proven, page-independent delivery path
     * (proven on-glass: reads + a multi-fragment app install, both while sitting on our own
     * dashboard). This 0xE0 image channel only ever worked because it forced an EvenHub page into
     * existence to host the bytes; it dies with the EvenHub-page machinery.
     *
     * KEEP until the runtime push (usePushAck / notifications / telemetry) is repointed at
     * [pushToService] (0x90) and that render path is re-proven on-glass. Until then this is the
     * fallback the app still calls; do NOT delete it yet.
     */
    fun pushPayloadViaImage(base64: String) = post { pushPayloadViaImageLocked(base64) }

    private fun pushPayloadViaImageLocked(base64: String) {
        if (!pairReadyLocked()) {
            log("pushPayload ignored -- pair not ready (connect both lenses first)")
            return
        }
        val blob = decodeBase64(base64)
        if (blob == null || blob.isEmpty()) {
            log("pushPayload ignored -- bad/empty base64")
            return
        }
        // Stop the frame LOOP only. Using the container-invalidating variant here would force
        // ensureAnimContainerLocked to rebuild the page, wiping any list we were pushed at.
        stopAnimationLoopLocked()
        withSessionLocked {
            startHeartbeatsLocked() // keep the link alive during delivery
            ensureAnimContainerLocked {
                if (!pairReadyLocked()) return@ensureAnimContainerLocked
                sendAnimFrameLocked(blob)
                log("pushPayload -> image channel (${blob.size} B, FXP1)")
            }
        }
    }


// ---- extracted block 5 ----
    // MARK: - Native (firmware-rendered) dashboards

    /**
     * FUT-165: toggle the firmware's NATIVE "Even AI" swirl by driving the even_ai session
     * lifecycle over BLE -- no pixel streaming.
     */
    fun aiSwirl(on: Boolean) = post {
        if (!pairReadyLocked()) {
            log("aiSwirl ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        withSessionLocked {
            if (on) {
                // ⚠️ CTRL ENTER opens the MICROPHONE as well as the swirl -- `[proven]`, nine
                // matched burst/ENTER pairs in the 08-18/08-20 archive. Claim the window here
                // too, or every decorative swirl fires a false "the glasses opened their own mic".
                micStats.requestedByUs = true
                sendEvenAILocked(
                    G2EvenAI.ctrl(G2EvenAI.STATUS_ENTER, counters.nextMagic()), G2Target.BOTH
                )
                log("aiSwirl: CTRL ENTER -> native swirl on (this also opens the mic)")
                // Hold the session in the "thinking" state so the animation keeps running
                // instead of timing straight back out.
                schedule(400) {
                    sendEvenAILocked(
                        G2EvenAI.ask(" ", magicRandom = counters.nextMagic()), G2Target.BOTH
                    )
                    log("aiSwirl: ASK sustain")
                }
            } else {
                micStats.requestedByUs = false
                sendEvenAILocked(
                    G2EvenAI.ctrl(G2EvenAI.STATUS_EXIT, counters.nextMagic()), G2Target.BOTH
                )
                log("aiSwirl: CTRL EXIT -> swirl off")
            }
        }
    }

    /**
     * FUT-170 PoC: push CUSTOM content into the firmware's native head-up dashboard over BLE.
     * Re-enables the head-up trigger (we disable it by default), puts the Schedule widget
     * first, then pushes [text] as a Schedule entry. Look UP on the glasses to see it.
     */
    fun pushDashboardDemo(text: String) = post {
        if (!pairReadyLocked()) {
            log("pushDashboardDemo ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        withSessionLocked {
            sendG2SettingLocked(
                G2Setting.setHeadUpSwitch(counters.nextMagic(), true), G2Target.BOTH
            )
            sendDashboardLocked(
                G2Dashboard.displayConfig(counters.nextMagic(), listOf(3, 1, 2, 4, 5)),
                G2Target.BOTH
            )
            val tzSec = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 1000
            val end = ((System.currentTimeMillis() / 1000L) + tzSec + 3600L).toInt()
            sendDashboardLocked(
                G2Dashboard.pushSchedule(
                    magicRandom = counters.nextMagic(), scheduleId = 1, title = text,
                    location = "FFS OS", time = "now", endTimestamp = end
                ),
                G2Target.BOTH
            )
            log("dashboard demo: head-up ON + schedule-first + pushed '$text' -- look UP to see it")
        }
    }

    /**
     * FUT-170: reveal the FIRMWARE'S OWN native head-up dashboard by RELEASING our EvenHub
     * page. While our OS holds a page the stock dashboard can never surface; this shuts our
     * page down (cmd 9), re-enables the head-up trigger, and arranges the widgets our way over
     * BLE -- no firmware patch. The next showText/showImage re-creates a fresh page.
     */
    fun showStockDashboard() = post {
        if (!pairReadyLocked()) {
            log("showStockDashboard ignored -- pair not ready (connect both lenses first)")
            return@post
        }
        withSessionLocked {
            stopAnimationLocked()
            sendEvenHubLocked(G2EvenHub.shutdownPage(counters.nextMagic()), G2Target.RIGHT)
            pageCreated = false // next page re-creates fresh -- that's the way back
            sendG2SettingLocked(
                G2Setting.setHeadUpSwitch(counters.nextMagic(), true), G2Target.BOTH
            )
            sendDashboardLocked(
                G2Dashboard.displayConfig(counters.nextMagic(), listOf(3, 1, 2, 4, 5)),
                G2Target.BOTH
            )
            log("showStockDashboard: released our page + head-up ON -- Even's native dashboard now shows (look up)")
        }
    }

    /**
     * FUT-194: show the firmware's own dashboard driven fully by OUR OS over BLE, no pixels.
     * [configJSON] = { halfDay, celsius, widgetOrder:[Int],
     * schedule:[{ id, title, location?, time?, endTs? }] }.
     */
    fun showNativeDashboard(configJSON: String) {
        // Parse OFF the serial queue: JSON from JS is arbitrary-length and this is the one
        // caller that does real work before touching the radio.
        var order = listOf(3, 1, 2, 4, 5) // Schedule first by default
        var halfDay = true
        var celsius = true
        val items = ArrayList<Array<Any?>>()
        try {
            val obj = org.json.JSONObject(configJSON)
            obj.optJSONArray("widgetOrder")?.let { arr ->
                val parsed = ArrayList<Int>(arr.length())
                for (i in 0 until arr.length()) parsed.add(arr.optInt(i))
                if (parsed.isNotEmpty()) order = parsed
            }
            if (obj.has("halfDay")) halfDay = obj.optBoolean("halfDay", true)
            if (obj.has("celsius")) celsius = obj.optBoolean("celsius", true)
            obj.optJSONArray("schedule")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val it = arr.optJSONObject(i) ?: continue
                    items.add(
                        arrayOf(
                            it.optInt("id"), it.optString("title", ""),
                            it.optString("location", ""), it.optString("time", ""),
                            it.optInt("endTs", 0)
                        )
                    )
                }
            }
        } catch (e: org.json.JSONException) {
            log("showNativeDashboard: bad config JSON (${e.message}) -- using defaults")
        }

        val finalOrder = order
        post {
            if (!pairReadyLocked()) {
                log("showNativeDashboard ignored -- pair not ready (connect both lenses first)")
                return@post
            }
            withSessionLocked {
                stopAnimationLocked()
                sendEvenHubLocked(G2EvenHub.shutdownPage(counters.nextMagic()), G2Target.RIGHT)
                pageCreated = false
                sendG2SettingLocked(
                    G2Setting.setHeadUpSwitch(counters.nextMagic(), true), G2Target.BOTH
                )
                sendDashboardLocked(
                    G2Dashboard.displayConfig(counters.nextMagic(), finalOrder, halfDay, celsius),
                    G2Target.BOTH
                )
                if (items.isEmpty()) {
                    sendDashboardLocked(
                        G2Dashboard.calendarClear(counters.nextMagic()), G2Target.BOTH
                    )
                } else {
                    val total = items.size
                    for ((i, it) in items.withIndex()) {
                        sendDashboardLocked(
                            G2Dashboard.pushSchedule(
                                magicRandom = counters.nextMagic(),
                                scheduleId = it[0] as Int, title = it[1] as String,
                                location = it[2] as String, time = it[3] as String,
                                endTimestamp = it[4] as Int,
                                scheduleTotal = total, scheduleNum = i
                            ),
                            G2Target.BOTH
                        )
                    }
                }
                log(
                    "showNativeDashboard: native dashboard driven -- order $finalOrder, " +
                        "${items.size} events, ${if (halfDay) "12h" else "24h"}, " +
                        (if (celsius) "C" else "F")
                )
            }
        }
    }


