// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Directory} from "../src/Directory.sol";
import {MemoBoard} from "../src/MemoBoard.sol";

contract DirectoryMemoTest is Test {
    Directory dir = new Directory();
    MemoBoard board = new MemoBoard();
    bytes32 rk = keccak256("wicketgate-pay");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function test_link_and_relink() public {
        vm.prank(alice);
        dir.link(rk, bytes32(uint256(1)));
        assertEq(dir.ledgerAccountOf(rk, alice), bytes32(uint256(1)));
        assertEq(dir.ownerOf(rk, bytes32(uint256(1))), alice);
        vm.prank(alice);
        dir.link(rk, bytes32(uint256(2)));
        assertEq(dir.ownerOf(rk, bytes32(uint256(1))), address(0)); // old entry freed
        assertEq(dir.ownerOf(rk, bytes32(uint256(2))), alice);
    }

    function test_cannot_take_someone_elses_account() public {
        vm.prank(alice);
        dir.link(rk, bytes32(uint256(7)));
        vm.prank(bob);
        vm.expectRevert(Directory.Taken.selector);
        dir.link(rk, bytes32(uint256(7)));
    }

    function test_memo_emits_and_limits_size() public {
        bytes memory env = new bytes(1760);
        vm.expectEmit(true, true, true, true);
        emit MemoBoard.Memo(rk, bytes32(uint256(9)), bytes32(uint256(5)), alice, env);
        vm.prank(alice);
        board.post(rk, bytes32(uint256(9)), bytes32(uint256(5)), env);
        vm.expectRevert(MemoBoard.TooLarge.selector);
        board.post(rk, bytes32(uint256(9)), bytes32(uint256(5)), new bytes(4097));
    }
}
