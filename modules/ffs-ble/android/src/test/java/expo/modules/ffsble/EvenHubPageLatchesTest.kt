package expo.modules.ffsble

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one rule that breaks the S-TRAP dead-link (g2flash/docs/S-TRAP-report.md §5 tier 2).
 *
 * WHY THESE ASSERTIONS ARE WORTH PINNING
 * --------------------------------------
 * The failure this guards against is invisible from the phone in every other way: the
 * firmware drops the frame at a container lookup that allocates nothing and counts nothing,
 * so there is no OOM, no error counter and no log -- just a HUD that stopped changing, for
 * the rest of the process lifetime. The single observable is the ACK, and the single correct
 * response is to clear BOTH latches.
 *
 * "Both" is the part a future edit is most likely to get wrong, because clearing the
 * container alone LOOKS sufficient and even reads more conservative. It isn't: with
 * `pageCreated` still true the phone sends a REBUILD (cmd 7), which re-declares a container
 * on a page that no longer exists, and every push stays refused. Only a CREATE (cmd 0 /
 * subtype 3) re-summons the EvenHub page.
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 * That the heal works on glass (cardinal rule 1) -- that needs a summon, a push, and a
 * camera. And it says nothing about gate B, which ACKs `success = true`; see
 * [EvenHubPageLatches.onImageAck]'s doc.
 *
 * Run: ./gradlew :ffs-ble:test
 */
class EvenHubPageLatchesTest {

    private fun latched() = EvenHubPageLatches().apply {
        pageCreated = true
        animContainerReady = true
    }

    @Test
    fun `a refused image ack clears BOTH latches, not just the container`() {
        val latches = latched()

        latches.onImageAck(success = false)

        assertFalse("container must be forgotten -- the firmware freed it", latches.animContainerReady)
        assertFalse(
            "pageCreated must be forgotten too, or the next push sends a REBUILD onto a page " +
                "that no longer exists and stays refused forever",
            latches.pageCreated
        )
    }

    @Test
    fun `a successful image ack leaves both latches alone`() {
        val latches = latched()

        latches.onImageAck(success = true)

        assertTrue(latches.pageCreated)
        assertTrue(latches.animContainerReady)
    }

    /**
     * The heal is one round trip: after the refusal the next push must take the CREATE path,
     * which in [G2Central] is `val rebuild = pageCreated` reading false.
     */
    @Test
    fun `after a refusal the next push would CREATE rather than REBUILD`() {
        val latches = latched()

        latches.onImageAck(success = false)

        val rebuild = latches.pageCreated // exactly what ensureAnimContainerLocked reads
        assertFalse("must send CREATE (cmd 0/subtype 3) -- only that re-summons the page", rebuild)
    }

    /** A success after a refusal must not resurrect the latches on its own. */
    @Test
    fun `a success following a refusal does not re-latch`() {
        val latches = latched()

        latches.onImageAck(success = false)
        latches.onImageAck(success = true)

        assertFalse(latches.pageCreated)
        assertFalse(latches.animContainerReady)
    }

    /** Repeated refusals are idempotent -- no toggling, no resurrection. */
    @Test
    fun `repeated refusals are idempotent`() {
        val latches = latched()

        repeat(3) { latches.onImageAck(success = false) }

        assertFalse(latches.pageCreated)
        assertFalse(latches.animContainerReady)
    }

    /** A fresh instance starts unlatched -- the process-start state the reflash used to fake. */
    @Test
    fun `a fresh instance holds no page`() {
        val latches = EvenHubPageLatches()

        assertFalse(latches.pageCreated)
        assertFalse(latches.animContainerReady)
    }
}
