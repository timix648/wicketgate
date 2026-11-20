// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Base} from "./utils/Base.sol";
import {ExitPool} from "../src/ExitPool.sol";
import {WatcherRegistry} from "../src/WatcherRegistry.sol";
import {MockPQC} from "./utils/MockPQC.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {CommonBase} from "forge-std/Base.sol";

/// Drives the pool through random sequences of the real user, watcher and keeper actions.
contract PoolHandler is CommonBase, StdUtils {
    ExitPool public pool;
    WatcherRegistry public registry;
    bytes32 public rollupKey;
    address[3] public ws;
    address public lp;
    address public adminA;
    address public adminB;
    uint256 public claimed;
    uint256 public reports;

    uint256 public deposited;
    uint256 public withdrawn;
    uint64 public nextBatch = 1;
    bytes32[] public batchKeys;
    bytes32[] public advanceIds;
    mapping(bytes32 => address) public exitOf;
    mapping(bytes32 => uint256) public amountOf;

    constructor(ExitPool p, WatcherRegistry r, bytes32 rk, address[3] memory w, address lp_, address a, address b) {
        pool = p;
        registry = r;
        rollupKey = rk;
        ws = w;
        lp = lp_;
        adminA = a;
        adminB = b;
    }

    /// The handler settles and writes off as a keeper, so it is credited tips and claims them.
    receive() external payable {}

    function _sign(address a, bytes memory message) internal pure returns (bytes memory sig) {
        bytes memory pk = new bytes(2592);
        bytes32 seed = keccak256(abi.encode("pk", a));
        for (uint256 i = 0; i < 2592; i++) pk[i] = seed[i % 32];
        sig = new bytes(4627);
        bytes32 h = keccak256(abi.encode(keccak256(pk), keccak256(message)));
        for (uint256 i = 0; i < 32; i++) sig[i] = h[i];
    }

    function deposit(uint96 amount) external {
        amount = uint96(bound(amount, 1 ether, 50 ether));
        vm.deal(lp, amount);
        vm.prank(lp);
        pool.deposit{value: amount}();
        deposited += amount;
    }

    function withdraw(uint256 frac) external {
        uint256 sh = pool.shares(lp);
        if (sh == 0) return;
        sh = bound(frac, 1, sh);
        uint256 expected = (sh * pool.totalAssets()) / pool.totalShares();
        if (expected > pool.idleLiquidity()) return;
        vm.prank(lp);
        withdrawn += pool.withdraw(sh);
    }

    /// A batch with one withdrawal to a fresh exit address, confirmed by two (or contested by a third) watcher.
    function confirmAndExit(uint96 amountUqor, uint256 seed, bool contest) external {
        amountUqor = uint96(bound(amountUqor, 1, 5_000_000));
        uint64 idx = nextBatch++;
        address beneficiary = address(uint160(uint256(keccak256(abi.encode("b", seed)))));
        bytes32 salt = keccak256(abi.encode("s", seed, idx));
        ExitPool.Facts memory f = _facts(idx, pool.exitAddressFor(beneficiary, salt), amountUqor);
        if (!_vote(ws[0], idx, f) || !_vote(ws[1], idx, f)) return;
        batchKeys.push(pool.batchKey(rollupKey, idx));
        if (contest) _vote(ws[2], idx, ExitPool.Facts(keccak256("lie"), f.withdrawalsRoot, f.exitRoot));
        _exit(idx, f, beneficiary, salt, amountUqor);
    }

    function _facts(uint64 idx, address exitAddr, uint96 amountUqor) internal view returns (ExitPool.Facts memory) {
        return ExitPool.Facts(keccak256(abi.encode(idx)), keccak256(abi.encode("w", idx)), pool.exitLeaf(0, exitAddr, amountUqor));
    }

    function _vote(address w, uint64 idx, ExitPool.Facts memory f) internal returns (bool) {
        if (!registry.isActive(w)) return false;
        bytes memory m = pool.attestationMessage(rollupKey, idx, f);
        vm.prank(w);
        pool.attest(rollupKey, idx, f, _sign(w, m));
        return true;
    }

    function _exit(uint64 idx, ExitPool.Facts memory f, address beneficiary, bytes32 salt, uint96 amountUqor) internal {
        try pool.instantExit(rollupKey, idx, f, 0, beneficiary, salt, amountUqor, new bytes32[](0)) returns (bytes32 id) {
            advanceIds.push(id);
            exitOf[id] = pool.exitAddressFor(beneficiary, salt);
            amountOf[id] = uint256(amountUqor) * 1e12;
        } catch {}
    }

    function repay(uint256 i) external {
        if (advanceIds.length == 0) return;
        bytes32 id = advanceIds[bound(i, 0, advanceIds.length - 1)];
        vm.deal(exitOf[id], amountOf[id]);
        try pool.settle(id) {} catch {}
    }

    function timePasses(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 60, 2 hours));
    }

    function defaultOne(uint256 i) external {
        if (advanceIds.length == 0) return;
        try pool.markDefault(advanceIds[bound(i, 0, advanceIds.length - 1)]) {} catch {}
    }

    function releaseOne(uint256 i) external {
        if (batchKeys.length == 0) return;
        try pool.release(batchKeys[bound(i, 0, batchKeys.length - 1)]) {} catch {}
    }

    // ------------------------------------------------------------ v3 actions

    /// Someone proves a watcher signed two different results for a batch.
    function equivocate(uint256 wi, uint256 bi) external {
        address w = ws[bound(wi, 0, 2)];
        uint64 idx = uint64(bound(bi, 1, nextBatch));
        ExitPool.Facts memory f = ExitPool.Facts(keccak256(abi.encode(idx)), keccak256(abi.encode("w", idx)), keccak256("t"));
        ExitPool.Facts memory lie = ExitPool.Facts(keccak256("lie"), f.withdrawalsRoot, f.exitRoot);
        bytes memory s1 = _sign(w, pool.attestationMessage(rollupKey, idx, f));
        bytes memory s2 = _sign(w, pool.attestationMessage(rollupKey, idx, lie));
        try pool.reportEquivocation(rollupKey, idx, w, f, s1, lie, s2) {
            reports++;
        } catch {}
    }

    /// A penalised watcher stakes again.
    function rejoin(uint256 wi) external {
        address w = ws[bound(wi, 0, 2)];
        if (registry.isActive(w)) return;
        vm.deal(w, 60 ether);
        vm.prank(w);
        try registry.join{value: 60 ether}() {} catch {}
    }

    function pauseOrResume(bool pause) external {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory m = pool.adminMessage(pause ? bytes32("pause") : bytes32("unpause"), "", pool.adminNonce(), deadline);
        if (pause) pool.pause(deadline, true, _sign(adminA, m));
        else pool.unpause(deadline, _sign(adminA, m), _sign(adminB, m));
    }

    /// The handler claims the keeper tips and bounties it was credited.
    function claimCredit() external {
        uint256 c = pool.watcherCredit(address(this));
        if (c == 0) return;
        pool.claimCredit();
        claimed += c;
    }

    function batchCount() external view returns (uint256) {
        return batchKeys.length;
    }
}

contract InvariantsTest is Base {
    PoolHandler handler;

    function setUp() public override {
        super.setUp();
        joinAll();
        // top up so watchers can back many batches
        vm.prank(w1);
        registry.topUp{value: 80 ether}();
        vm.prank(w2);
        registry.topUp{value: 80 ether}();
        // v3: a rising fee and exposure caps, so the invariants cover those paths too
        setRisk(3000, 400, 4 ether, 60 ether, 0.05 ether); // v3.1: and an execution fee for keepers
        handler = new PoolHandler(pool, registry, rollupKey, [w1, w2, w3], lp, adminA, adminB);
        targetContract(address(handler));
    }

    /// Never advance more against a batch than the stake locked behind it.
    function invariant_advances_within_cover() public view {
        for (uint256 i = 0; i < handler.batchCount(); i++) {
            (,,,,, uint256 cover, uint256 advanced,,) = pool.getBatch(handler.batchKeys(i));
            assertLe(advanced, cover);
        }
    }

    /// Providers never lose: the pool's own assets (after everything owed to watchers, keepers and
    /// reporters) plus what providers withdrew always cover what they deposited. (v3 tightened this:
    /// v2 also counted the watchers' credits on the providers' side.)
    function invariant_providers_never_lose() public view {
        assertGe(pool.totalAssets() + handler.withdrawn(), handler.deposited());
    }

    /// v3.1: execution fees held for keepers are covered by what the pool is owed.
    function invariant_pending_tips_covered() public view {
        assertLe(pool.pendingTipsWei(), pool.outstandingWei());
    }

    /// v3: what each rollup owes adds up to what the pool is owed.
    function invariant_lane_outstanding_matches() public view {
        assertEq(pool.laneOutstanding(rollupKey), pool.outstandingWei());
    }

    /// v3: no rollup ever owes more than its exposure cap.
    function invariant_lane_cap_holds() public view {
        assertLe(pool.laneOutstanding(rollupKey), 60 ether);
    }

    /// Cash never falls below what watchers are owed.
    function invariant_cash_covers_credits() public view {
        assertGe(address(pool).balance, pool.watcherCreditsTotal());
    }

    /// No watcher ever has more locked than it staked.
    function invariant_locked_never_exceeds_stake() public view {
        address[3] memory all = [w1, w2, w3];
        for (uint256 i = 0; i < 3; i++) {
            (uint256 stake, uint256 locked,,) = registry.watchers(all[i]);
            assertLe(locked, stake);
        }
    }
}
