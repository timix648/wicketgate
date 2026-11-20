// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockPQC} from "./MockPQC.sol";
import {WatcherRegistry} from "../../src/WatcherRegistry.sol";
import {ExitPool} from "../../src/ExitPool.sol";

abstract contract Base is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;

    address adminA = makeAddr("adminA");
    address adminB = makeAddr("adminB");
    address w1 = makeAddr("w1");
    address w2 = makeAddr("w2");
    address w3 = makeAddr("w3");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");

    WatcherRegistry registry;
    ExitPool pool;
    bytes32 rollupKey = keccak256("rdk-v328-e2e-mwd5v89d");

    uint256 constant MIN_STAKE = 5 ether;
    uint128 constant LOCK = 4 ether;
    uint64 constant WINDOW = 3600;
    uint64 constant GRACE = 1800;

    function setUp() public virtual {
        MockPQC impl = new MockPQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(STATUS, address(impl).code);
        address[7] memory all = [adminA, adminB, w1, w2, w3, lp, alice];
        for (uint256 i = 0; i < all.length; i++) giveKey(all[i]);

        registry = new WatcherRegistry(adminA, adminB, MIN_STAKE, 3 days);
        pool = new ExitPool(adminA, adminB, registry);
        adminDo(address(registry), "setPool", abi.encode(address(pool)), "");
        setLane(2, 50);

        vm.deal(w1, 100 ether);
        vm.deal(w2, 100 ether);
        vm.deal(w3, 100 ether);
        vm.deal(lp, 1000 ether);
    }

    // ------------------------------------------------------------ fake post-quantum keys

    function pubkeyOf(address a) internal pure returns (bytes memory pk) {
        pk = new bytes(2592);
        bytes32 seed = keccak256(abi.encode("pk", a));
        for (uint256 i = 0; i < 2592; i++) pk[i] = seed[i % 32];
    }

    function giveKey(address a) internal {
        MockPQC(STATUS).setKey(a, true, 1, pubkeyOf(a), true);
    }

    function sign(address a, bytes memory message) internal pure returns (bytes memory sig) {
        sig = new bytes(4627);
        bytes32 h = keccak256(abi.encode(keccak256(pubkeyOf(a)), keccak256(message)));
        for (uint256 i = 0; i < 32; i++) sig[i] = h[i];
    }

    // ------------------------------------------------------------ admin helpers

    /// Calls an admin function on `target` with both admins' signatures. `call` is the
    /// calldata with placeholder deadline and signatures; they are re-encoded here.
    function adminDo(address target, bytes32 action, bytes memory payload, bytes memory) internal {
        uint256 deadline = block.timestamp + 1 hours;
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("adminNonce()"));
        require(ok);
        uint256 nonce = abi.decode(ret, (uint256));
        (ok, ret) = target.staticcall(
            abi.encodeWithSignature("adminMessage(bytes32,bytes,uint256,uint256)", action, payload, nonce, deadline)
        );
        require(ok);
        bytes memory m = abi.decode(ret, (bytes));
        bytes memory sa = sign(adminA, m);
        bytes memory sb = sign(adminB, m);
        if (action == "setPool") {
            WatcherRegistry(target).setPool(abi.decode(payload, (address)), deadline, sa, sb);
        } else if (action == "setLane") {
            (bytes32 k, ExitPool.Lane memory lane) = abi.decode(payload, (bytes32, ExitPool.Lane));
            ExitPool(payable(target)).setLane(k, lane, deadline, sa, sb);
        } else if (action == "setParams") {
            (uint256 ms, uint64 ld) = abi.decode(payload, (uint256, uint64));
            WatcherRegistry(target).setParams(ms, ld, deadline, sa, sb);
        } else if (action == "setRisk") {
            (bytes32 k, ExitPool.Risk memory r) = abi.decode(payload, (bytes32, ExitPool.Risk));
            ExitPool(payable(target)).setRisk(k, r, deadline, sa, sb);
        } else if (action == "unpause") {
            ExitPool(payable(target)).unpause(deadline, sa, sb);
        } else {
            revert("unknown action");
        }
    }

    /// v3: one admin's signature pauses new exits.
    function pauseBy(bool byA) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory m = pool.adminMessage("pause", "", pool.adminNonce(), deadline);
        pool.pause(deadline, byA, sign(byA ? adminA : adminB, m));
    }

    function setRisk(uint16 kinkBps, uint16 maxFeeBps, uint128 maxExitWei, uint128 maxOutstandingWei) internal {
        setRisk(kinkBps, maxFeeBps, maxExitWei, maxOutstandingWei, 0);
    }

    function setRisk(uint16 kinkBps, uint16 maxFeeBps, uint128 maxExitWei, uint128 maxOutstandingWei, uint128 keeperTipWei)
        internal
    {
        adminDo(address(pool), "setRisk", abi.encode(rollupKey, ExitPool.Risk(kinkBps, maxFeeBps, maxExitWei, maxOutstandingWei, keeperTipWei)), "");
    }

    function setLane(uint8 quorum, uint16 feeBps) internal {
        ExitPool.Lane memory lane = ExitPool.Lane(WINDOW, GRACE, feeBps, quorum, LOCK, true);
        adminDo(address(pool), "setLane", abi.encode(rollupKey, lane), "");
    }

    // ------------------------------------------------------------ watchers and attestations

    function joinAll() internal {
        vm.prank(w1);
        registry.join{value: 10 ether}();
        vm.prank(w2);
        registry.join{value: 10 ether}();
        vm.prank(w3);
        registry.join{value: 10 ether}();
    }

    function attestAs(address w, uint64 batchIndex, ExitPool.Facts memory f) internal {
        bytes memory m = pool.attestationMessage(rollupKey, batchIndex, f);
        vm.prank(w);
        pool.attest(rollupKey, batchIndex, f, sign(w, m));
    }

    // ------------------------------------------------------------ exit tree (sorted-pair keccak)

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// Root and proof for leaf `i` of a list of up to 4 leaves (padded by duplicating the last level node).
    function treeOf(bytes32[] memory leaves, uint256 i) internal pure returns (bytes32 root, bytes32[] memory proof) {
        if (leaves.length == 1) return (leaves[0], new bytes32[](0));
        require(leaves.length <= 4, "test tree too big");
        bytes32[] memory l = new bytes32[](4);
        for (uint256 k = 0; k < 4; k++) l[k] = k < leaves.length ? leaves[k] : bytes32(0);
        if (leaves.length == 2) {
            proof = new bytes32[](1);
            proof[0] = leaves[1 - i];
            return (hashPair(leaves[0], leaves[1]), proof);
        }
        bytes32 n0 = hashPair(l[0], l[1]);
        bytes32 n1 = leaves.length == 3 ? l[2] : hashPair(l[2], l[3]);
        root = hashPair(n0, n1);
        if (i < 2) {
            proof = new bytes32[](2);
            proof[0] = l[1 - i];
            proof[1] = n1;
        } else if (leaves.length == 3) {
            proof = new bytes32[](1);
            proof[0] = n0;
        } else {
            proof = new bytes32[](2);
            proof[0] = l[5 - i];
            proof[1] = n0;
        }
    }
}
