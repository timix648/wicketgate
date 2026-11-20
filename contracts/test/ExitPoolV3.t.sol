// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Base} from "./utils/Base.sol";
import {ExitPool} from "../src/ExitPool.sol";
import {WatcherRegistry} from "../src/WatcherRegistry.sol";
import {PQGuard} from "../src/lib/PQGuard.sol";

/// A keeper that is a contract with no receive function: it must still be able to settle.
contract KeeperNoReceive {
    function settle(ExitPool p, bytes32 id) external {
        p.settle(id);
    }
}

/// Tests for the v3 additions: utilisation fee, exposure caps, paid keepers, equivocation
/// slashing, the emergency pause, quote() and watcher stats.
contract ExitPoolV3Test is Base {
    uint256 constant AMOUNT_UQOR = 2_000_000; // 2 QOR
    uint256 constant AMOUNT_WEI = 2 ether;
    bytes32 constant SALT1 = keccak256("salt-1");
    bytes32 constant SALT2 = keccak256("salt-2");

    function setUp() public override {
        super.setUp();
        joinAll();
        vm.prank(lp);
        pool.deposit{value: 100 ether}();
    }

    /// Two withdrawals of 2 QOR, both to alice's exit addresses (salts 1 and 2).
    function facts() internal view returns (ExitPool.Facts memory f, bytes32[] memory p1, bytes32[] memory p2) {
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = pool.exitLeaf(7, pool.exitAddressFor(alice, SALT1), AMOUNT_UQOR);
        leaves[1] = pool.exitLeaf(8, pool.exitAddressFor(alice, SALT2), AMOUNT_UQOR);
        bytes32 root;
        (root, p1) = treeOf(leaves, 0);
        (, p2) = treeOf(leaves, 1);
        f = ExitPool.Facts(keccak256("state"), keccak256("withdrawals"), root);
    }

    function confirm(uint64 idx) internal returns (ExitPool.Facts memory f, bytes32[] memory p1, bytes32[] memory p2) {
        (f, p1, p2) = facts();
        attestAs(w1, idx, f);
        attestAs(w2, idx, f);
    }

    function exit1(uint64 idx, ExitPool.Facts memory f, bytes32[] memory p) internal returns (bytes32) {
        return pool.instantExit(rollupKey, idx, f, 7, alice, SALT1, AMOUNT_UQOR, p);
    }

    function exit2(uint64 idx, ExitPool.Facts memory f, bytes32[] memory p) internal returns (bytes32) {
        return pool.instantExit(rollupKey, idx, f, 8, alice, SALT2, AMOUNT_UQOR, p);
    }

    function sigOf(address w, uint64 idx, ExitPool.Facts memory f) internal view returns (bytes memory) {
        return sign(w, pool.attestationMessage(rollupKey, idx, f));
    }

    // ================================================================= utilisation fee

    function test_flat_fee_without_risk_settings() public view {
        assertEq(pool.feeBpsFor(rollupKey, 90 ether), 50); // the lane's base fee, whatever the size
    }

    function test_fee_rises_with_utilisation_above_the_kink() public {
        setRisk(5000, 300, 0, 0); // flat up to 50% utilisation, 3% at 100%
        assertEq(pool.feeBpsFor(rollupKey, 2 ether), 50); // 2% utilised
        assertEq(pool.feeBpsFor(rollupKey, 50 ether), 50); // at the kink
        assertEq(pool.feeBpsFor(rollupKey, 75 ether), 175); // halfway up: 50 + 250 * 0.5
        assertEq(pool.feeBpsFor(rollupKey, 100 ether), 300);
        assertEq(pool.feeBpsFor(rollupKey, 500 ether), 300); // capped at 100%
    }

    function test_exit_pays_the_utilisation_fee() public {
        setRisk(0, 300, 0, 0); // rising from the first wei
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        uint256 bps = pool.feeBpsFor(rollupKey, AMOUNT_WEI); // 2% utilised: 50 + 250 * 0.02 = 55
        assertEq(bps, 55);
        uint256 before = alice.balance;
        bytes32 id = exit1(1, f, p1);
        (,,, uint256 feeWei,,,,,,) = pool.advances(id);
        assertEq(feeWei, AMOUNT_WEI * 55 / 10_000);
        assertEq(alice.balance - before, AMOUNT_WEI - feeWei);
    }

    function test_risk_settings_are_bounded() public {
        vm.expectRevert(ExitPool.BadRisk.selector);
        this.callSetRisk(0, 1001, 0, 0); // more than 10%
        vm.expectRevert(ExitPool.BadRisk.selector);
        this.callSetRisk(10_000, 300, 0, 0); // kink at 100%
    }

    function callSetRisk(uint16 k, uint16 m, uint128 e, uint128 o) external {
        pool.setRisk(rollupKey, ExitPool.Risk(k, m, e, o, 0), block.timestamp + 1, "", "");
    }

    // ================================================================= exposure caps

    function test_single_exit_cap() public {
        setRisk(0, 0, 1 ether, 0);
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        vm.expectRevert(ExitPool.ExitTooLarge.selector);
        exit1(1, f, p1);
    }

    function test_rollup_exposure_cap_and_tracking() public {
        setRisk(0, 0, 0, 3 ether);
        (ExitPool.Facts memory f, bytes32[] memory p1, bytes32[] memory p2) = confirm(1);
        bytes32 id = exit1(1, f, p1);
        assertEq(pool.laneOutstanding(rollupKey), AMOUNT_WEI);
        vm.expectRevert(ExitPool.LaneFull.selector); // 2 + 2 > 3
        exit2(1, f, p2);
        vm.deal(pool.exitAddressFor(alice, SALT1), AMOUNT_WEI);
        pool.settle(id);
        assertEq(pool.laneOutstanding(rollupKey), 0);
        exit2(1, f, p2); // room again once the first was repaid
        assertEq(pool.laneOutstanding(rollupKey), AMOUNT_WEI);
    }

    // ================================================================= paid keepers

    function test_keeper_is_credited_and_claims() public {
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        bytes32 id = exit1(1, f, p1);
        (,,, uint256 feeWei,,,,,,) = pool.advances(id);
        vm.deal(pool.exitAddressFor(alice, SALT1), AMOUNT_WEI);
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        pool.settle(id);
        assertEq(pool.watcherCredit(keeper), feeWei * 1000 / 10_000);
        vm.prank(keeper);
        pool.claimCredit();
        assertEq(keeper.balance, feeWei * 1000 / 10_000);
    }

    function test_contract_keeper_without_receive_can_settle() public {
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        bytes32 id = exit1(1, f, p1);
        vm.deal(pool.exitAddressFor(alice, SALT1), AMOUNT_WEI);
        KeeperNoReceive k = new KeeperNoReceive();
        k.settle(pool, id);
        (,,,,,,,, uint8 state,) = pool.advances(id);
        assertEq(state, pool.SETTLED());
        assertGt(pool.watcherCredit(address(k)), 0);
    }

    function test_keeper_is_credited_for_a_write_off() public {
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        bytes32 id = exit1(1, f, p1);
        (,,, uint256 feeWei,,,,,,) = pool.advances(id);
        vm.warp(block.timestamp + WINDOW + GRACE + 1);
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        pool.markDefault(id);
        assertEq(pool.watcherCredit(keeper), feeWei * 1000 / 10_000);
        (,, uint32 eq1, uint32 defaults1, uint128 slashed1) = pool.stats(w1);
        assertEq(eq1, 0);
        assertEq(defaults1, 1);
        assertEq(slashed1, 1 ether); // half of the 2 QOR advance
    }

    // ================================================================= equivocation

    function test_equivocation_is_slashed_and_freezes_the_batch() public {
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        ExitPool.Facts memory lie = ExitPool.Facts(keccak256("other state"), f.withdrawalsRoot, f.exitRoot);
        address reporter = makeAddr("reporter");
        uint256 assetsBefore = pool.totalAssets();
        bytes memory s1 = sigOf(w1, 1, f);
        bytes memory s2 = sigOf(w1, 1, lie);
        vm.prank(reporter);
        uint256 penalty = pool.reportEquivocation(rollupKey, 1, w1, f, s1, lie, s2);
        assertEq(penalty, 10 ether); // all of w1's free stake (nothing was locked)
        assertFalse(registry.isActive(w1));
        assertEq(pool.watcherCredit(reporter), 5 ether); // half to the reporter
        assertEq(pool.totalAssets(), assetsBefore + 5 ether); // the rest to the providers
        (,, bool contested,,,,,,) = pool.getBatch(pool.batchKey(rollupKey, 1));
        assertTrue(contested);
        vm.expectRevert(ExitPool.BatchContested.selector);
        exit1(1, f, p1);
        (,, uint32 eq,,) = pool.stats(w1);
        assertEq(eq, 1);
    }

    function test_equivocation_leaves_locked_stake_backing_open_advances() public {
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        bytes32 id = exit1(1, f, p1); // locks 1 QOR from each confirmer
        ExitPool.Facts memory lie = ExitPool.Facts(f.stateRoot, keccak256("w"), f.exitRoot);
        uint256 penalty = pool.reportEquivocation(rollupKey, 1, w1, f, sigOf(w1, 1, f), lie, sigOf(w1, 1, lie));
        assertEq(penalty, 9 ether); // 10 staked, 1 locked behind the open advance
        (uint256 stake, uint256 locked,,) = registry.watchers(w1);
        assertEq(stake, 1 ether);
        assertEq(locked, 1 ether);
        // the open advance still settles normally, and the batch's stake is released after it
        vm.deal(pool.exitAddressFor(alice, SALT1), AMOUNT_WEI);
        pool.settle(id);
        vm.warp(block.timestamp + WINDOW + GRACE + 1);
        pool.release(pool.batchKey(rollupKey, 1));
        (, locked,,) = registry.watchers(w1);
        assertEq(locked, 0);
    }

    function test_equivocation_works_from_off_chain_signatures_alone() public {
        // w3 never attested on chain; two conflicting signatures it gave out are enough
        (ExitPool.Facts memory f,,) = facts();
        ExitPool.Facts memory lie = ExitPool.Facts(f.stateRoot, f.withdrawalsRoot, keccak256("fake exit tree"));
        uint256 penalty = pool.reportEquivocation(rollupKey, 5, w3, f, sigOf(w3, 5, f), lie, sigOf(w3, 5, lie));
        assertEq(penalty, 10 ether);
        assertFalse(registry.isActive(w3));
    }

    function test_equivocation_needs_two_real_signatures_over_different_facts() public {
        (ExitPool.Facts memory f,,) = confirm(1);
        ExitPool.Facts memory lie = ExitPool.Facts(keccak256("x"), f.withdrawalsRoot, f.exitRoot);
        bytes memory forged = sign(alice, pool.attestationMessage(rollupKey, 1, lie)); // not w1's key
        bytes memory real = sigOf(w1, 1, f);
        bytes memory realLie = sigOf(w1, 1, lie);
        bytes memory otherBatch = sigOf(w1, 2, lie);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, w1));
        pool.reportEquivocation(rollupKey, 1, w1, f, real, lie, forged);
        vm.expectRevert(ExitPool.SameFacts.selector);
        pool.reportEquivocation(rollupKey, 1, w1, f, real, f, real);
        // a signature for another batch does not count either: the message binds the batch index
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, w1));
        pool.reportEquivocation(rollupKey, 1, w1, f, real, lie, otherBatch);
        pool.reportEquivocation(rollupKey, 1, w1, f, real, lie, realLie);
        vm.expectRevert(ExitPool.AlreadyReported.selector);
        pool.reportEquivocation(rollupKey, 1, w1, f, real, lie, realLie);
    }

    // ================================================================= pause

    function test_one_admin_pauses_new_exits_only() public {
        (ExitPool.Facts memory f, bytes32[] memory p1, bytes32[] memory p2) = confirm(1);
        bytes32 id = exit1(1, f, p1);
        pauseBy(false); // admin B alone
        assertTrue(pool.paused());
        vm.expectRevert(ExitPool.Paused.selector);
        exit2(1, f, p2);
        // everything that returns money keeps working while paused
        vm.deal(pool.exitAddressFor(alice, SALT1), AMOUNT_WEI);
        pool.settle(id);
        uint256 shares = pool.shares(lp);
        vm.prank(lp);
        pool.withdraw(shares / 10);
        // resuming needs both admins
        adminDo(address(pool), "unpause", "", "");
        assertFalse(pool.paused());
        exit2(1, f, p2);
    }

    function test_pause_needs_an_admin_signature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory m = pool.adminMessage("pause", "", pool.adminNonce(), deadline);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, adminA));
        pool.pause(deadline, true, sign(alice, m));
        // a classical-key holder calling as the admin gets nowhere: msg.sender authorises nothing
        vm.prank(adminA);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, adminA));
        pool.pause(deadline, true, new bytes(4627));
    }

    // ================================================================= quote and stats

    function test_quote_explains_every_outcome() public {
        (uint8 s,,,) = pool.quote(rollupKey, 1, AMOUNT_UQOR);
        assertEq(s, pool.Q_NOT_CONFIRMED());
        (ExitPool.Facts memory f,,) = confirm(1);
        uint256 fee;
        uint256 payout;
        uint256 room;
        (s, fee, payout, room) = pool.quote(rollupKey, 1, AMOUNT_UQOR);
        assertEq(s, pool.Q_OK());
        assertEq(fee, AMOUNT_WEI * 50 / 10_000);
        assertEq(payout, AMOUNT_WEI - fee);
        assertEq(room, 2 * LOCK); // two confirmers, LOCK each
        (s,,,) = pool.quote(rollupKey, 1, 9_000_000); // more than the cover
        assertEq(s, pool.Q_COVER());
        setRisk(0, 0, 1 ether, 0);
        (s,,,) = pool.quote(rollupKey, 1, AMOUNT_UQOR);
        assertEq(s, pool.Q_EXIT_TOO_LARGE());
        pauseBy(true);
        (s,,,) = pool.quote(rollupKey, 1, AMOUNT_UQOR);
        assertEq(s, pool.Q_PAUSED());
        adminDo(address(pool), "unpause", "", "");
        ExitPool.Facts memory lie = ExitPool.Facts(keccak256("x"), f.withdrawalsRoot, f.exitRoot);
        pool.reportEquivocation(rollupKey, 1, w2, f, sigOf(w2, 1, f), lie, sigOf(w2, 1, lie));
        (s,,,) = pool.quote(rollupKey, 1, 500_000);
        assertEq(s, pool.Q_CONTESTED());
        vm.warp(block.timestamp + WINDOW + 1);
        confirmAt(2);
        (s,,,) = pool.quote(rollupKey, 1, 500_000);
        assertEq(s, pool.Q_CONTESTED()); // contested wins over too-late in the order of checks
    }

    function confirmAt(uint64 idx) internal {
        (ExitPool.Facts memory f,,) = facts();
        attestAs(w1, idx, f);
        attestAs(w3, idx, f);
    }

    function test_watcher_stats_are_counted() public {
        confirm(1);
        confirm(2);
        (uint64 att, uint64 conf,,,) = pool.stats(w1);
        assertEq(att, 2);
        assertEq(conf, 2);
        (att, conf,,,) = pool.stats(w3);
        assertEq(att, 0);
        assertEq(conf, 0);
    }

    // ================================================================= v3.1: keeper execution fee

    function test_execution_fee_is_paid_by_the_user_and_held_for_the_keeper() public {
        setRisk(0, 0, 0, 0, 0.08 ether);
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        uint256 before = alice.balance;
        uint256 assetsBefore = pool.totalAssets();
        bytes32 id = exit1(1, f, p1);
        (,,, uint256 feeWei,,,,,, uint256 tipWei) = pool.advances(id);
        assertEq(tipWei, 0.08 ether);
        assertEq(alice.balance - before, AMOUNT_WEI - feeWei - 0.08 ether); // the user pays fee and execution fee
        assertEq(pool.pendingTipsWei(), 0.08 ether);
        assertEq(pool.totalAssets(), assetsBefore + feeWei); // providers gain the fee only, never the held tip
        vm.deal(pool.exitAddressFor(alice, SALT1), AMOUNT_WEI);
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        pool.settle(id);
        assertEq(pool.watcherCredit(keeper), feeWei * 1000 / 10_000 + 0.08 ether);
        assertEq(pool.pendingTipsWei(), 0);
    }

    function test_execution_fee_goes_to_whoever_writes_off() public {
        setRisk(0, 0, 0, 0, 0.08 ether);
        (ExitPool.Facts memory f, bytes32[] memory p1,) = confirm(1);
        bytes32 id = exit1(1, f, p1);
        (,,, uint256 feeWei,,,,,,) = pool.advances(id);
        vm.warp(block.timestamp + WINDOW + GRACE + 1);
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        pool.markDefault(id);
        assertEq(pool.watcherCredit(keeper), feeWei * 1000 / 10_000 + 0.08 ether);
        assertEq(pool.pendingTipsWei(), 0);
    }

    function test_exit_smaller_than_its_fees_is_refused() public {
        setRisk(0, 0, 0, 0, 1 ether); // a 1 QOR execution fee (the maximum)
        // one 0.9 QOR withdrawal: smaller than the fees it would pay
        address exitAddr = pool.exitAddressFor(alice, SALT1);
        ExitPool.Facts memory f = ExitPool.Facts(keccak256("s"), keccak256("w"), pool.exitLeaf(7, exitAddr, 900_000));
        attestAs(w1, 1, f);
        attestAs(w2, 1, f);
        (uint8 status,,,) = pool.quote(rollupKey, 1, 900_000);
        assertEq(status, pool.Q_TOO_SMALL());
        vm.expectRevert(ExitPool.ExitTooSmall.selector);
        pool.instantExit(rollupKey, 1, f, 7, alice, SALT1, 900_000, new bytes32[](0));
        (status,,,) = pool.quote(rollupKey, 1, 2_000_000); // a 2 QOR exit still clears the fees
        assertEq(status, pool.Q_OK());
    }

    function test_execution_fee_is_bounded() public {
        vm.expectRevert(ExitPool.BadRisk.selector);
        this.callSetRiskTip(1.5 ether);
    }

    function callSetRiskTip(uint128 tip) external {
        pool.setRisk(rollupKey, ExitPool.Risk(0, 0, 0, 0, tip), block.timestamp + 1, "", "");
    }
}
