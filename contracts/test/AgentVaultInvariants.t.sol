// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Base} from "./utils/Base.sol";
import {ExitPool} from "../src/ExitPool.sol";
import {WatcherRegistry} from "../src/WatcherRegistry.sol";
import {LaneHub} from "../src/LaneHub.sol";
import {AgentVault, ILaneHub} from "../src/AgentVault.sol";

contract FakePool {
    function deposit() external payable returns (uint256) { return msg.value; }
}

/// Random agent, owner and attacker actions against an AgentVault holding positions in real pools.
contract VaultHandler is CommonBase, StdUtils {
    AgentVault public vault;
    address[] public pools; // recognised: the main pool and a hub lane
    address public fake;
    address public owner;
    address public agent;
    address public thief;
    uint256 public funded;
    uint256 public withdrawn;
    uint256 public forgedSucceeded; // must stay 0
    uint256 public unrecognisedSucceeded; // must stay 0

    constructor(AgentVault v, address[] memory p, address o, address a, address t) {
        vault = v; pools = p; owner = o; agent = a; thief = t;
        fake = address(new FakePool());
    }

    function _pk(address a) internal pure returns (bytes memory pk) {
        pk = new bytes(2592);
        bytes32 seed = keccak256(abi.encode("pk", a));
        for (uint256 i = 0; i < 2592; i++) pk[i] = seed[i % 32];
    }

    function _sign(address a, bytes memory m) internal pure returns (bytes memory sig) {
        sig = new bytes(4627);
        bytes32 h = keccak256(abi.encode(keccak256(_pk(a)), keccak256(m)));
        for (uint256 i = 0; i < 32; i++) sig[i] = h[i];
    }

    function _msg(bytes32 action, address p, uint256 amount, uint256 d) internal view returns (bytes memory) {
        return vault.agentMessage(action, p, amount, vault.agentNonce(), d);
    }

    function fund(uint96 amount) external {
        amount = uint96(bound(amount, 1e15, 50 ether));
        vm.deal(owner, owner.balance + amount);
        vm.prank(owner);
        vault.fund{value: amount}();
        funded += amount;
    }

    function agentAllocate(uint256 pi, uint96 amount) external {
        address p = pools[pi % pools.length];
        uint256 idle = address(vault).balance;
        if (idle == 0) return;
        amount = uint96(bound(amount, 1, idle));
        uint256 d = block.timestamp + 100;
        try vault.allocate(p, amount, d, _sign(agent, _msg("allocate", p, amount, d))) {} catch {}
    }

    function agentRelease(uint256 pi, uint256 frac) external {
        address p = pools[pi % pools.length];
        uint256 sh = ExitPool(payable(p)).shares(address(vault));
        if (sh == 0) return;
        uint256 amt = (sh * bound(frac, 1, 100)) / 100;
        uint256 d = block.timestamp + 100;
        try vault.release(p, amt, d, _sign(agent, _msg("release", p, amt, d))) {} catch {}
    }

    function thiefForges(uint256 pi, uint96 amount) external {
        address p = pools[pi % pools.length];
        uint256 d = block.timestamp + 100;
        amount = uint96(bound(amount, 1, 10 ether));
        try vault.allocate(p, amount, d, _sign(thief, _msg("allocate", p, amount, d))) { forgedSucceeded++; } catch {}
        vm.prank(thief);
        try vault.withdraw(amount) { forgedSucceeded++; } catch {}
    }

    function agentTriesUnrecognised(uint96 amount) external {
        amount = uint96(bound(amount, 1, 1 ether));
        uint256 d = block.timestamp + 100;
        try vault.allocate(fake, amount, d, _sign(agent, _msg("allocate", fake, amount, d))) { unrecognisedSucceeded++; } catch {}
    }

    function ownerWithdraws(uint96 amount) external {
        uint256 idle = address(vault).balance;
        if (idle == 0) return;
        amount = uint96(bound(amount, 1, idle));
        vm.prank(owner);
        vault.withdraw(amount);
        withdrawn += amount;
    }

    function ownerToggles(bool paused) external {
        vm.prank(owner);
        vault.setPolicy(agent, 6000, paused);
    }

    function timePasses(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }
}

contract AgentVaultInvariantsTest is Base {
    VaultHandler handler;
    AgentVault vault;
    address owner = makeAddr("vowner");
    address agent = makeAddr("vagent");
    address thief = makeAddr("vthief");

    function setUp() public override {
        super.setUp();
        giveKey(agent);
        giveKey(thief);
        LaneHub hub = new LaneHub(keccak256(type(ExitPool).creationCode), keccak256(type(WatcherRegistry).creationCode));
        vm.prank(adminA);
        (address lanePool,) = hub.openLane("skyproof-1", LaneHub.LaneParams(adminA, adminB, MIN_STAKE, 3 days), type(WatcherRegistry).creationCode, type(ExitPool).creationCode);
        vault = new AgentVault(owner, agent, address(pool), ILaneHub(address(hub)), 6000);
        address[] memory p = new address[](2);
        p[0] = address(pool);
        p[1] = lanePool;
        handler = new VaultHandler(vault, p, owner, agent, thief);
        targetContract(address(handler));
    }

    /// Value is conserved: what the owner put in is in the vault (idle or as pool positions) or back with the owner.
    function invariant_value_conserved() public view {
        uint256 have = vault.totalValueWei() + handler.withdrawn();
        uint256 put = handler.funded();
        // pool share rounding loses at most a few wei per operation, never gains
        assertLe(have, put + 2);
        assertGe(have + 1e9, put);
    }

    /// The agent and an attacker never receive QOR.
    function invariant_no_leakage() public view {
        assertEq(agent.balance, 0);
        assertEq(thief.balance, 0);
    }

    function invariant_forgeries_never_succeed() public view {
        assertEq(handler.forgedSucceeded(), 0);
        assertEq(handler.unrecognisedSucceeded(), 0);
    }

    function invariant_positions_only_in_recognised_pools() public view {
        for (uint256 i = 0; i < vault.poolCount(); i++) assertTrue(vault.recognised(vault.pools(i)));
    }
}
