// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title ExitAddress
/// @notice The recipient of one rollup withdrawal. The ExitPool deploys it with CREATE2
/// at an address computed in advance, after the chain has already paid QOR to that
/// address, and sweeps the balance to the pool (repaying an advance) or to the
/// beneficiary (when no advance was made).
contract ExitAddress {
    address public immutable pool;

    error NotPool();
    error TransferFailed();

    constructor() {
        pool = msg.sender;
    }

    receive() external payable {}

    function sweep(address payable to) external returns (uint256 amount) {
        if (msg.sender != pool) revert NotPool();
        amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
