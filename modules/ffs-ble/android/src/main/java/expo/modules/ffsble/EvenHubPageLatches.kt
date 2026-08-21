package expo.modules.ffsble

/**
 * The phone's cached model of Even's EvenHub PAGE, and the one rule that invalidates it.
 *
 * WHY THIS IS ITS OWN CLASS
 * -------------------------
 * These two booleans are the whole of the phone's belief about firmware state on the push
 * path, and getting them wrong kills the link silently and permanently (see below). They
 * live here rather than as two loose fields in [G2Central] so the invalidation rule can be
 * unit-tested on a plain JVM -- `G2Central` needs a BluetoothManager, a Handler and a live
 * pair, so nothing inside it is reachable from `./gradlew :ffs-ble:test`.
 *
 * [G2Central] delegates its `pageCreated` / `animContainerReady` properties straight to
 * this object, so every existing call site keeps working and the tested object is the same
 * object the driver runs.
 *
 * THE TRAP THIS EXISTS TO BREAK (g2flash/docs/S-TRAP-report.md, tier 2)
 * --------------------------------------------------------------------
 * A payload push is an EvenHub IMAGE-CONTAINER update, and that container belongs to Even's
 * EvenHub page. Even's page manager holds exactly ONE page, so any ui-module switch -- our
 * own `RequestDisplayStartUp` summon, a long-press "end this feature", anything -- EXITs the
 * EvenHub page. Its lifecycle handler does `FREE(*0x20074E14); *0x20074E14 = 0`, and the
 * container lookup every inbound image frame must clear is literally
 * `if (*0x20074E14 == 0) return 0`. From then on every push is refused by a lookup that
 * allocates nothing and counts nothing -- no OOM, no error counter, no visible symptom
 * beyond "the HUD stopped changing".
 *
 * The phone made that permanent: both flags stayed latched `true` for the process lifetime,
 * so we never re-declared the page and never re-created the container. Only a fresh process
 * (or, historically, a reflash) cleared them -- which is the only thing a reflash was ever
 * doing for this failure.
 */
internal class EvenHubPageLatches {

    /**
     * A startup page has been created this session -- subsequent pages must use rebuildPage
     * (createStartupPage only takes once per session). Reset on drop.
     *
     * @Volatile because the SDK reads it off the bus thread via `G2Central.sdkTakeoverPage`
     * to seed its own page slot; every write still happens on the serial queue.
     */
    @Volatile
    var pageCreated: Boolean = false

    /** The anim/payload landing container (ANIM_CID) is declared on the current page. */
    @Volatile
    var animContainerReady: Boolean = false

    /**
     * An image-fragment ACK came back. The firmware TELLS US when the container is gone:
     * `evenhub_data_parser` fails `SPEC_LOOKUP`, replies with report subtype 5, the error code
     * comes back != 4, and `G2EvenHub.parseImageAck` turns that into `success = false`.
     *
     * On a refusal, clear BOTH latches -- not just the container. Only a CREATE
     * (cmd 0 / subtype 3, the single call site at firmware 0x004df732) re-summons the EvenHub
     * page, and the phone sends a REBUILD (cmd 7) for as long as [pageCreated] stays true.
     * Clearing the container alone would rebuild a page that no longer exists and the refusals
     * would continue. With both cleared, the next push sends a CREATE, the device re-summons
     * the page, and the link heals itself in one round trip instead of never.
     *
     * ⚠️ HONEST LIMIT -- this covers GATE A only.
     * Gate A is "container not found": the frame is dropped and ACKed `success = false`, which
     * is what this method keys on. Gate B is the second, independent page gate at the
     * reconstruction-complete sites (0x004e0400 / 0x004e07f4): `LENS_SIDE() == 1 &&
     * FUN_004434d0(0xE0) == 1`. When EvenHub is not the foreground app that gate skips
     * `IMAGE_COMPLETE_EMIT` -- the frame is fully received and **ACKed `success = true`**, and
     * nothing about it is visible here. Detecting gate B needs the "calls didn't move"
     * heuristic (the loader's `ret=` / `calls=` counters failing to advance across a push);
     * `src/os/pushAck.ts` is the natural home for that, not this class.
     */
    fun onImageAck(success: Boolean) {
        if (!success) {
            animContainerReady = false
            pageCreated = false
        }
    }
}
