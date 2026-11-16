// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {IQorePQC} from "../interfaces/IQorePQC.sol";

/// @title PQGuard
/// @notice Reads an account's registered ML-DSA-87 key and checks signatures against it.
/// Fails closed: the typed calls revert when a precompile is inactive and returns no data.
library PQGuard {
    IQorePQC internal constant VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant STATUS = IQorePQC(0x0000000000000000000000000000000000000a02);

    uint8 internal constant ALG_MLDSA87 = 1;
    uint256 internal constant PUBKEY_LEN = 2592;
    uint256 internal constant SIG_LEN = 4627;

    error NoProvenKey(address account);
    error BadSignature(address account);

    /// @notice The account's ML-DSA-87 key, only if registered with a proof of possession.
    function keyOf(address account) internal view returns (bytes memory pubkey) {
        (bool registered, uint8 alg, bytes memory pk, bool proven) = STATUS.pqcKeyStatus(account);
        if (!(registered && alg == ALG_MLDSA87 && pk.length == PUBKEY_LEN && proven)) revert NoProvenKey(account);
        return pk;
    }

    /// @notice Whether the account holds a usable key (never reverts on a missing key).
    function hasProvenKey(address account) internal view returns (bool) {
        (bool registered, uint8 alg, bytes memory pk, bool proven) = STATUS.pqcKeyStatus(account);
        return registered && alg == ALG_MLDSA87 && pk.length == PUBKEY_LEN && proven;
    }

    /// @notice Revert unless `signature` is the account's ML-DSA-87 signature over `message`.
    function requireSigned(address account, bytes memory message, bytes calldata signature) internal view {
        if (signature.length != SIG_LEN || !VERIFY.pqcVerify(keyOf(account), signature, message)) {
            revert BadSignature(account);
        }
    }
}
