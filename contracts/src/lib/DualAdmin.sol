// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {PQGuard} from "./PQGuard.sol";

/// @title DualAdmin
/// @notice Admin actions need ML-DSA-87 signatures from both admin accounts.
/// `msg.sender` authorises nothing, so a leaked classical key cannot change settings.
abstract contract DualAdmin {
    bytes32 public constant ADMIN_TYPEHASH = keccak256("Wicketgate.Admin.v1");

    address public immutable adminA;
    address public immutable adminB;
    uint256 public adminNonce;

    error SameAdmin();
    error Expired();

    event AdminAction(bytes32 indexed action, uint256 nonce);

    constructor(address a, address b) {
        if (a == b || a == address(0) || b == address(0)) revert SameAdmin();
        adminA = a;
        adminB = b;
    }

    /// @notice The bytes both admins sign for the next admin action.
    function adminMessage(bytes32 action, bytes memory payload, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(ADMIN_TYPEHASH, block.chainid, address(this), action, keccak256(payload), nonce, deadline);
    }

    function _requireAdmins(
        bytes32 action,
        bytes memory payload,
        uint256 deadline,
        bytes calldata sigA,
        bytes calldata sigB
    ) internal {
        if (block.timestamp > deadline) revert Expired();
        bytes memory m = adminMessage(action, payload, adminNonce, deadline);
        PQGuard.requireSigned(adminA, m, sigA);
        PQGuard.requireSigned(adminB, m, sigB);
        emit AdminAction(action, adminNonce);
        unchecked {
            adminNonce++;
        }
    }
}
