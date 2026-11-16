// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice QoreChain post-quantum precompiles (active on the qorechain-diana testnet,
/// inactive on mainnet). Verify lives at 0x0A01, key status at 0x0A02.
interface IQorePQC {
    /// @notice Verify an ML-DSA-87 signature (2592-byte key, 4627-byte signature).
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);

    /// @notice The post-quantum key the chain holds for an account.
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
