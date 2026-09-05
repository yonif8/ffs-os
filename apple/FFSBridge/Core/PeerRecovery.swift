import Foundation

// Same one-shot asymmetric recovery policy as current Android. It does not claim
// to fix the known firmware/controller failure that requires a case restart.
struct PeerRecovery {
    private var paired = false, issued = false
    private var since: TimeInterval?
    mutating func reset() { paired = false; issued = false; since = nil }
    mutating func observe(now: TimeInterval, wanted: Bool, flashing: Bool, left: Bool, right: Bool) -> (side: String?, deadline: TimeInterval?) {
        if left && right { paired = true; issued = false; since = nil; return (nil, nil) }
        guard wanted, !flashing, paired, !issued, left != right else { since = nil; return (nil, nil) }
        let start = since ?? now; since = start
        if now < start + 2 { return (nil, start + 2) }
        issued = true; since = nil
        return (left ? "L" : "R", nil)
    }
}
