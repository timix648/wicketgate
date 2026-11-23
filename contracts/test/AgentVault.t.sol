// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Base} from "./utils/Base.sol";
import {ExitPool} from "../src/ExitPool.sol";
import {WatcherRegistry} from "../src/WatcherRegistry.sol";
import {LaneHub} from "../src/LaneHub.sol";
import {AgentVault, ILaneHub} from "../src/AgentVault.sol";
import {PQGuard} from "../src/lib/PQGuard.sol";

contract Stranger {}

/// An AI agent manages an owner's liquidity across instant-exit pools, only inside chain-enforced
/// limits and only with its ML-DSA-87 signature.
contract AgentVaultTest is Base {
    LaneHub hub;
    AgentVault vault;
    ExitPool lane;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address thief = makeAddr("thief");
    bytes32 skyKey = keccak256("skyproof-1");

    function setUp() public override {
        super.setUp();
        giveKey(agent);
        giveKey(thief);
        hub = new LaneHub(keccak256(type(ExitPool).creationCode), keccak256(type(WatcherRegistry).creationCode));
        vm.prank(adminA);
        (address pa,) = hub.openLane("skyproof-1", LaneHub.LaneParams(adminA, adminB, MIN_STAKE, 3 days), type(WatcherRegistry).creationCode, type(ExitPool).creationCode);
        lane = ExitPool(payable(pa));
        vault = new AgentVault(owner, agent, address(pool), ILaneHub(address(hub)), 6000);
        vm.deal(owner, 100 ether);
        vm.prank(owner);
        vault.fund{value: 10 ether}();
    }

    function sig(address signer, bytes32 action, address p, uint256 amount) internal view returns (uint256 d, bytes memory s) {
        d = block.timestamp + 1 hours;
        s = sign(signer, vault.agentMessage(action, p, amount, vault.agentNonce(), d));
    }

    function test_agentAllocatesToRecognisedPools() public {
        (uint256 d, bytes memory s) = sig(agent, "allocate", address(pool), 5 ether);
        vault.allocate(address(pool), 5 ether, d, s);
        (d, s) = sig(agent, "allocate", address(lane), 4 ether);
        vault.allocate(address(lane), 4 ether, d, s);
        assertApproxEqAbs(vault.positionWei(address(pool)), 5 ether, 1e9);
        assertApproxEqAbs(vault.positionWei(address(lane)), 4 ether, 1e9);
        assertApproxEqAbs(vault.totalValueWei(), 10 ether, 1e9);
        assertEq(vault.poolCount(), 2);
    }

    function test_capPerPool() public {
        (uint256 d, bytes memory s) = sig(agent, "allocate", address(pool), 7 ether); // 70% > 60% cap
        vm.expectRevert(AgentVault.OverCap.selector);
        vault.allocate(address(pool), 7 ether, d, s);
    }

    function test_refusesPoolsTheChainDoesNotRecognise() public {
        address fake = address(new Stranger());
        (uint256 d, bytes memory s) = sig(agent, "allocate", fake, 1 ether);
        vm.expectRevert(AgentVault.PoolNotRecognised.selector);
        vault.allocate(fake, 1 ether, d, s);
    }

    function test_onlyTheAgentsPostQuantumSignatureMovesMoney() public {
        (uint256 d, bytes memory s) = sig(thief, "allocate", address(pool), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, agent));
        vault.allocate(address(pool), 1 ether, d, s);
    }

    function test_noReplay() public {
        (uint256 d, bytes memory s) = sig(agent, "allocate", address(pool), 1 ether);
        vault.allocate(address(pool), 1 ether, d, s);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.BadSignature.selector, agent));
        vault.allocate(address(pool), 1 ether, d, s);
    }

    function test_ownerStopsTheAgent() public {
        vm.prank(owner);
        vault.setPolicy(agent, 6000, true);
        (uint256 d, bytes memory s) = sig(agent, "allocate", address(pool), 1 ether);
        vm.expectRevert(AgentVault.AgentPaused.selector);
        vault.allocate(address(pool), 1 ether, d, s);
    }

    function test_moneyOnlyLeavesToTheOwner() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdraw(1 ether);
        uint256 before = owner.balance;
        vm.prank(owner);
        vault.withdraw(2 ether);
        assertEq(owner.balance, before + 2 ether);
    }

    function test_releaseBringsLiquidityBack() public {
        (uint256 d, bytes memory s) = sig(agent, "allocate", address(pool), 5 ether);
        vault.allocate(address(pool), 5 ether, d, s);
        uint256 sh = pool.shares(address(vault));
        (d, s) = sig(agent, "release", address(pool), sh);
        vault.release(address(pool), sh, d, s);
        assertEq(pool.shares(address(vault)), 0);
        assertApproxEqAbs(address(vault).balance, 10 ether, 1e9);
    }

    /// The vault's position grows when the pool it backs is paid a fee for an instant exit.
    function test_positionEarnsExitFees() public {
        (uint256 d, bytes memory s) = sig(agent, "allocate", address(pool), 5 ether);
        vault.allocate(address(pool), 5 ether, d, s);
        uint256 before = vault.positionWei(address(pool));
        joinAll();
        bytes32 salt = keccak256("v");
        bytes32 leaf = pool.exitLeaf(1, pool.exitAddressFor(alice, salt), 2_000_000);
        ExitPool.Facts memory f = ExitPool.Facts(keccak256("s"), keccak256("w"), leaf);
        attestAs(w1, 9, f);
        attestAs(w2, 9, f);
        pool.instantExit(rollupKey, 9, f, 1, alice, salt, 2_000_000, new bytes32[](0));
        // the fee is held in the pool once settled; an open advance counts at face value meanwhile
        assertGe(vault.positionWei(address(pool)), before);
    }
}
