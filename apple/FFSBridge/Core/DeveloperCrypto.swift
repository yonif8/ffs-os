import Foundation
import CryptoKit

enum DeveloperCrypto {
    static func seal(_ object: [String: Any], key: Data) throws -> Data {
        guard key.count == 32 else { throw BridgeError.invalid("Invalid pairing key") }
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let box = try AES.GCM.seal(bytes, using: SymmetricKey(data: key)).combined else { throw BridgeError.invalid("Encryption failed") }
        return box
    }
    static func open(_ bytes: Data, key: Data) throws -> [String: Any] {
        guard key.count == 32 else { throw BridgeError.invalid("Invalid pairing key") }
        let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: bytes), using: SymmetricKey(data: key))
        guard let object = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw BridgeError.invalid("Invalid command envelope") }
        return object
    }
}
