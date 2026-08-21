package expo.modules.ffsble

import android.bluetooth.BluetoothDevice

/**
 * G2Types.kt -- the small value types shared across the glasses driver.
 *
 * These are pure data/enum declarations with no behaviour and no dependency on driver state.
 * They lived at the tail of [G2Central] purely because that is where they were first written;
 * relocating them here (same package, same visibility) is a byte-for-byte behaviour-preserving
 * move that keeps [G2Central] to the driver logic and mirrors how [G2Protocol] keeps its own
 * value types (G2ImageAck, G2GestureDecode, ...) beside the code that uses them.
 */

/** Which physical lens a peripheral is. */
enum class G2Side(val raw: String) {
    LEFT("L"),
    RIGHT("R"),
    UNKNOWN("?");

    companion object {
        fun parse(raw: String): G2Side = when (raw.uppercase()) {
            "L" -> LEFT
            "R" -> RIGHT
            else -> UNKNOWN
        }
    }
}

/** Command target for a send: a single side or both lenses. */
enum class G2Target { LEFT, RIGHT, BOTH }

/** Parsed manufacturer-data record advertised by a G2 lens. */
data class G2Manufacturer(
    /** 14-char ASCII serial number. */
    val sn: String,
    /** "AA:BB:CC:DD:EE:FF" big-endian colon-hex. */
    val mac: String
)

/** A discovered G2 lens (before/independent of a connection). */
data class G2Discovery(
    val device: BluetoothDevice,
    val name: String,
    val side: G2Side,
    val rssi: Int,
    val manufacturer: G2Manufacturer?
)
