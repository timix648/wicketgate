// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title Directory
/// @notice Links a QoreChain account to its ledger account on a rollup. Each address can
/// only link itself, so nobody can claim another person's entry.
contract Directory {
    mapping(bytes32 => mapping(address => bytes32)) public ledgerAccountOf; // rollupKey => owner => id
    mapping(bytes32 => mapping(bytes32 => address)) public ownerOf; // rollupKey => id => owner

    error Taken();

    event Linked(bytes32 indexed rollupKey, address indexed owner, bytes32 ledgerAccount);

    function link(bytes32 rollupKey, bytes32 ledgerAccount) external {
        address current = ownerOf[rollupKey][ledgerAccount];
        if (current != address(0) && current != msg.sender) revert Taken();
        bytes32 previous = ledgerAccountOf[rollupKey][msg.sender];
        if (previous != bytes32(0)) delete ownerOf[rollupKey][previous];
        ledgerAccountOf[rollupKey][msg.sender] = ledgerAccount;
        ownerOf[rollupKey][ledgerAccount] = msg.sender;
        emit Linked(rollupKey, msg.sender, ledgerAccount);
    }
}
