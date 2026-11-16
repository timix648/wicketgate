// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {PQGuard} from "./lib/PQGuard.sol";
import {DualAdmin} from "./lib/DualAdmin.sol";

/// @title WatcherRegistry
/// @notice Watchers stake QOR to be counted. Stake backs the attestations they sign
/// and is slashed by the ExitPool when an exit they confirmed is never repaid.
contract WatcherRegistry is DualAdmin {
    struct Watcher {
        uint256 stake;
        uint256 locked;
        uint64 leaveAfter;
        bool active;
    }

    mapping(address => Watcher) public watchers;
    address public pool;
    uint256 public minStake;
    uint64 public leaveDelay;
    uint256 private _entered;

    error NotPool();
    error PoolAlreadySet();
    error AlreadyActive();
    error StakeTooLow();
    error NotActive();
    error StillActive();
    error TooEarly();
    error StakeLocked();
    error InsufficientFree();
    error TransferFailed();
    error Reentrancy();

    event Joined(address indexed watcher, uint256 stake);
    event ToppedUp(address indexed watcher, uint256 amount);
    event LeaveRequested(address indexed watcher, uint64 leaveAfter);
    event Left(address indexed watcher, uint256 returned);
    event Locked(address indexed watcher, uint256 amount);
    event Unlocked(address indexed watcher, uint256 amount);
    event Slashed(address indexed watcher, uint256 amount, address to);

    modifier onlyPool() {
        if (msg.sender != pool) revert NotPool();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address a, address b, uint256 minStake_, uint64 leaveDelay_) DualAdmin(a, b) {
        minStake = minStake_;
        leaveDelay = leaveDelay_;
    }

    // ---------------------------------------------------------------- watchers

    /// @notice Join with a stake. The caller must hold a proven ML-DSA-87 key.
    function join() external payable {
        Watcher storage w = watchers[msg.sender];
        if (w.active) revert AlreadyActive();
        PQGuard.keyOf(msg.sender);
        uint256 total = w.stake + msg.value;
        if (total < minStake) revert StakeTooLow();
        w.stake = total;
        w.active = true;
        w.leaveAfter = 0;
        emit Joined(msg.sender, total);
    }

    function topUp() external payable {
        Watcher storage w = watchers[msg.sender];
        if (!w.active) revert NotActive();
        w.stake += msg.value;
        emit ToppedUp(msg.sender, msg.value);
    }

    /// @notice Stop being counted for new confirmations now; stake returns after the delay.
    function requestLeave() external {
        Watcher storage w = watchers[msg.sender];
        if (!w.active) revert NotActive();
        w.active = false;
        w.leaveAfter = uint64(block.timestamp) + leaveDelay;
        emit LeaveRequested(msg.sender, w.leaveAfter);
    }

    function leave() external nonReentrant {
        Watcher storage w = watchers[msg.sender];
        if (w.active) revert StillActive();
        if (w.leaveAfter == 0 || block.timestamp < w.leaveAfter) revert TooEarly();
        if (w.locked != 0) revert StakeLocked();
        uint256 amount = w.stake;
        w.stake = 0;
        w.leaveAfter = 0;
        _send(msg.sender, amount);
        emit Left(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function isActive(address account) external view returns (bool) {
        Watcher storage w = watchers[account];
        return w.active && w.stake >= minStake;
    }

    function freeStake(address account) public view returns (uint256) {
        Watcher storage w = watchers[account];
        return w.stake - w.locked;
    }

    // ---------------------------------------------------------------- pool only

    function lock(address account, uint256 amount) external onlyPool {
        if (freeStake(account) < amount) revert InsufficientFree();
        watchers[account].locked += amount;
        emit Locked(account, amount);
    }

    function unlock(address account, uint256 amount) external onlyPool {
        watchers[account].locked -= amount;
        emit Unlocked(account, amount);
    }

    /// @notice Take locked stake and send it to `to` (the pool).
    function slash(address account, uint256 amount, address to) external onlyPool nonReentrant {
        Watcher storage w = watchers[account];
        w.locked -= amount;
        w.stake -= amount;
        _send(to, amount);
        emit Slashed(account, amount, to);
    }

    // ---------------------------------------------------------------- admin

    function setPool(address pool_, uint256 deadline, bytes calldata sigA, bytes calldata sigB) external {
        if (pool != address(0)) revert PoolAlreadySet();
        _requireAdmins("setPool", abi.encode(pool_), deadline, sigA, sigB);
        pool = pool_;
    }

    function setParams(uint256 minStake_, uint64 leaveDelay_, uint256 deadline, bytes calldata sigA, bytes calldata sigB)
        external
    {
        _requireAdmins("setParams", abi.encode(minStake_, leaveDelay_), deadline, sigA, sigB);
        minStake = minStake_;
        leaveDelay = leaveDelay_;
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
