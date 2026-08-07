package expo.modules.ffsble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * GOLDEN VECTORS — these are REAL BYTES CAPTURED OFF THE GLASSES on 2026-08-07, not bytes we
 * constructed from a schema. A human tapped the temple pad on a declared 4-row list while the
 * driver dumped every inbound EvenHub frame; these are those frames.
 *
 * That provenance is the point. The reference kit's schema said what the fields *should* be; the
 * hardware said what they *are*, and the two differ in ways that matter:
 *
 *   1. The list event arrives in the SAME frame as the gesture, not on a separate event path.
 *   2. PROTO3 OMITS DEFAULTS, so the most common event of all — "single tap on the first row" —
 *      encodes with NO index field and NO event-type field. Decoding those as null instead of 0
 *      makes the commonest case look like a decode failure.
 *
 * Both of those cost a bug. Pinning the actual bytes here is what stops them coming back.
 */
class G2EventDecodeTest {

    private fun hex(s: String): ByteArray =
        s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    /** envelope: Cmd(1)=2 (OS_NOITY_EVENT_TO_APP_PACKET), DevEvent(13)=<body> */
    private fun envelope(bodyHex: String): ByteArray {
        val body = hex(bodyHex)
        val out = ArrayList<Byte>()
        out.add(0x08); out.add(0x02)                 // field 1 varint = 2
        out.add(0x6a.toByte())                       // field 13, wiretype 2
        out.add(body.size.toByte())
        body.forEach { out.add(it) }
        return out.toByteArray()
    }

    /**
     * CAPTURED: temple tap while the highlight was on row 0.
     * ListEvent{ ContainerID=3, ContainerName="ffs-list" } — note there is NO index field and NO
     * event-type field, because both are 0 and proto3 does not encode defaults.
     */
    @Test
    fun listClick_onRowZero_hasNoIndexFieldAndStillDecodesAsIndexZero() {
        val evt = G2EvenHub.decodeEvent(envelope("0a0c080312086666732d6c697374"))
        assertNotNull("row-0 tap must decode", evt)
        assertEquals("list-click", evt!!.kind)
        assertEquals(3, evt.containerId)
        assertEquals("ffs-list", evt.containerName)
        // The whole point: absent field means 0, not unknown.
        assertEquals(0, evt.itemIndex)
        assertEquals(G2EvenHub.EventType.CLICK, evt.eventType)
    }

    /**
     * CAPTURED: scrolled to row 1 on-glass, then tapped.
     * ListEvent{ ContainerID=3, ContainerName="ffs-list", CurrentSelectItemIndex=1 }.
     * `2001` is field 4 varint 1 — the selection index the firmware actually reports.
     */
    @Test
    fun listClick_onRowOne_reportsTheSelectedIndex() {
        val evt = G2EvenHub.decodeEvent(envelope("0a0e080312086666732d6c6973742001"))
        assertNotNull(evt)
        assertEquals("list-click", evt!!.kind)
        assertEquals(3, evt.containerId)
        assertEquals("ffs-list", evt.containerName)
        assertEquals(1, evt.itemIndex)
    }

    /**
     * CAPTURED: double tap on the right temple.
     * SysEvent{ EventType=3 (DOUBLE_CLICK), EventSource=1 (GLASSES_R) } — note double-tap arrives
     * as a SYS event, not as a list event, even with a list on screen.
     */
    @Test
    fun doubleTap_arrivesAsSysEventWithSource() {
        val evt = G2EvenHub.decodeEvent(envelope("1a0408031001"))
        assertNotNull(evt)
        assertEquals("sys-event", evt!!.kind)
        assertEquals(G2EvenHub.EventType.DOUBLE_CLICK, evt.eventType)
        assertEquals(G2EvenHub.EventSource.GLASSES_R, evt.eventSource)
    }

    /** A heartbeat must NOT be mistaken for an event. Captured shape: f1=12, f2=n, f15=... */
    @Test
    fun heartbeatIsNotDecodedAsAnEvent() {
        assertNull(G2EvenHub.decodeEvent(hex("080c10137a02100c")))
    }

    @Test
    fun eventTypeAndSourceNamesAreStable() {
        assertEquals("click", G2EvenHub.EventType.name(0))
        assertEquals("double-click", G2EvenHub.EventType.name(3))
        assertEquals("ring", G2EvenHub.EventSource.name(2))
        assertEquals("glasses-R", G2EvenHub.EventSource.name(1))
    }
}
