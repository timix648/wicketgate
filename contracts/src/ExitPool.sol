// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {PQGuard} from "./lib/PQGuard.sol";
import {DualAdmin} from "./lib/DualAdmin.sol";
import {WatcherRegistry} from "./WatcherRegistry.sol";
import {ExitAddress} from "./ExitAddress.sol";

/// @title ExitPool
/// @notice Pays rollup withdrawals at once, against batches that enough staked watchers
/// have re-executed and signed with ML-DSA-87, and is repaid when the batch finalises.
///
/// Safety rules:
///  - Advances against a batch never exceed the stake its confirming watchers locked; that stake
///    is locked when the advance is made (v2), not when the batch is confirmed.
///  - One watcher attesting different facts marks the batch contested; nothing more is
///    advanced against it.
///  - An advance whose exit address is not funded by its due time is repaid from the
///    confirming watchers' stake.
contract ExitPool is DualAdmin {
    bytes32 public constant ATTEST_TYPEHASH = keccak256("Wicketgate.Attestation.v1");
    uint256 public constant UQOR = 1e12; // 1 uqor in wei on the QoreChain EVM
    uint256 public constant WATCHER_FEE_SHARE_BPS = 3000;
    uint256 private constant BPS = 10_000;

    uint8 public constant OPEN = 1;
    uint8 public constant SETTLED = 2;
    uint8 public constant DEFAULTED = 3;
    uint8 public constant RECOVERED = 4;

    struct Lane {
        uint64 windowSecs; // the rollup's challenge window
        uint64 graceSecs; // time allowed after the window for the withdrawal to be executed
        uint16 feeBps;
        uint8 quorum;
        uint128 lockPerWatcher; // stake each confirming watcher locks behind a batch
        bool enabled;
    }

    struct Facts {
        bytes32 stateRoot;
        bytes32 withdrawalsRoot;
        bytes32 exitRoot;
    }

    struct BatchRec {
        bytes32 factsHash;
        bytes32 firstFacts;
        uint64 confirmedAt;
        bool contested;
        bool released;
        uint32 openAdvances;
        uint256 coverWei;
        uint256 advancedWei;
        address[] watchers;
        uint256[] lockedAmt;
    }

    struct Advance {
        address beneficiary;
        address exitAddr;
        uint256 amountWei;
        uint256 feeWei;
        uint256 slashedWei;
        bytes32 batchKey;
        bytes32 salt;
        uint64 dueBy;
        uint8 state;
    }

    WatcherRegistry public immutable registry;

    mapping(bytes32 => Lane) public lanes;
    mapping(bytes32 => BatchRec) private _batches;
    mapping(bytes32 => mapping(bytes32 => address[])) private _votes;
    mapping(bytes32 => mapping(address => bytes32)) public voteOf;
    mapping(bytes32 => mapping(address => uint256)) public slashedOn;
    mapping(bytes32 => Advance) public advances;
    mapping(address => bytes32) public advanceOfExit;

    uint256 public totalShares;
    mapping(address => uint256) public shares;
    uint256 public outstandingWei;
    uint256 public watcherCreditsTotal;
    mapping(address => uint256) public watcherCredit;
    uint256 private _entered;

    error LaneDisabled();
    error NotWatcher();
    error AlreadyVoted();
    error NotConfirmed();
    error BatchContested();
    error WrongFacts();
    error TooLate();
    error ExitUsed();
    error AlreadyPaid();
    error BadProof();
    error AlreadyAdvanced();
    error CoverExceeded();
    error NoLiquidity();
    error BadState();
    error NotDue();
    error Funded();
    error NotFunded();
    error StillOpen();
    error BadLane();
    error ZeroAmount();
    error TransferFailed();
    error Reentrancy();

    event LaneSet(bytes32 indexed rollupKey, Lane lane);
    event Attested(bytes32 indexed rollupKey, uint64 indexed batchIndex, address indexed watcher, bytes32 factsHash);
    event BatchConfirmed(bytes32 indexed rollupKey, uint64 indexed batchIndex, bytes32 factsHash, uint256 coverWei);
    event BatchContestedEvt(bytes32 indexed rollupKey, uint64 indexed batchIndex, address watcher, bytes32 factsHash);
    event InstantExit(bytes32 indexed id, bytes32 indexed batchKey, address indexed beneficiary, address exitAddr, uint256 amountWei, uint256 feeWei, uint64 dueBy);
    event Settled(bytes32 indexed id, uint256 receivedWei);
    event Defaulted(bytes32 indexed id, uint256 slashedWei);
    event Recovered(bytes32 indexed id, uint256 receivedWei);
    event Released(bytes32 indexed batchKey);
    event SweptToBeneficiary(address indexed exitAddr, address indexed beneficiary, uint256 amount);
    event Deposited(address indexed provider, uint256 amount, uint256 shares);
    event Withdrawn(address indexed provider, uint256 amount, uint256 shares);

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address a, address b, WatcherRegistry registry_) DualAdmin(a, b) {
        registry = registry_;
    }

    /// @notice Slashed stake and swept repayments arrive here.
    receive() external payable {}

    // =================================================================== keys and bytes

    function rollupKeyOf(string calldata rollupId) external pure returns (bytes32) {
        return keccak256(bytes(rollupId));
    }

    function batchKey(bytes32 rollupKey, uint64 batchIndex) public pure returns (bytes32) {
        return keccak256(abi.encode(rollupKey, batchIndex));
    }

    /// @notice The 256 bytes a watcher signs with its ML-DSA-87 key.
    function attestationMessage(bytes32 rollupKey, uint64 batchIndex, Facts calldata f)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(
            ATTEST_TYPEHASH, block.chainid, address(this), rollupKey, batchIndex, f.stateRoot, f.withdrawalsRoot, f.exitRoot
        );
    }

    /// @notice Leaf of the EVM-side exit tree (double hashed, sorted-pair tree).
    function exitLeaf(uint64 wIndex, address recipient, uint256 amountUqor) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(wIndex, recipient, amountUqor))));
    }

    /// @notice Where the chain must pay a withdrawal for `beneficiary` to be advanced.
    function exitAddressFor(address beneficiary, bytes32 salt) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff), address(this), _exitSalt(beneficiary, salt), keccak256(type(ExitAddress).creationCode)
            )
        );
        return address(uint160(uint256(h)));
    }

    function getBatch(bytes32 key)
        external
        view
        returns (
            bytes32 factsHash,
            uint64 confirmedAt,
            bool contested,
            bool released,
            uint32 openAdvances,
            uint256 coverWei,
            uint256 advancedWei,
            address[] memory watchers,
            uint256[] memory lockedAmt
        )
    {
        BatchRec storage b = _batches[key];
        return (
            b.factsHash, b.confirmedAt, b.contested, b.released, b.openAdvances, b.coverWei, b.advancedWei, b.watchers, b.lockedAmt
        );
    }

    function votesFor(bytes32 key, bytes32 factsHash) external view returns (address[] memory) {
        return _votes[key][factsHash];
    }

    // =================================================================== attestations

    function attest(bytes32 rollupKey, uint64 batchIndex, Facts calldata f, bytes calldata sig) external {
        Lane memory lane = lanes[rollupKey];
        if (!lane.enabled) revert LaneDisabled();
        if (!registry.isActive(msg.sender)) revert NotWatcher();
        bytes32 key = batchKey(rollupKey, batchIndex);
        if (voteOf[key][msg.sender] != bytes32(0)) revert AlreadyVoted();
        _rollupOfBatch[key] = rollupKey;
        PQGuard.requireSigned(msg.sender, attestationMessage(rollupKey, batchIndex, f), sig);

        bytes32 fh = keccak256(abi.encode(f));
        voteOf[key][msg.sender] = fh;
        BatchRec storage b = _batches[key];
        if (b.firstFacts == bytes32(0)) {
            b.firstFacts = fh;
        } else if (b.firstFacts != fh && !b.contested) {
            b.contested = true;
            emit BatchContestedEvt(rollupKey, batchIndex, msg.sender, fh);
        }
        address[] storage v = _votes[key][fh];
        v.push(msg.sender);
        emit Attested(rollupKey, batchIndex, msg.sender, fh);

        if (b.confirmedAt == 0 && !b.contested && v.length >= lane.quorum) {
            _confirm(b, v, fh);
            emit BatchConfirmed(rollupKey, batchIndex, fh, b.coverWei);
        }
    }

    /// @dev v2: confirming records who stands behind the batch but locks nothing yet. Stake is
    /// locked only when an exit is advanced against the batch (see _lockCover), so watchers can
    /// confirm every batch they verify without tying up stake behind batches nobody exits from.
    function _confirm(BatchRec storage b, address[] storage v, bytes32 fh) private {
        b.factsHash = fh;
        b.confirmedAt = uint64(block.timestamp);
        for (uint256 i = 0; i < v.length; i++) {
            b.watchers.push(v[i]);
            b.lockedAmt.push(0);
        }
    }

    /// @dev Lock confirming watchers' stake so that cover >= everything advanced against the batch,
    /// at most `lockPerWatcher` from each, spread evenly first. Reverts CoverExceeded if they cannot.
    function _lockCover(BatchRec storage b, Lane memory lane, uint256 amountWei) private {
        uint256 have = b.coverWei - b.advancedWei;
        if (have >= amountWei) return;
        uint256 need = amountWei - have;
        uint256 n = b.watchers.length;
        uint256 per = (need + n - 1) / n;
        uint256 got;
        for (uint256 pass = 0; pass < 2 && got < need; pass++) {
            for (uint256 i = 0; i < n && got < need; i++) {
                address w = b.watchers[i];
                uint256 room = lane.lockPerWatcher - b.lockedAmt[i];
                uint256 free = registry.freeStake(w);
                uint256 want = pass == 0 ? per : need - got;
                uint256 take = want < room ? want : room;
                if (free < take) take = free;
                if (take > 0) {
                    registry.lock(w, take);
                    b.lockedAmt[i] += take;
                    got += take;
                }
            }
        }
        if (got < need) revert CoverExceeded();
        b.coverWei += got;
    }

    // =================================================================== exits

    function instantExit(
        bytes32 rollupKey,
        uint64 batchIndex,
        Facts calldata f,
        uint64 wIndex,
        address beneficiary,
        bytes32 salt,
        uint256 amountUqor,
        bytes32[] calldata proof
    ) external nonReentrant returns (bytes32 id) {
        if (amountUqor == 0) revert ZeroAmount();
        bytes32 key = batchKey(rollupKey, batchIndex);
        BatchRec storage b = _batches[key];
        if (b.confirmedAt == 0) revert NotConfirmed();
        if (b.contested) revert BatchContested();
        if (keccak256(abi.encode(f)) != b.factsHash) revert WrongFacts();
        Lane memory lane = lanes[rollupKey];
        if (block.timestamp > uint256(b.confirmedAt) + lane.windowSecs) revert TooLate();

        address exitAddr = exitAddressFor(beneficiary, salt);
        if (advanceOfExit[exitAddr] != bytes32(0)) revert ExitUsed();
        // Funds or code at the exit address mean the withdrawal was already paid (and maybe swept):
        // advancing it again would pay the same withdrawal twice.
        // (Dust sent there by a griefer does not block the exit; any surplus is forwarded on settle.)
        if (exitAddr.balance >= amountUqor * UQOR || exitAddr.code.length != 0) revert AlreadyPaid();
        if (!_verify(proof, f.exitRoot, exitLeaf(wIndex, exitAddr, amountUqor))) revert BadProof();

        id = keccak256(abi.encode(key, wIndex));
        if (advances[id].state != 0) revert AlreadyAdvanced();
        uint256 amountWei = amountUqor * UQOR;
        _lockCover(b, lane, amountWei);
        uint256 fee = (amountWei * lane.feeBps) / BPS;
        uint256 payout = amountWei - fee;
        if (payout > idleLiquidity()) revert NoLiquidity();

        uint64 dueBy = b.confirmedAt + lane.windowSecs + lane.graceSecs;
        advances[id] = Advance(beneficiary, exitAddr, amountWei, fee, 0, key, salt, dueBy, OPEN);
        advanceOfExit[exitAddr] = id;
        b.advancedWei += amountWei;
        b.openAdvances += 1;
        outstandingWei += amountWei;

        _send(beneficiary, payout);
        emit InstantExit(id, key, beneficiary, exitAddr, amountWei, fee, dueBy);
    }

    /// @notice Collect a repaid advance from its exit address. Anyone may call.
    function settle(bytes32 id) external nonReentrant {
        Advance storage a = advances[id];
        if (a.state != OPEN && a.state != DEFAULTED) revert BadState();
        if (a.exitAddr.balance < a.amountWei) revert NotFunded();
        uint256 got = _sweep(a.beneficiary, a.salt, a.exitAddr, payable(address(this)));
        uint256 surplus = got - a.amountWei;
        BatchRec storage b = _batches[a.batchKey];

        if (a.state == OPEN) {
            a.state = SETTLED;
            outstandingWei -= a.amountWei;
            b.advancedWei -= a.amountWei;
            b.openAdvances -= 1;
            _creditWatchers(b, (a.feeWei * WATCHER_FEE_SHARE_BPS) / BPS);
            emit Settled(id, got);
        } else {
            // Repaid after it was written off: give the slashed stake back to the watchers.
            a.state = RECOVERED;
            for (uint256 i = 0; i < b.watchers.length; i++) {
                address w = b.watchers[i];
                uint256 back = _share(a.slashedWei, b.lockedAmt[i], b.coverWei);
                if (back > 0) {
                    watcherCredit[w] += back;
                    watcherCreditsTotal += back;
                }
            }
            emit Recovered(id, got);
        }
        if (surplus > 0) _send(a.beneficiary, surplus);
    }

    /// @notice Write off an advance whose exit address was not paid in time, from the
    /// confirming watchers' locked stake. Anyone may call.
    function markDefault(bytes32 id) external nonReentrant {
        Advance storage a = advances[id];
        if (a.state != OPEN) revert BadState();
        if (block.timestamp <= a.dueBy) revert NotDue();
        if (a.exitAddr.balance >= a.amountWei) revert Funded();
        BatchRec storage b = _batches[a.batchKey];
        a.state = DEFAULTED;
        outstandingWei -= a.amountWei;
        b.advancedWei -= a.amountWei;
        b.openAdvances -= 1;

        uint256 total;
        for (uint256 i = 0; i < b.watchers.length; i++) {
            address w = b.watchers[i];
            uint256 part = _share(a.amountWei, b.lockedAmt[i], b.coverWei);
            uint256 left = b.lockedAmt[i] - slashedOn[a.batchKey][w];
            if (part > left) part = left;
            if (part > 0) {
                slashedOn[a.batchKey][w] += part;
                registry.slash(w, part, address(this));
                total += part;
            }
        }
        a.slashedWei = total;
        emit Defaulted(id, total);
    }

    /// @notice Unlock the watchers' remaining stake once a batch can take no more advances.
    function release(bytes32 key) external {
        BatchRec storage b = _batches[key];
        if (b.confirmedAt == 0 || b.released) revert BadState();
        Lane memory lane = _laneOfBatch(key);
        if (block.timestamp <= uint256(b.confirmedAt) + lane.windowSecs + lane.graceSecs) revert NotDue();
        if (b.openAdvances != 0) revert StillOpen();
        b.released = true;
        for (uint256 i = 0; i < b.watchers.length; i++) {
            uint256 rest = b.lockedAmt[i] - slashedOn[key][b.watchers[i]];
            if (rest > 0) registry.unlock(b.watchers[i], rest);
        }
        emit Released(key);
    }

    /// @notice A withdrawal that was never advanced goes straight to its beneficiary.
    function sweepToBeneficiary(address beneficiary, bytes32 salt) external nonReentrant {
        address exitAddr = exitAddressFor(beneficiary, salt);
        bytes32 id = advanceOfExit[exitAddr];
        if (id != bytes32(0)) {
            uint8 s = advances[id].state;
            if (s != SETTLED && s != RECOVERED) revert StillOpen();
        }
        uint256 got = _sweep(beneficiary, salt, exitAddr, payable(beneficiary));
        emit SweptToBeneficiary(exitAddr, beneficiary, got);
    }

    // =================================================================== liquidity

    /// @notice Pool assets: cash plus advances still to be repaid, minus what watchers are owed.
    function totalAssets() public view returns (uint256) {
        return address(this).balance + outstandingWei - watcherCreditsTotal;
    }

    function idleLiquidity() public view returns (uint256) {
        return address(this).balance - watcherCreditsTotal;
    }

    /// @dev Virtual shares and assets (as in OpenZeppelin's ERC-4626) make a first-depositor
    /// share-inflation attack cost more than it can take.
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    function deposit() external payable nonReentrant returns (uint256 minted) {
        if (msg.value == 0) revert ZeroAmount();
        uint256 before = totalAssets() - msg.value;
        minted = (msg.value * (totalShares + VIRTUAL_SHARES)) / (before + VIRTUAL_ASSETS);
        shares[msg.sender] += minted;
        totalShares += minted;
        emit Deposited(msg.sender, msg.value, minted);
    }

    function withdraw(uint256 shareAmount) external nonReentrant returns (uint256 amount) {
        amount = (shareAmount * (totalAssets() + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
        if (amount > idleLiquidity()) revert NoLiquidity();
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        _send(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shareAmount);
    }

    function claimCredit() external nonReentrant {
        uint256 c = watcherCredit[msg.sender];
        watcherCredit[msg.sender] = 0;
        watcherCreditsTotal -= c;
        _send(msg.sender, c);
    }

    // =================================================================== admin

    function setLane(bytes32 rollupKey, Lane calldata lane, uint256 deadline, bytes calldata sigA, bytes calldata sigB)
        external
    {
        if (lane.quorum == 0 || lane.feeBps > 1000 || lane.windowSecs == 0) revert BadLane();
        _requireAdmins("setLane", abi.encode(rollupKey, lane), deadline, sigA, sigB);
        lanes[rollupKey] = lane;
        emit LaneSet(rollupKey, lane);
    }

    // =================================================================== internals

    mapping(bytes32 => bytes32) private _rollupOfBatch;

    function _laneOfBatch(bytes32 key) private view returns (Lane memory) {
        return lanes[_rollupOfBatch[key]];
    }

    function _exitSalt(address beneficiary, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(beneficiary, salt));
    }

    /// @dev Deploy the exit contract at its CREATE2 address if needed, then move its balance to `to`.
    function _sweep(address beneficiary, bytes32 salt, address exitAddr, address payable to) private returns (uint256) {
        if (exitAddr.code.length == 0) {
            address deployed = address(new ExitAddress{salt: _exitSalt(beneficiary, salt)}());
            if (deployed != exitAddr) revert BadState();
        }
        return ExitAddress(payable(exitAddr)).sweep(to);
    }

    function _creditWatchers(BatchRec storage b, uint256 amount) private {
        uint256 n = b.watchers.length;
        if (n == 0 || amount == 0) return;
        uint256 each = amount / n;
        for (uint256 i = 0; i < n; i++) {
            watcherCredit[b.watchers[i]] += each;
        }
        watcherCreditsTotal += each * n;
    }

    function _share(uint256 amount, uint256 part, uint256 whole) private pure returns (uint256) {
        return whole == 0 ? 0 : (amount * part) / whole;
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) private pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
