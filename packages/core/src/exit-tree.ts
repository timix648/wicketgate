// The exit tree: an EVM-friendly commitment to a batch's withdrawals, signed by
// watchers next to the chain's own roots. Leaves and hashing match ExitPool exactly:
//   leaf = keccak256(bytes.concat(keccak256(abi.encode(uint64 index, address recipient, uint256 amountUqor))))
//   node = keccak256(sorted(a, b))
// Leaves are kept in withdrawal-index order; at each level an odd last node moves up
// unchanged. A batch with no eligible withdrawal has exitRoot = 0x00..00.
import { bech32ToHex } from "@qorechain/rdk";
import { concat, encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";

export const ZERO_ROOT = `0x${"00".repeat(32)}` as Hex;

export interface ExitWithdrawal {
  index: bigint;
  recipient: string; // qor1 address as the ledger withdrawal names it
  amount: bigint; // uqor
}

/** The 20-byte EVM address of a qor1 recipient, or undefined if it is not a 20-byte account. */
export function recipientAddress(recipient: string): Address | undefined {
  try {
    const h = bech32ToHex(recipient).replace(/^0x/, "");
    return h.length === 40 ? getAddress(`0x${h}`) : undefined;
  } catch {
    return undefined;
  }
}

export function exitLeaf(index: bigint, recipient: Address, amountUqor: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "uint256" }], [index, recipient, amountUqor]),
  );
  return keccak256(inner);
}

export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface ExitTree {
  root: Hex;
  /** Eligible withdrawals in tree order, each with its leaf and proof. */
  entries: { withdrawal: ExitWithdrawal; recipientEvm: Address; leaf: Hex; proof: Hex[] }[];
  /** Withdrawals left out (recipient is not a 20-byte account): they can only exit the normal way. */
  skipped: ExitWithdrawal[];
}

export function buildExitTree(withdrawals: ExitWithdrawal[]): ExitTree {
  const sorted = [...withdrawals].sort((x, y) => (x.index < y.index ? -1 : x.index > y.index ? 1 : 0));
  const entries: ExitTree["entries"] = [];
  const skipped: ExitWithdrawal[] = [];
  for (const w of sorted) {
    const evm = recipientAddress(w.recipient);
    if (!evm) {
      skipped.push(w);
      continue;
    }
    entries.push({ withdrawal: w, recipientEvm: evm, leaf: exitLeaf(w.index, evm, w.amount), proof: [] });
  }
  if (entries.length === 0) return { root: ZERO_ROOT, entries, skipped };

  // levels[0] = leaves; position[i] tracks where entry i sits at each level
  let level: Hex[] = entries.map((e) => e.leaf);
  let pos = entries.map((_, i) => i);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    pos = pos.map((p, i) => {
      const sibling = p ^ 1;
      if (sibling < level.length) entries[i].proof.push(level[sibling]);
      return p >> 1;
    });
    level = next;
  }
  return { root: level[0], entries, skipped };
}

/** The same check ExitPool._verify makes. */
export function verifyExitProof(proof: Hex[], root: Hex, leaf: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
