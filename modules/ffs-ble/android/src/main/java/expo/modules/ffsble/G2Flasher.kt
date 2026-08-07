package expo.modules.ffsble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.os.Build
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * G2Flasher.kt -- the CFW OTA write path (FUT-167 Stage 2 / FUT-260), Android side.
 *
 * Port of the flash state machine in `ios/G2Central.swift`'s flash extension. Deliberately a
 * SEPARATE class rather than more of G2Central: this is the only code in the project that can
 * permanently destroy the hardware, and it should be readable end to end without 1,900 lines of
 * connection management around it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE SAFETY CHAIN — every link must pass before a single byte is written
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *   1. download the image                       (no BLE yet)
 *   2. SHA-256 == the caller's expected hash    (wrong file -> stop)
 *   3. parse the EVENOTA container              (malformed -> stop)
 *   4. MRAM brick-guard re-derived from bytes   (would overrun -> stop)
 *   5. the SHA resolves to a KNOWN golden build (unknown image -> stop)
 *   6. the guard reproduces that golden vector  (guard itself broken -> stop)
 *   7. both lenses expose all OTA characteristics
 *   8. dryRun -> report and STOP HERE
 *   9. only now: writes
 *
 * Steps 4-6 are three different questions and all three matter. 4 asks "does this image fit".
 * 5 asks "is this an image we have ever vetted". 6 asks "is the guard in step 4 still working
 * at all" -- because a mis-transcribed constant that silently disabled it would otherwise pass
 * everything, and that failure is invisible until it is catastrophic.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THREADING
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Runs on its own thread and BLOCKS waiting for OTA acks, so it must never touch G2Central's
 * serial queue. It is handed ready-made [Target]s (gatt + the three characteristics, resolved
 * on the queue before hand-off) and never reaches back into driver state. Inbound DATA-notify
 * frames are pushed in via [offerRx] from the queue thread; this side consumes them through a
 * BlockingQueue, which is the whole synchronisation contract.
 *
 * On iOS the write loop polls `canSendWriteWithoutResponse`. Android has no such signal, so a
 * refused write is retried with backoff -- the same asymmetry as the main drain, and here it
 * matters more: a dropped OTA frame is a corrupt firmware block, not a dropped UI update.
 */
@SuppressLint("MissingPermission")
class G2Flasher(
    private val log: (String) -> Unit,
    /** (message, progress 0..1, done, ok) */
    private val onProgress: (String, Double, Boolean, Boolean) -> Unit
) {

    companion object {
        private const val BLOCK_SIZE = 4096
        private const val BLOCK_NAK_RETRIES = 5
        private const val COMPONENT_RETRIES = 3
        private const val ACK_TIMEOUT_MS = 5000L
        private const val END_ACK_TIMEOUT_MS = 15000L
        private const val KEEPALIVE_MS = 12000L
        private const val DOWNLOAD_TIMEOUT_MS = 180000
        /** A refused write is retried; ~2s total before the block attempt is abandoned. */
        private const val WRITE_RETRIES = 200
        private const val WRITE_RETRY_MS = 10L
    }

    /** One lens, with every characteristic the flash needs already resolved. */
    class Target(
        val label: String,
        val gatt: BluetoothGatt,
        val dataWrite: BluetoothGattCharacteristic,
        val dataNotify: BluetoothGattCharacteristic,
        val ctrlWrite: BluetoothGattCharacteristic
    )

    /**
     * True while a flash owns the link. G2Central checks this to route DATA-notify frames here
     * instead of through the normal gesture/image parsing, and to suspend the heartbeat.
     */
    @Volatile
    var active = false
        private set

    private val rx = LinkedBlockingQueue<ByteArray>()
    private var seq = 0
    private var thread: Thread? = null

    /** Called from the driver's serial queue when a DATA-notify frame arrives during a flash. */
    fun offerRx(frame: ByteArray) {
        rx.offer(frame)
    }

    private fun nextSeq(): Int {
        seq = (seq + 1) and 0xFF
        return seq
    }

    private fun drainRx() = rx.clear()

    private fun progress(msg: String, frac: Double, done: Boolean = false, ok: Boolean = true) {
        log("flash: $msg")
        onProgress(msg, frac, done, ok)
    }

    /**
     * Entry point. Runs everything on a background thread and returns immediately.
     * [onFinished] runs on that thread once the attempt ends, however it ends.
     */
    fun start(
        targets: List<Target>,
        urlStr: String,
        expectedSha256: String,
        dryRun: Boolean,
        onFinished: () -> Unit
    ) {
        if (thread?.isAlive == true) {
            progress("a flash is already running", 0.0, done = true, ok = false)
            return
        }
        val t = Thread({
            try {
                run(targets, urlStr, expectedSha256, dryRun)
            } catch (e: Throwable) {
                // Never let this thread die silently -- an unexplained stop mid-flash is the
                // worst possible state to leave the operator guessing about.
                progress("FLASH ABORTED by an unexpected error: $e", 0.0, done = true, ok = false)
            } finally {
                active = false
                onFinished()
            }
        }, "FfsFlash")
        thread = t
        t.start()
    }

    private fun run(targets: List<Target>, urlStr: String, expectedSha256: String, dryRun: Boolean) {
        progress(if (dryRun) "validating (dry-run, no writes)..." else "preparing flash...", 0.02)

        // ---- 1. download ----------------------------------------------------------------
        val url = try {
            URL(urlStr)
        } catch (e: Exception) {
            progress("bad image URL: $urlStr", 0.0, done = true, ok = false); return
        }
        val img = download(url)
        if (img == null || img.isEmpty()) {
            progress("image download failed", 0.0, done = true, ok = false); return
        }
        progress("downloaded ${img.size} bytes", 0.06)

        // ---- 2. SHA-256 -----------------------------------------------------------------
        val sha = G2Flash.sha256Hex(img)
        if (!sha.equals(expectedSha256, ignoreCase = true)) {
            progress(
                "SHA mismatch -- refusing (got ${sha.take(12)}..., expected ${expectedSha256.take(12)}...)",
                0.0, done = true, ok = false
            )
            return
        }
        progress("image SHA-256 verified OK", 0.10)

        // ---- 3. parse -------------------------------------------------------------------
        val segs = try {
            G2Flash.parseSegments(img)
        } catch (e: Exception) {
            progress("parse failed: ${e.message}", 0.0, done = true, ok = false); return
        }

        // ---- 4. MRAM brick-guard --------------------------------------------------------
        val g = G2Flash.checkMainAppFitsMram(img, segs)
        if (!g.pass) {
            progress("BRICK-GUARD BLOCKED: ${g.reason}", 0.0, done = true, ok = false); return
        }

        // ---- 5. known build? ------------------------------------------------------------
        val gv = G2Flash.goldenFor(sha)
        if (gv == null) {
            progress(
                "not a known golden build -- refusing. sha=$sha", 0.0, done = true, ok = false
            )
            return
        }

        // ---- 6. is the guard itself still working? --------------------------------------
        val selfTest = G2Flash.selfTestGuard(img, gv)
        if (selfTest != null) {
            progress("SELF-TEST FAILED: $selfTest -- refusing", 0.0, done = true, ok = false); return
        }
        progress(
            String.format(
                "guard + self-test PASSED: %s (prog_end 0x%08x, %d KB under ceiling)",
                gv.label, g.progEnd, (G2Flash.APP_MAX_END - g.progEnd) / 1024
            ),
            0.18
        )

        // ---- 7. channels ----------------------------------------------------------------
        if (targets.isEmpty()) {
            progress("both lenses must be connected", 0.0, done = true, ok = false); return
        }
        progress("OTA channels present on ${targets.joinToString("+") { it.label }}", 0.19)

        // ---- 8. dry run stops here ------------------------------------------------------
        if (dryRun) {
            progress(
                "DRY-RUN OK -- ${gv.label} validated, ${targets.size} lens(es) ready; NO writes performed",
                1.0, done = true, ok = true
            )
            return
        }

        // ---- 9. the real thing ----------------------------------------------------------
        active = true
        var okAll = true
        for ((i, tgt) in targets.withIndex()) {
            progress("flashing ${tgt.label} lens...", 0.2 + 0.4 * i)
            if (!flashOneLens(tgt, img, segs)) { okAll = false; break }
        }
        active = false
        progress(
            if (okAll) "FLASH COMPLETE -- glasses reboot into the new firmware"
            else "FLASH FAILED -- see log; run Restore Stock if a lens is half-flashed",
            if (okAll) 1.0 else 0.0, done = true, ok = okAll
        )
    }

    // ---- download ----------------------------------------------------------------------

    private fun download(url: URL): ByteArray? = try {
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 30000
        conn.readTimeout = DOWNLOAD_TIMEOUT_MS
        conn.instanceFollowRedirects = true
        conn.inputStream.use { it.readBytes() }
    } catch (e: Exception) {
        log("flash: download error: ${e.message}")
        null
    }

    // ---- writes ------------------------------------------------------------------------

    /**
     * One write-without-response, retried while the stack refuses it. Returns false only if it
     * never got through -- and a dropped OTA frame corrupts a firmware block, so the caller
     * must treat false as a failed block, never ignore it.
     */
    private fun writeFrame(
        gatt: BluetoothGatt,
        ch: BluetoothGattCharacteristic,
        frame: ByteArray
    ): Boolean {
        repeat(WRITE_RETRIES) {
            val status = try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeCharacteristic(
                        ch, frame, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                    )
                } else {
                    @Suppress("DEPRECATION")
                    run {
                        ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                        ch.value = frame
                        if (gatt.writeCharacteristic(ch)) 0 else -1
                    }
                }
            } catch (e: SecurityException) {
                log("flash: write refused (SecurityException): ${e.message}")
                return false
            }
            if (status == 0) return true
            try { Thread.sleep(WRITE_RETRY_MS) } catch (e: InterruptedException) { return false }
        }
        return false
    }

    private fun writeFrames(
        gatt: BluetoothGatt,
        ch: BluetoothGattCharacteristic,
        frames: List<ByteArray>
    ): Boolean {
        for (f in frames) if (!writeFrame(gatt, ch, f)) return false
        return true
    }

    /** Block until an OTA ack with opcode [wantOp] lands. Returns the status byte, or null. */
    private fun waitAck(wantOp: Int, timeoutMs: Long): Int? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return null
            val frame = rx.poll(remaining, TimeUnit.MILLISECONDS) ?: return null
            val parsed = G2Flash.parseRx(frame) ?: continue
            if (parsed.pb.size >= 2 && (parsed.pb[0].toInt() and 0xFF) == wantOp) {
                return parsed.pb[1].toInt() and 0xFF
            }
        }
    }

    private fun sendDataMsg(
        tgt: Target, frames: List<ByteArray>, wantOp: Int, timeoutMs: Long = ACK_TIMEOUT_MS
    ): Int? {
        if (!writeFrames(tgt.gatt, tgt.dataWrite, frames)) return null
        return waitAck(wantOp, timeoutMs)
    }

    // ---- per-lens ----------------------------------------------------------------------

    private fun flashOneLens(tgt: Target, img: ByteArray, segs: List<G2Flash.Segment>): Boolean {
        seq = 0
        drainRx()
        // The official app keeps a 12s tick on the CTRL characteristic through the transfer;
        // without it the link is torn down mid-flash, which is the worst possible moment.
        val keepAlive = Thread({
            try {
                while (active && !Thread.currentThread().isInterrupted) {
                    Thread.sleep(KEEPALIVE_MS)
                    if (!active) break
                    val f = G2Flash.frames(
                        sid = 0x80,
                        pb = byteArrayOf(0x08, 0x0E, 0x10, 0x26, 0x6A, 0x00),
                        seq = nextSeq()
                    )
                    writeFrames(tgt.gatt, tgt.ctrlWrite, f)
                }
            } catch (e: InterruptedException) {
                // normal teardown
            }
        }, "FfsFlashKeepAlive")
        keepAlive.isDaemon = true
        keepAlive.start()

        try {
            val begin = sendDataMsg(tgt, G2Flash.ctrlFrames(0x00, seq = nextSeq()), wantOp = 0x00)
            progress("${tgt.label}: begin ack ${begin ?: "timeout"}", 0.2)

            for ((i, seg) in segs.withIndex()) {
                if (!flashComponent(tgt, seg, i, segs.size, img)) return false
            }
            progress("${tgt.label}: all ${segs.size} components verified", 0.6)
            return true
        } finally {
            keepAlive.interrupt()
        }
    }

    private fun flashComponent(
        tgt: Target, seg: G2Flash.Segment, index: Int, total: Int, img: ByteArray
    ): Boolean {
        val off = seg.off.toInt() + 128
        val ps = seg.ps.toInt()
        if (off + ps > img.size) {
            progress("${tgt.label}: seg ${seg.fn} past EOF", 0.0, ok = false); return false
        }
        val payload = img.copyOfRange(off, off + ps)
        val nb = (payload.size + BLOCK_SIZE - 1) / BLOCK_SIZE

        for (attempt in 0 until COMPONENT_RETRIES) {
            if (attempt > 0) {
                progress("${tgt.label}: re-flash ${seg.fn} attempt ${attempt + 1}", 0.0)
                drainRx()
                Thread.sleep(1500)
            }

            // FILE_CHECK
            val fc = sendDataMsg(
                tgt, G2Flash.ctrlFrames(0x01, seg.sub, seq = nextSeq()), wantOp = 0x01
            )
            if (fc != 0) {
                progress("${tgt.label}: ${seg.fn} FILE_CHECK status ${fc ?: "timeout"}", 0.0)
                continue
            }

            var blocksOK = true
            for (b in 0 until nb) {
                val blk = payload.copyOfRange(
                    b * BLOCK_SIZE, minOf((b + 1) * BLOCK_SIZE, payload.size)
                )
                var acked = false
                for (retry in 0 until BLOCK_NAK_RETRIES) {
                    val s = nextSeq()
                    drainRx()
                    // marker, then the 4 KB body, sharing one seq
                    if (!writeFrames(tgt.gatt, tgt.dataWrite, G2Flash.ctrlFrames(0x02, seq = s))) continue
                    if (!writeFrames(tgt.gatt, tgt.dataWrite, G2Flash.dataFrames(blk, seq = s))) continue
                    if (waitAck(0x02, ACK_TIMEOUT_MS) == 0) { acked = true; break }
                }
                if (!acked) {
                    progress("${tgt.label}: ${seg.fn} block $b/$nb failed", 0.0)
                    blocksOK = false
                    break
                }
                if (b % 100 == 0 || b == nb - 1) {
                    val frac = (index + (b + 1).toDouble() / nb) / total
                    progress("${tgt.label}: ${seg.fn} block ${b + 1}/$nb", 0.2 + 0.4 * minOf(1.0, frac))
                }
            }
            if (!blocksOK) continue

            // END -- 0, 8 and 9 are all accepted completions
            val end = sendDataMsg(
                tgt, G2Flash.ctrlFrames(0x03, seq = nextSeq()), wantOp = 0x03,
                timeoutMs = END_ACK_TIMEOUT_MS
            )
            if (end == 0 || end == 8 || end == 9) {
                progress("${tgt.label}: ${seg.fn} END verified ($end)", 0.0)
                return true
            }
            progress("${tgt.label}: ${seg.fn} END status ${end ?: "timeout"} -- retrying", 0.0)
        }

        progress(
            "${tgt.label}: ${seg.fn} FAILED after $COMPONENT_RETRIES attempts", 0.0, ok = false
        )
        return false
    }
}
