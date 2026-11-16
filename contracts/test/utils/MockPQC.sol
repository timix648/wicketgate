// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Test stand-in for both QoreChain PQC precompiles. Etched at 0x0a01 and 0x0a02.
/// A "signature" is valid when it is 4627 bytes and starts with
/// keccak256(abi.encode(keccak256(pubkey), keccak256(message))).
contract MockPQC {
    struct Key { bool registered; uint8 alg; bytes pubkey; bool proven; }
    mapping(address => Key) internal keys;

    function setKey(address account, bool registered, uint8 alg, bytes calldata pubkey, bool proven) external {
        keys[account] = Key(registered, alg, pubkey, proven);
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        Key storage k = keys[account];
        return (k.registered, k.alg, k.pubkey, k.proven);
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message) external pure returns (bool) {
        if (signature.length != 4627) return false;
        return bytes32(signature[0:32]) == keccak256(abi.encode(keccak256(pubkey), keccak256(message)));
    }
}
