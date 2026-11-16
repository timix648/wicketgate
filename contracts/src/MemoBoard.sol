// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title MemoBoard
/// @notice Carries payment notes sealed with QoreSeal (ML-KEM-1024) to the recipient.
/// Stores nothing: the envelope lives in the event log. Content is private; who posted,
/// when, and the envelope size are public.
contract MemoBoard {
    uint256 public constant MAX_ENVELOPE = 4096;

    error TooLarge();

    event Memo(bytes32 indexed rollupKey, bytes32 indexed toLedgerAccount, bytes32 indexed ledgerTxHash, address from, bytes envelope);

    function post(bytes32 rollupKey, bytes32 toLedgerAccount, bytes32 ledgerTxHash, bytes calldata envelope) external {
        if (envelope.length > MAX_ENVELOPE) revert TooLarge();
        emit Memo(rollupKey, toLedgerAccount, ledgerTxHash, msg.sender, envelope);
    }
}
