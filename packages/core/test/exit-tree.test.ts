import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Hex } from "viem";
import { hexToBech32 } from "@qorechain/rdk";
import { buildExitTree, exitLeaf, verifyExitProof, ZERO_ROOT, recipientAddress } from "../src/exit-tree.ts";
import exitPoolAbi from "../abi/ExitPool.json" with { type: "json" };

const addr = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const w = (i: number, amount = 1_000_000n) => ({ index: BigInt(i), recipient: hexToBech32(addr(i + 1), "qor"), amount });

describe("exit tree", () => {
  it("is empty for no withdrawals", () => {
    expect(buildExitTree([]).root).toBe(ZERO_ROOT);
  });

  it("uses the leaf itself as the root of a one-leaf tree", () => {
    const t = buildExitTree([w(0)]);
    expect(t.root).toBe(t.entries[0].leaf);
    expect(t.entries[0].proof).toEqual([]);
  });

  for (const n of [2, 3, 4, 5, 7, 8, 13, 64]) {
    it(`gives a valid proof for every leaf of a ${n}-leaf tree`, () => {
      const t = buildExitTree(Array.from({ length: n }, (_, i) => w(i, BigInt(i + 1) * 1000n)));
      for (const e of t.entries) expect(verifyExitProof(e.proof, t.root, e.leaf)).toBe(true);
      // a proof for one leaf does not prove another
      if (n > 1) expect(verifyExitProof(t.entries[0].proof, t.root, t.entries[1].leaf)).toBe(false);
    });
  }

  it("orders by withdrawal index whatever the input order", () => {
    const a = buildExitTree([w(2), w(0), w(1)]);
    const b = buildExitTree([w(0), w(1), w(2)]);
    expect(a.root).toBe(b.root);
  });

  it("skips recipients that are not 20-byte accounts", () => {
    const longAddr = hexToBech32(`0x${"ab".repeat(32)}`, "qor");
    expect(recipientAddress(longAddr)).toBeUndefined();
    const t = buildExitTree([w(0), { index: 1n, recipient: longAddr, amount: 5n }]);
    expect(t.entries.length).toBe(1);
    expect(t.skipped.length).toBe(1);
  });
});

describe("matches the deployed ExitPool (live testnet)", () => {
  const pool = "0x57a782645b97a1135a806f6190fae4428a414328";
  const client = createPublicClient({ transport: http("https://evm-testnet.qore.host") });
  it("computes the same leaf as ExitPool.exitLeaf", async () => {
    const recipient = addr(0xbeef);
    const onChain = await client.readContract({
      address: pool, abi: exitPoolAbi as any, functionName: "exitLeaf", args: [7n, recipient, 2_000_000n],
    });
    expect(onChain).toBe(exitLeaf(7n, recipient, 2_000_000n));
  }, 30_000);
});
