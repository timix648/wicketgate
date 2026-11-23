// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {PQGuard} from "./lib/PQGuard.sol";

interface IPool {
    function deposit() external payable returns (uint256);
    function withdraw(uint256 shareAmount) external returns (uint256);
    function shares(address) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function totalShares() external view returns (uint256);
}

interface ILaneHub {
    function rollupOfPool(address pool) external view returns (bytes32);
}

/// @title AgentVault
/// @notice Liquidity for instant exits, managed by an AI agent the owner chooses, inside limits the
/// chain enforces. The agent can only move the vault's QOR between pools the chain recognises
/// (Wicketgate's main pool, or a lane the LaneHub deployed), never above the owner's per-pool cap,
/// and every move needs the agent's ML-DSA-87 signature, checked on chain through pqcVerify: a
/// stolen classical key moves nothing. Money leaves the vault only to the owner.
contract AgentVault {
    bytes32 public constant AGENT_TYPEHASH = keccak256("Wicketgate.AgentVault.v1");

    address public immutable owner;
    address public immutable mainPool;
    ILaneHub public immutable hub;

    address public agent;
    uint16 public maxPerPoolBps; // cap on the share of the vault in any one pool
    bool public agentPaused;
    uint256 public agentNonce;

    address[] public pools; // pools the vault has ever held shares in
    mapping(address => bool) private _known;

    error NotOwner();
    error AgentPaused();
    error PoolNotRecognised();
    error OverCap();
    error Expired();
    error BadPolicy();

    event Policy(address agent, uint16 maxPerPoolBps, bool paused);
    event Allocated(address indexed pool, uint256 amountWei, uint256 sharesMinted, uint256 nonce);
    event Released(address indexed pool, uint256 shareAmount, uint256 amountWei, uint256 nonce);
    event Funded(uint256 amountWei);
    event Withdrawn(uint256 amountWei);

    constructor(address owner_, address agent_, address mainPool_, ILaneHub hub_, uint16 maxPerPoolBps_) {
        if (maxPerPoolBps_ == 0 || maxPerPoolBps_ > 10_000) revert BadPolicy();
        owner = owner_;
        agent = agent_;
        mainPool = mainPool_;
        hub = hub_;
        maxPerPoolBps = maxPerPoolBps_;
        emit Policy(agent_, maxPerPoolBps_, false);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    receive() external payable {}

    // ------------------------------------------------------------------ owner

    function fund() external payable onlyOwner {
        emit Funded(msg.value);
    }

    /// @notice The owner changes the agent, the cap, or stops the agent at once.
    function setPolicy(address agent_, uint16 maxPerPoolBps_, bool paused_) external onlyOwner {
        if (maxPerPoolBps_ == 0 || maxPerPoolBps_ > 10_000) revert BadPolicy();
        agent = agent_;
        maxPerPoolBps = maxPerPoolBps_;
        agentPaused = paused_;
        emit Policy(agent_, maxPerPoolBps_, paused_);
    }

    /// @notice The owner pulls shares out of a pool back into the vault, without the agent.
    function ownerRelease(address pool, uint256 shareAmount) external onlyOwner {
        uint256 got = IPool(pool).withdraw(shareAmount);
        emit Released(pool, shareAmount, got, type(uint256).max);
    }

    /// @notice Idle QOR goes to the owner, and only to the owner.
    function withdraw(uint256 amountWei) external onlyOwner {
        (bool ok,) = owner.call{value: amountWei}("");
        require(ok, "send failed");
        emit Withdrawn(amountWei);
    }

    // ------------------------------------------------------------------ agent (ML-DSA-87 signed)

    function agentMessage(bytes32 action, address pool, uint256 amount, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(AGENT_TYPEHASH, block.chainid, address(this), action, pool, amount, nonce, deadline);
    }

    /// @notice Put `amountWei` of idle QOR into a recognised pool. Anyone may submit the call; only
    /// the agent's post-quantum signature authorises it.
    function allocate(address pool, uint256 amountWei, uint256 deadline, bytes calldata sig) external {
        _authorise("allocate", pool, amountWei, deadline, sig);
        if (!recognised(pool)) revert PoolNotRecognised();
        if (positionWei(pool) + amountWei > (totalValueWei() * maxPerPoolBps) / 10_000) revert OverCap();
        if (!_known[pool]) {
            _known[pool] = true;
            pools.push(pool);
        }
        uint256 minted = IPool(pool).deposit{value: amountWei}();
        emit Allocated(pool, amountWei, minted, agentNonce - 1);
    }

    /// @notice Bring `shareAmount` of a pool's shares back to the vault as QOR.
    function release(address pool, uint256 shareAmount, uint256 deadline, bytes calldata sig) external {
        _authorise("release", pool, shareAmount, deadline, sig);
        uint256 got = IPool(pool).withdraw(shareAmount);
        emit Released(pool, shareAmount, got, agentNonce - 1);
    }

    function _authorise(bytes32 action, address pool, uint256 amount, uint256 deadline, bytes calldata sig) private {
        if (agentPaused) revert AgentPaused();
        if (block.timestamp > deadline) revert Expired();
        PQGuard.requireSigned(agent, agentMessage(action, pool, amount, agentNonce, deadline), sig);
        unchecked {
            agentNonce++;
        }
    }

    // ------------------------------------------------------------------ views

    /// @notice Wicketgate's main pool, or a lane the LaneHub deployed (so it runs the audited code).
    function recognised(address pool) public view returns (bool) {
        return pool == mainPool || hub.rollupOfPool(pool) != bytes32(0);
    }

    function positionWei(address pool) public view returns (uint256) {
        IPool p = IPool(pool);
        uint256 s = p.shares(address(this));
        if (s == 0) return 0;
        return (s * (p.totalAssets() + 1)) / (p.totalShares() + 1e6);
    }

    function totalValueWei() public view returns (uint256 v) {
        v = address(this).balance;
        for (uint256 i = 0; i < pools.length; i++) v += positionWei(pools[i]);
    }

    function poolCount() external view returns (uint256) {
        return pools.length;
    }
}
