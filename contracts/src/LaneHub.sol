// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {PQGuard} from "./lib/PQGuard.sol";

/// @title LaneHub
/// @notice Permissionless instant-exit lanes. Anyone can open a lane for any QoreChain rollup:
/// the hub deploys a separate WatcherRegistry and ExitPool for it, run by the opener's own two
/// ML-DSA-87 admin keys. Each lane holds its own liquidity and its own watcher stake, so a badly
/// run lane can only lose what was put into that lane; other lanes and Wicketgate's own pool are
/// untouched. Several lanes can serve the same rollup and compete on fees.
///
/// The pool is about 23 KB, too large to embed here, so the opener passes the creation code and
/// the hub refuses anything that is not byte-for-byte the audited Wicketgate code (its keccak256
/// is fixed at deployment). So every lane the hub lists runs exactly the code in this repository,
/// and anyone can check that from the hub alone.
contract LaneHub {
    struct LaneInfo {
        address pool;
        address registry;
        address adminA;
        address adminB;
        address opener;
        uint64 openedAt;
    }

    bytes32 public immutable poolCodeHash;
    bytes32 public immutable registryCodeHash;

    mapping(bytes32 => LaneInfo[]) private _lanes; // rollupKey => lanes
    bytes32[] public rollups; // every rollupKey with at least one lane
    mapping(address => bytes32) public rollupOfPool;

    error WrongCode();
    error NotAnAdmin();
    error DeployFailed();

    /// The lane's admins are readable from the pool (adminA, adminB) and from lanesOf.
    event LaneOpened(bytes32 indexed rollupKey, string rollupId, address indexed pool, address registry, address indexed opener);

    constructor(bytes32 poolCodeHash_, bytes32 registryCodeHash_) {
        poolCodeHash = poolCodeHash_;
        registryCodeHash = registryCodeHash_;
    }

    /// @notice Deploy a lane for `rollupId`. The caller must be one of the two admins, and both
    /// admins must hold an ML-DSA-87 key registered with proof of possession: the lane's settings,
    /// pause and registry binding are then controlled by post-quantum signatures only.
    /// Afterwards the admins sign registry.setPool(pool) and pool.setLane(...) for their rollup.
    /// Who runs a lane and how its watcher registry is set.
    struct LaneParams {
        address adminA;
        address adminB;
        uint256 minStake;
        uint64 leaveDelay;
    }

    function openLane(string calldata rollupId, LaneParams calldata p, bytes calldata registryCode, bytes calldata poolCode)
        external
        returns (address pool, address registry)
    {
        if (keccak256(registryCode) != registryCodeHash || keccak256(poolCode) != poolCodeHash) revert WrongCode();
        if (msg.sender != p.adminA && msg.sender != p.adminB) revert NotAnAdmin();
        PQGuard.keyOf(p.adminA);
        PQGuard.keyOf(p.adminB);

        bytes32 rollupKey = keccak256(bytes(rollupId));
        bytes32 salt = keccak256(abi.encode(rollupKey, msg.sender, _lanes[rollupKey].length));
        registry = _deploy(abi.encodePacked(registryCode, abi.encode(p.adminA, p.adminB, p.minStake, p.leaveDelay)), salt);
        pool = _deploy(abi.encodePacked(poolCode, abi.encode(p.adminA, p.adminB, registry)), salt);
        _record(rollupKey, pool, registry, p);
        emit LaneOpened(rollupKey, rollupId, pool, registry, msg.sender);
    }

    function _record(bytes32 rollupKey, address pool, address registry, LaneParams calldata p) private {
        if (_lanes[rollupKey].length == 0) rollups.push(rollupKey);
        _lanes[rollupKey].push(LaneInfo(pool, registry, p.adminA, p.adminB, msg.sender, uint64(block.timestamp)));
        rollupOfPool[pool] = rollupKey;
    }

    function lanesOf(bytes32 rollupKey) external view returns (LaneInfo[] memory) {
        return _lanes[rollupKey];
    }

    function rollupCount() external view returns (uint256) {
        return rollups.length;
    }

    function _deploy(bytes memory initCode, bytes32 salt) private returns (address a) {
        assembly {
            a := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (a == address(0)) revert DeployFailed();
    }
}
