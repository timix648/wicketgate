// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Base} from "./utils/Base.sol";
import {ExitPool} from "../src/ExitPool.sol";
import {WatcherRegistry} from "../src/WatcherRegistry.sol";
import {LaneHub} from "../src/LaneHub.sol";
import {PQGuard} from "../src/lib/PQGuard.sol";

/// Permissionless lanes: anyone with two ML-DSA-87 keys can open an isolated instant-exit lane for
/// any rollup, running only the audited code, without Wicketgate's admins.
contract LaneHubTest is Base {
    LaneHub hub;
    address carol = makeAddr("carol"); // an outside lane provider
    address dave = makeAddr("dave"); // carol's second key
    address nokey = makeAddr("nokey");
    string constant SKY = "skyproof-1";
    bytes32 skyKey = keccak256(bytes(SKY));

    function setUp() public override {
        super.setUp();
        giveKey(carol);
        giveKey(dave);
        hub = new LaneHub(keccak256(type(ExitPool).creationCode), keccak256(type(WatcherRegistry).creationCode));
    }

    function open(address by, address a, address b) internal returns (ExitPool p, WatcherRegistry r) {
        vm.prank(by);
        (address pa, address ra) =
            hub.openLane(SKY, LaneHub.LaneParams(a, b, MIN_STAKE, 3 days), type(WatcherRegistry).creationCode, type(ExitPool).creationCode);
        return (ExitPool(payable(pa)), WatcherRegistry(ra));
    }

    /// Both lane admins sign `action` on `target` (a hub-made lane, not Wicketgate's own).
    function laneSigs(address target, bytes32 action, bytes memory payload) internal view returns (uint256 d, bytes memory sa, bytes memory sb) {
        d = block.timestamp + 1 hours;
        uint256 nonce = ExitPool(payable(target)).adminNonce();
        bytes memory m = ExitPool(payable(target)).adminMessage(action, payload, nonce, d);
        sa = sign(carol, m);
        sb = sign(dave, m);
    }

    function test_anyoneWithPqKeysOpensALane() public {
        (ExitPool p, WatcherRegistry r) = open(carol, carol, dave);
        assertEq(p.adminA(), carol);
        assertEq(p.adminB(), dave);
        assertEq(address(p.registry()), address(r));
        LaneHub.LaneInfo[] memory l = hub.lanesOf(skyKey);
        assertEq(l.length, 1);
        assertEq(l[0].pool, address(p));
        assertEq(l[0].opener, carol);
        assertEq(hub.rollupOfPool(address(p)), skyKey);
        assertEq(hub.rollupCount(), 1);
        // the lane runs exactly the audited code
        assertEq(keccak256(address(p).code), keccak256(address(new ExitPool(carol, dave, r)).code));
    }

    function test_refusesAnyOtherCode() public {
        bytes memory bad = type(ExitPool).creationCode;
        bad[bad.length - 40] = bytes1(uint8(bad[bad.length - 40]) ^ 1);
        vm.prank(carol);
        vm.expectRevert(LaneHub.WrongCode.selector);
        hub.openLane(SKY, LaneHub.LaneParams(carol, dave, MIN_STAKE, 3 days), type(WatcherRegistry).creationCode, bad);
    }

    function test_openerMustBeAnAdmin() public {
        vm.prank(alice);
        vm.expectRevert(LaneHub.NotAnAdmin.selector);
        hub.openLane(SKY, LaneHub.LaneParams(carol, dave, MIN_STAKE, 3 days), type(WatcherRegistry).creationCode, type(ExitPool).creationCode);
    }

    function test_adminsNeedProvenPqKeys() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.NoProvenKey.selector, nokey));
        hub.openLane(SKY, LaneHub.LaneParams(carol, nokey, MIN_STAKE, 3 days), type(WatcherRegistry).creationCode, type(ExitPool).creationCode);
    }

    function test_severalProvidersCompeteForOneRollup() public {
        (ExitPool p1,) = open(carol, carol, dave);
        (ExitPool p2,) = open(adminA, adminA, adminB);
        assertTrue(address(p1) != address(p2));
        assertEq(hub.lanesOf(skyKey).length, 2);
        assertEq(hub.rollupCount(), 1);
    }

    /// End to end on a hub-made lane: the provider binds and configures it with its own PQ keys,
    /// watchers stake in that lane, an LP funds it, and an instant exit is paid from the lane's
    /// liquidity only. Wicketgate's own pool is untouched throughout.
    function test_instantExitOnAnIsolatedLane() public {
        vm.prank(lp);
        pool.deposit{value: 100 ether}();
        uint256 mainBefore = address(pool).balance;

        (ExitPool p, WatcherRegistry r) = open(carol, carol, dave);
        (uint256 d, bytes memory sa, bytes memory sb) = laneSigs(address(r), "setPool", abi.encode(address(p)));
        r.setPool(address(p), d, sa, sb);
        ExitPool.Lane memory lane = ExitPool.Lane(WINDOW, GRACE, 50, 2, LOCK, true);
        (d, sa, sb) = laneSigs(address(p), "setLane", abi.encode(skyKey, lane));
        p.setLane(skyKey, lane, d, sa, sb);

        vm.prank(w1);
        r.join{value: 10 ether}();
        vm.prank(w2);
        r.join{value: 10 ether}();
        vm.prank(lp);
        p.deposit{value: 20 ether}();

        bytes32 salt = keccak256("sky-salt");
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = p.exitLeaf(3, p.exitAddressFor(alice, salt), 2_000_000);
        ExitPool.Facts memory f = ExitPool.Facts(keccak256("state"), keccak256("withdrawals"), leaves[0]);
        for (uint256 i = 0; i < 2; i++) {
            address w = i == 0 ? w1 : w2;
            bytes memory m = p.attestationMessage(skyKey, 5, f);
            vm.prank(w);
            p.attest(skyKey, 5, f, sign(w, m));
        }
        uint256 aliceBefore = alice.balance;
        p.instantExit(skyKey, 5, f, 3, alice, salt, 2_000_000, new bytes32[](0));
        assertGt(alice.balance, aliceBefore);
        assertLt(address(p).balance, 20 ether);
        assertEq(address(pool).balance, mainBefore, "Wicketgate's own pool is untouched");
    }
}
