// Puts real activity into a qledger-v1 rollup's inbox from ADMIN_A: a deposit to its ledger
// account, a transfer to W1's ledger account, and a withdrawal to an ExitPool exit address.
// Once a bonded submitter batches these, the withdrawal can be exited instantly.
// Usage: pnpm seed [rollup-id]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { depositToRollupMsg, postRollupDataMsg, signQledgerTx, encodeQledgerTx, hexToBech32, bytesToHex, RestClient } from "@qorechain/rdk";
import { toHex, type Address, type Hex } from "viem";
import { account, ledgerKey, NET, STATE_DIR, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
import { artifact, publicClient } from "@wicketgate/core/evm";

const ROLLUP = process.argv[2] ?? "rdk-v328-e2e-mwd5v89d";
const EXITS = join(STATE_DIR, "exits.json");
const NONCES = join(STATE_DIR, "ledger-nonces.json");
const load = (f: string, d: any) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);

async function main() {
  const A = await account("ADMIN_A");
  const la = await ledgerKey("ADMIN_A");
  const lb = await ledgerKey("W1");
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
  const nonces = load(NONCES, {});
  const key = `${ROLLUP}:${bytesToHex(la.accountId)}`;
  let nonce = BigInt(nonces[key] ?? 0);
  console.log(`ledger account of ADMIN_A: ${bytesToHex(la.accountId)} (next nonce ${nonce})`);

  const dep = await sendNative(A, [depositToRollupMsg({ depositor: A.cosmos, rollupId: ROLLUP, account: la.accountId, amount: "3000000" })], { gas: 500_000 });
  console.log(`deposit 3 QOR: ${explorerTx(dep.transactionHash)}`);

  const transfer = signQledgerTx({ chainId: NET.chainId, rollupId: ROLLUP, secretKey: la.secretKey, publicKey: la.publicKey, nonce, amount: 500_000n, to: lb.accountId });
  const t = await sendNative(A, [postRollupDataMsg({ poster: A.cosmos, rollupId: ROLLUP, data: encodeQledgerTx(transfer) })], { gas: 700_000 });
  console.log(`transfer 0.5 QOR to W1's ledger account (nonce ${nonce}): ${explorerTx(t.transactionHash)}`);
  nonce++;

  const salt = toHex(randomBytes(32)) as Hex;
  const exitAddr = (await publicClient.readContract({ address: pool, abi: artifact("ExitPool").abi, functionName: "exitAddressFor", args: [A.evm, salt] })) as Address;
  const recipient = hexToBech32(exitAddr, "qor");
  const wd = signQledgerTx({ chainId: NET.chainId, rollupId: ROLLUP, secretKey: la.secretKey, publicKey: la.publicKey, nonce, amount: 1_000_000n, recipient });
  const w = await sendNative(A, [postRollupDataMsg({ poster: A.cosmos, rollupId: ROLLUP, data: encodeQledgerTx(wd) })], { gas: 700_000 });
  console.log(`withdraw 1 QOR to exit address ${exitAddr} (${recipient}) (nonce ${nonce}): ${explorerTx(w.transactionHash)}`);
  nonce++;

  nonces[key] = nonce.toString();
  writeFileSync(NONCES, JSON.stringify(nonces, null, 2));
  const exits = load(EXITS, []);
  exits.push({ rollupId: ROLLUP, beneficiary: A.evm, salt, exitAddr, recipient, amountUqor: "1000000", postTx: w.transactionHash, createdAt: new Date().toISOString() });
  writeFileSync(EXITS, JSON.stringify(exits, null, 2));
  const inbox = await new RestClient(NET.rest).getInbox(ROLLUP);
  console.log(`inbox now ${inbox.consumedSequence}/${inbox.headSequence}; exit saved to ${EXITS}`);
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
