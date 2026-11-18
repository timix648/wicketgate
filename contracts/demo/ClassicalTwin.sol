// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title ClassicalTwin - DEMO ONLY, deliberately vulnerable after Q-Day. Not part of Wicketgate.
/// @notice The instant-exit design most bridges and fast-withdrawal pools use today: watchers sign
/// what they verified with their secp256k1 key, the contract checks it with `ecrecover`, and anyone
/// may submit a signed attestation. It mirrors ExitPool's attestation message, exit leaf and exit
/// tree, so the only difference that matters is the signature scheme. Once a watcher's classical key
/// is broken (by a quantum computer, or here by a deliberately weak key), whoever holds it can
/// confirm an invented batch and drain the pool. It lives outside `contracts/src` so the CBOM check
/// on Wicketgate's own contracts (no classical signature checks) still holds.
contract ClassicalTwin {
    struct Facts {
        bytes32 stateRoot;
        bytes32 withdrawalsRoot;
        bytes32 exitRoot;
    }

    bytes32 public constant ATTEST_TYPEHASH = keccak256("WicketgateAttestation(v1)");
    mapping(address => bool) public isWatcher;
    mapping(bytes32 => bytes32) public confirmedFacts; // batch key => facts hash
    mapping(bytes32 => bool) public exitPaid;

    event Attested(bytes32 indexed key, address indexed watcher, bytes32 factsHash);
    event InstantExit(bytes32 indexed key, address indexed beneficiary, uint256 amount);

    error NotWatcher();
    error NotConfirmed();
    error WrongFacts();
    error BadProof();
    error Paid();

    constructor(address[] memory watchers) payable {
        for (uint256 i = 0; i < watchers.length; i++) isWatcher[watchers[i]] = true;
    }

    receive() external payable {}

    function batchKey(bytes32 rollupKey, uint64 batchIndex) public pure returns (bytes32) {
        return keccak256(abi.encode(rollupKey, batchIndex));
    }

    function digest(bytes32 rollupKey, uint64 batchIndex, Facts calldata f) public view returns (bytes32) {
        bytes32 h = keccak256(
            abi.encode(ATTEST_TYPEHASH, block.chainid, address(this), rollupKey, batchIndex, f.stateRoot, f.withdrawalsRoot, f.exitRoot)
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    /// @notice Anyone may submit a watcher's signed attestation (quorum of one, as in many bridges).
    function attest(bytes32 rollupKey, uint64 batchIndex, Facts calldata f, uint8 v, bytes32 r, bytes32 s) external {
        address signer = ecrecover(digest(rollupKey, batchIndex, f), v, r, s);
        if (signer == address(0) || !isWatcher[signer]) revert NotWatcher();
        bytes32 fh = keccak256(abi.encode(f));
        confirmedFacts[batchKey(rollupKey, batchIndex)] = fh;
        emit Attested(batchKey(rollupKey, batchIndex), signer, fh);
    }

    function exitLeaf(uint64 wIndex, address recipient, uint256 amountWei) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(wIndex, recipient, amountWei))));
    }

    function instantExit(bytes32 rollupKey, uint64 batchIndex, Facts calldata f, uint64 wIndex, address payable to, uint256 amountWei, bytes32[] calldata proof)
        external
    {
        bytes32 key = batchKey(rollupKey, batchIndex);
        if (confirmedFacts[key] == bytes32(0)) revert NotConfirmed();
        if (keccak256(abi.encode(f)) != confirmedFacts[key]) revert WrongFacts();
        bytes32 node = exitLeaf(wIndex, to, amountWei);
        for (uint256 i = 0; i < proof.length; i++) {
            node = node < proof[i] ? keccak256(abi.encode(node, proof[i])) : keccak256(abi.encode(proof[i], node));
        }
        if (node != f.exitRoot) revert BadProof();
        bytes32 id = keccak256(abi.encode(key, wIndex));
        if (exitPaid[id]) revert Paid();
        exitPaid[id] = true;
        (bool ok,) = to.call{value: amountWei}("");
        require(ok);
        emit InstantExit(key, to, amountWei);
    }
}
