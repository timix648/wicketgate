// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClassicalTwin} from "../demo/ClassicalTwin.sol";

/// The twin works for honest use and falls to anyone holding a watcher's classical key.
contract ClassicalTwinTest is Test {
    uint256 constant WEAK_KEY = 0xA1B2C3D4E5; // 40 bits, as in the Q-Day simulation
    address watcher = vm.addr(WEAK_KEY);
    address mallory = makeAddr("mallory");
    ClassicalTwin twin;
    bytes32 rollupKey = keccak256("wicketgate-pay");

    function setUp() public {
        address[] memory w = new address[](1);
        w[0] = watcher;
        twin = new ClassicalTwin{value: 10 ether}(w);
    }

    function test_stolen_classical_key_drains_the_pool() public {
        uint256 loot = address(twin).balance;
        ClassicalTwin.Facts memory f = ClassicalTwin.Facts(keccak256("any"), keccak256("thing"), twin.exitLeaf(0, mallory, loot));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WEAK_KEY, twin.digest(rollupKey, 999, f));
        vm.startPrank(mallory);
        twin.attest(rollupKey, 999, f, v, r, s);
        twin.instantExit(rollupKey, 999, f, 0, payable(mallory), loot, new bytes32[](0));
        vm.stopPrank();
        assertEq(address(twin).balance, 0);
        assertEq(mallory.balance, loot);
    }

    function test_without_the_key_nothing_moves() public {
        ClassicalTwin.Facts memory f = ClassicalTwin.Facts(0, 0, twin.exitLeaf(0, mallory, 1 ether));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBEEF, twin.digest(rollupKey, 1, f));
        vm.expectRevert(ClassicalTwin.NotWatcher.selector);
        twin.attest(rollupKey, 1, f, v, r, s);
    }
}
