// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Base} from "./utils/Base.sol";
import {ExitPool} from "../src/ExitPool.sol";
import {WatcherRegistry} from "../src/WatcherRegistry.sol";
import {PQGuard} from "../src/lib/PQGuard.sol";
import {DualAdmin} from "../src/lib/DualAdmin.sol";
import {MockPQC} from "./utils/MockPQC.sol";

contract ExitPoolTest is Base {
    bytes32 salt = keccak256("salt-1");
    uint256 constant AMOUNT_UQOR = 2_000_000; // 2 QOR
    uint256 constant AMOUNT_WEI = 2 ether;

    function setUp() public override {
        super.setUp();
        joinAll();
        vm.prank(lp);
        pool.deposit{value: 100 ether}();
    }

    /// One withdrawal of 2 QOR to alice's exit address, plus a second unrelated one.
    function facts() internal view returns (ExitPool.Facts memory f, bytes32[] memory proof) {
        address exitAddr = pool.exitAddressFor(alice, salt);
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = pool.exitLeaf(7, exitAddr, AMOUNT_UQOR);
        leaves[1] = pool.exitLeaf(8, address(0xB0B), 1_000_000);
        bytes32 root;
        (root, proof) = treeOf(leaves, 0);
        f = ExitPool.Facts(keccak256("state"), keccak256("withdrawals"), root);
    }

    function confirmBatch(uint64 idx) internal returns (ExitPool.Facts memory f, bytes32[] memory proof) {
        (f, proof) = facts();
        attestAs(w1, idx, f);
        attestAs(w2, idx, f);
    }

    function exitAlice(uint64 idx, ExitPool.Facts memory f, bytes32[] memory proof) internal returns (bytes32) {
        return pool.instantExit(rollupKey, idx, f, 7, alice, salt, AMOUNT_UQOR, proof);
    }

    // ================================================================= registry

    function test_join_requires_proven_key() public {
        address x = makeAddr("x");
        vm.deal(x, 10 ether);
        MockPQC(STATUS).setKey(x, true, 1, pubkeyOf(x), false); // no proof of possession
        vm.prank(x);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.NoProvenKey.selector, x));
        registry.join{value: 5 ether}();

        MockPQC(STATUS).setKey(x, true, 2, pubkeyOf(x), true); // wrong algorithm
        vm.prank(x);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.NoProvenKey.selector, x));
        registry.join{value: 5 ether}();
    }

    function test_join_requires_min_stake() public {
        address x = makeAddr("x");
        giveKey(x);
        vm.deal(x, 10 ether);
        vm.prank(x);
        vm.expectRevert(WatcherRegistry.StakeTooLow.selector);
        registry.join{value: 1 ether}();
    }

    function test_inactive_precompile_fails_closed() public {
        vm.etch(STATUS, "");
        address x = makeAddr("x");
        vm.deal(x, 10 ether);
        vm.prank(x);
        vm.expectRevert();
        registry.join{value: 5 ether}();
    }

    function test_leave_after_delay_returns_stake() public {
        vm.prank(w3);
        registry.requestLeave();
        assertFalse(registry.isActive(w3));
        vm.prank(w3);
        vm.expectRevert(WatcherRegistry.TooEarly.selector);
        registry.leave();
        vm.warp(block.timestamp + 3 days);
        uint256 before = w3.balance;
        vm.prank(w3);
        registry.leave();
        assertEq(w3.balance - before, 10 ether);
    }

    // ================================================================= admin

    function test_admin_needs_both_signatures() public {
        ExitPool.Lane memory lane = ExitPool.Lane(WINDOW, GRACE, 10, 1, LOCK, true);
        bytes memory m = pool.adminMessage("setLane", abi.encode(rollupKey, lane), pool.adminNonce(), block.timestamp + 1);
        bytes memory good = sign(adminA, m);
        bytes memory forged = sign(alice, m);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, adminB));
        pool.setLane(rollupKey, lane, block.timestamp + 1, good, forged);
    }

    function test_admin_signature_cannot_be_replayed() public {
        ExitPool.Lane memory lane = ExitPool.Lane(WINDOW, GRACE, 10, 1, LOCK, true);
        uint256 dl = block.timestamp + 1;
        bytes memory m = pool.adminMessage("setLane", abi.encode(rollupKey, lane), pool.adminNonce(), dl);
        bytes memory sa = sign(adminA, m);
        bytes memory sb = sign(adminB, m);
        pool.setLane(rollupKey, lane, dl, sa, sb);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, adminA));
        pool.setLane(rollupKey, lane, dl, sa, sb);
    }

    function test_admin_expired() public {
        ExitPool.Lane memory lane = ExitPool.Lane(WINDOW, GRACE, 10, 1, LOCK, true);
        vm.expectRevert(DualAdmin.Expired.selector);
        pool.setLane(rollupKey, lane, block.timestamp - 1, "", "");
    }

    function test_setPool_only_once() public {
        vm.expectRevert(WatcherRegistry.PoolAlreadySet.selector);
        registry.setPool(address(1), block.timestamp + 1, "", "");
    }

    // ================================================================= attestations

    function test_attest_rejects_non_watcher_and_bad_signature() public {
        (ExitPool.Facts memory f,) = facts();
        bytes memory m = pool.attestationMessage(rollupKey, 1, f);
        vm.prank(alice);
        vm.expectRevert(ExitPool.NotWatcher.selector);
        pool.attest(rollupKey, 1, f, sign(alice, m));

        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, w1));
        pool.attest(rollupKey, 1, f, sign(w2, m)); // someone else's signature
    }

    function test_attestation_bound_to_batch() public {
        (ExitPool.Facts memory f,) = facts();
        bytes memory forBatch1 = sign(w1, pool.attestationMessage(rollupKey, 1, f));
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, w1));
        pool.attest(rollupKey, 2, f, forBatch1);
    }

    function test_double_vote_rejected() public {
        (ExitPool.Facts memory f,) = facts();
        attestAs(w1, 1, f);
        bytes memory m = pool.attestationMessage(rollupKey, 1, f);
        vm.prank(w1);
        vm.expectRevert(ExitPool.AlreadyVoted.selector);
        pool.attest(rollupKey, 1, f, sign(w1, m));
    }

    function test_quorum_confirms_without_locking_then_locks_on_exit() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = facts();
        attestAs(w1, 1, f);
        (, uint64 confirmedAt,,,,,,,) = pool.getBatch(pool.batchKey(rollupKey, 1));
        assertEq(confirmedAt, 0);
        attestAs(w2, 1, f);
        (, uint64 c2,,,, uint256 cover,, address[] memory ws,) = pool.getBatch(pool.batchKey(rollupKey, 1));
        assertGt(c2, 0);
        assertEq(cover, 0); // v2: nothing locked until an exit is advanced
        assertEq(ws.length, 2);
        assertEq(registry.freeStake(w1), 10 ether);

        exitAlice(1, f, proof); // 2 QOR
        (,,,,, uint256 cover2, uint256 adv,, uint256[] memory locked) = pool.getBatch(pool.batchKey(rollupKey, 1));
        assertEq(adv, AMOUNT_WEI);
        assertGe(cover2, adv);
        assertEq(locked[0], 1 ether); // spread evenly
        assertEq(locked[1], 1 ether);
        assertEq(registry.freeStake(w1), 9 ether);
    }

    function test_exit_locks_from_watchers_with_room() public {
        // w1 has little free stake: the rest of the cover comes from w2
        ExitPool.Lane memory lane = ExitPool.Lane(WINDOW, GRACE, 50, 2, 8 ether, true);
        adminDo(address(pool), "setLane", abi.encode(rollupKey, lane), "");
        (ExitPool.Facts memory f,) = facts();
        attestAs(w1, 1, f);
        attestAs(w2, 1, f);
        vm.prank(w2);
        registry.topUp{value: 10 ether}();
        // 6 QOR withdrawal, w1 can give 8 max (has 10 free), w2 too: 3 + 3
        address e = pool.exitAddressFor(alice, keccak256("big"));
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = pool.exitLeaf(3, e, 6_000_000);
        ExitPool.Facts memory g = ExitPool.Facts(keccak256("s9"), keccak256("w9"), leaves[0]);
        attestAs(w1, 9, g);
        attestAs(w2, 9, g);
        pool.instantExit(rollupKey, 9, g, 3, alice, keccak256("big"), 6_000_000, new bytes32[](0));
        (,,,,, uint256 cover,,, uint256[] memory locked) = pool.getBatch(pool.batchKey(rollupKey, 9));
        assertEq(locked[0] + locked[1], cover);
        assertGe(cover, 6 ether);
    }

    function test_one_dissenting_watcher_blocks_confirmation() public {
        (ExitPool.Facts memory f,) = facts();
        ExitPool.Facts memory lie = ExitPool.Facts(keccak256("bad state"), f.withdrawalsRoot, f.exitRoot);
        attestAs(w1, 1, f);
        attestAs(w3, 1, lie); // disagreement
        attestAs(w2, 1, f);
        (, uint64 c, bool contested,,,,,,) = pool.getBatch(pool.batchKey(rollupKey, 1));
        assertTrue(contested);
        assertEq(c, 0);
    }

    function test_dissent_after_confirmation_freezes_new_exits() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        ExitPool.Facts memory other = ExitPool.Facts(keccak256("other"), f.withdrawalsRoot, f.exitRoot);
        attestAs(w3, 1, other);
        vm.expectRevert(ExitPool.BatchContested.selector);
        exitAlice(1, f, proof);
    }

    // ================================================================= instant exit

    function test_instant_exit_pays_and_settles() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        uint256 aliceBefore = alice.balance;
        bytes32 id = exitAlice(1, f, proof);
        uint256 fee = AMOUNT_WEI * 50 / 10_000;
        assertEq(alice.balance - aliceBefore, AMOUNT_WEI - fee);
        assertEq(pool.outstandingWei(), AMOUNT_WEI);

        // The chain pays the finalised withdrawal to the exit address.
        address exitAddr = pool.exitAddressFor(alice, salt);
        vm.deal(exitAddr, AMOUNT_WEI);
        uint256 assetsBefore = pool.totalAssets();
        pool.settle(id);
        (,,,,,,,, uint8 state) = pool.advances(id);
        assertEq(state, pool.SETTLED());
        assertEq(pool.outstandingWei(), 0);
        assertEq(exitAddr.balance, 0);
        // watchers get 30% of the fee, split between the two confirmers; v3: the keeper (here the
        // test contract, which called settle) is credited 10%; providers keep the other 60%
        assertEq(pool.watcherCredit(w1), fee * 3000 / 10_000 / 2);
        assertEq(pool.watcherCredit(address(this)), fee * 1000 / 10_000);
        assertEq(pool.totalAssets(), assetsBefore - fee * 3000 / 10_000 / 2 * 2 - fee * 1000 / 10_000);
        assertGt(pool.totalAssets(), 100 ether); // providers earned the rest
    }

    function test_settle_requires_funding() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        bytes32 id = exitAlice(1, f, proof);
        vm.expectRevert(ExitPool.NotFunded.selector);
        pool.settle(id);
    }

    function test_surplus_goes_to_beneficiary() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        bytes32 id = exitAlice(1, f, proof);
        address exitAddr = pool.exitAddressFor(alice, salt);
        vm.deal(exitAddr, AMOUNT_WEI + 1 ether);
        uint256 before = alice.balance;
        pool.settle(id);
        assertEq(alice.balance - before, 1 ether);
    }

    function test_exit_requires_confirmation() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = facts();
        attestAs(w1, 1, f);
        vm.expectRevert(ExitPool.NotConfirmed.selector);
        exitAlice(1, f, proof);
    }

    function test_exit_rejects_wrong_facts_and_bad_proof() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        ExitPool.Facts memory g = ExitPool.Facts(f.stateRoot, f.withdrawalsRoot, keccak256("x"));
        vm.expectRevert(ExitPool.WrongFacts.selector);
        exitAlice(1, g, proof);

        vm.expectRevert(ExitPool.BadProof.selector);
        pool.instantExit(rollupKey, 1, f, 7, alice, salt, AMOUNT_UQOR + 1, proof); // wrong amount

        vm.expectRevert(ExitPool.BadProof.selector);
        pool.instantExit(rollupKey, 1, f, 7, makeAddr("thief"), salt, AMOUNT_UQOR, proof); // wrong beneficiary
    }

    function test_exit_cannot_be_taken_twice() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        exitAlice(1, f, proof);
        vm.expectRevert(ExitPool.ExitUsed.selector);
        exitAlice(1, f, proof);
    }

    function test_exit_too_late() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(ExitPool.TooLate.selector);
        exitAlice(1, f, proof);
    }

    function test_advance_capped_by_cover() public {
        ExitPool.Lane memory lane = ExitPool.Lane(WINDOW, GRACE, 50, 2, 1 ether, true); // 1 QOR per watcher
        adminDo(address(pool), "setLane", abi.encode(rollupKey, lane), "");
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1); // cover 2 QOR
        exitAlice(1, f, proof); // exactly 2 QOR: allowed

        // a second, larger withdrawal against the same batch is refused
        bytes32 salt2 = keccak256("salt-2");
        address e2 = pool.exitAddressFor(alice, salt2);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = pool.exitLeaf(9, e2, 1_000_000);
        ExitPool.Facts memory f2 = ExitPool.Facts(keccak256("s2"), keccak256("w2"), leaves[0]);
        attestAs(w1, 2, f2);
        attestAs(w2, 2, f2);
        // batch 2 cover is limited by the free stake left after batch 1's lock
        pool.instantExit(rollupKey, 2, f2, 9, alice, salt2, 1_000_000, new bytes32[](0));
        (, , , , , uint256 cover2, uint256 adv2, ,) = pool.getBatch(pool.batchKey(rollupKey, 2));
        assertLe(adv2, cover2);
    }

    function test_no_liquidity() public {
        ExitPool p2 = new ExitPool(adminA, adminB, registry); // no deposits, not wired to registry
        assertEq(p2.idleLiquidity(), 0);
    }

    // ================================================================= default and recovery

    function test_default_slashes_confirming_watchers() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        bytes32 id = exitAlice(1, f, proof);
        vm.expectRevert(ExitPool.NotDue.selector);
        pool.markDefault(id);

        vm.warp(block.timestamp + WINDOW + GRACE + 1);
        uint256 assetsBefore = pool.totalAssets();
        uint256 s1 = registry.freeStake(w1) + _locked(w1);
        pool.markDefault(id);
        (,,,, uint256 slashedWei,,,, uint8 state) = pool.advances(id);
        assertEq(state, pool.DEFAULTED());
        assertEq(slashedWei, AMOUNT_WEI);
        // pool is made whole: it lost the payout, regained the full amount from stake; v3: the
        // keeper who wrote it off is credited 10% of the fee the pool kept at payout
        (,,, uint256 feeWei,,,,,) = pool.advances(id);
        assertEq(pool.watcherCredit(address(this)), feeWei * 1000 / 10_000);
        assertEq(pool.totalAssets(), assetsBefore - feeWei * 1000 / 10_000);
        assertEq(registry.freeStake(w1) + _locked(w1), s1 - 1 ether);
        assertEq(registry.freeStake(w3), 10 ether); // non-confirming watcher untouched
    }

    function test_default_refused_when_exit_address_funded() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        bytes32 id = exitAlice(1, f, proof);
        vm.deal(pool.exitAddressFor(alice, salt), AMOUNT_WEI);
        vm.warp(block.timestamp + WINDOW + GRACE + 1);
        vm.expectRevert(ExitPool.Funded.selector);
        pool.markDefault(id);
    }

    function test_late_repayment_refunds_slashed_watchers() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        bytes32 id = exitAlice(1, f, proof);
        vm.warp(block.timestamp + WINDOW + GRACE + 1);
        pool.markDefault(id);
        vm.deal(pool.exitAddressFor(alice, salt), AMOUNT_WEI);
        pool.settle(id);
        (,,,,,,,, uint8 state) = pool.advances(id);
        assertEq(state, pool.RECOVERED());
        assertEq(pool.watcherCredit(w1), 1 ether);
        assertEq(pool.watcherCredit(w2), 1 ether);
        uint256 before = w1.balance;
        vm.prank(w1);
        pool.claimCredit();
        assertEq(w1.balance - before, 1 ether);
    }

    function test_release_unlocks_after_window() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        bytes32 key = pool.batchKey(rollupKey, 1);
        bytes32 id = exitAlice(1, f, proof);
        vm.warp(block.timestamp + WINDOW + GRACE + 1);
        vm.expectRevert(ExitPool.StillOpen.selector);
        pool.release(key);
        vm.deal(pool.exitAddressFor(alice, salt), AMOUNT_WEI);
        pool.settle(id);
        pool.release(key);
        assertEq(registry.freeStake(w1), 10 ether);
    }

    // ================================================================= direct sweep

    function test_sweep_to_beneficiary_without_advance() public {
        address exitAddr = pool.exitAddressFor(alice, salt);
        vm.deal(exitAddr, 3 ether);
        uint256 before = alice.balance;
        pool.sweepToBeneficiary(alice, salt);
        assertEq(alice.balance - before, 3 ether);
    }

    function test_sweep_blocked_while_advance_open() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        exitAlice(1, f, proof);
        vm.deal(pool.exitAddressFor(alice, salt), AMOUNT_WEI);
        vm.expectRevert(ExitPool.StillOpen.selector);
        pool.sweepToBeneficiary(alice, salt);
    }

    // ================================================================= liquidity

    function test_withdraw_limited_to_idle() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        exitAlice(1, f, proof);
        uint256 sh = pool.shares(lp);
        vm.prank(lp);
        vm.expectRevert(ExitPool.NoLiquidity.selector);
        pool.withdraw(sh);
        vm.prank(lp);
        pool.withdraw(sh / 2);
    }

    function test_no_advance_for_a_withdrawal_already_paid() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        address exitAddr = pool.exitAddressFor(alice, salt);
        // the chain already paid the withdrawal to the exit address
        vm.deal(exitAddr, AMOUNT_WEI);
        vm.expectRevert(ExitPool.AlreadyPaid.selector);
        exitAlice(1, f, proof);
        // and once swept to the beneficiary, it still cannot be advanced
        pool.sweepToBeneficiary(alice, salt);
        vm.expectRevert(ExitPool.AlreadyPaid.selector);
        exitAlice(1, f, proof);
    }

    function test_dust_at_exit_address_does_not_block_the_exit() public {
        (ExitPool.Facts memory f, bytes32[] memory proof) = confirmBatch(1);
        vm.deal(pool.exitAddressFor(alice, salt), 1); // a griefer sends 1 wei
        exitAlice(1, f, proof); // still allowed
    }

    function test_first_depositor_cannot_inflate_shares() public {
        ExitPool p2 = new ExitPool(adminA, adminB, registry);
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 100 ether);
        vm.prank(attacker);
        p2.deposit{value: 1}(); // 1 wei
        vm.prank(attacker);
        (bool ok,) = address(p2).call{value: 50 ether}(""); // donate to inflate the share price
        assertTrue(ok);
        vm.deal(lp, 10 ether);
        vm.prank(lp);
        uint256 minted = p2.deposit{value: 10 ether}();
        assertGt(minted, 0); // the victim still gets shares
        // and the victim can take out almost all of what they put in
        vm.prank(lp);
        uint256 back = p2.withdraw(minted);
        assertGt(back, 9.99 ether);
    }

    // ================================================================= fuzz

    function testFuzz_advances_never_exceed_cover(uint96 amountUqor) public {
        amountUqor = uint96(bound(amountUqor, 1, 20_000_000)); // up to 20 QOR
        address exitAddr = pool.exitAddressFor(alice, salt);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = pool.exitLeaf(1, exitAddr, amountUqor);
        ExitPool.Facts memory f = ExitPool.Facts(keccak256("s"), keccak256("w"), leaves[0]);
        attestAs(w1, 5, f);
        attestAs(w2, 5, f);
        // v2: the most a batch can take is lockPerWatcher from each confirming watcher
        if (uint256(amountUqor) * 1e12 > 2 * uint256(LOCK)) {
            vm.expectRevert(ExitPool.CoverExceeded.selector);
        }
        pool.instantExit(rollupKey, 5, f, 1, alice, salt, amountUqor, new bytes32[](0));
    }

    function _locked(address w) internal view returns (uint256 l) {
        (, l,,) = registry.watchers(w);
    }
}
