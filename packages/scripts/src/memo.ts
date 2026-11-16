// Private payment notes (ML-KEM-1024, QoreSeal):
//  1. W1 registers its ML-KEM-1024 key in the chain's KEM registry and signs a recipient card
//     (QoreSign: classical + ML-DSA-87) that binds its X25519 key to the on-chain key.
//  2. ADMIN_A pays W1's ledger account on the rollup and seals a note to W1 in the browser-style
//     flow: hybrid ML-KEM-1024 + X25519, bound to the chain, the purpose and the ledger tx.
//  3. The envelope goes on chain through MemoBoard; W1 opens it, W2 cannot.
// Usage: pnpm memo [rollup-id] ["note text"]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deriveSealKeys, open, signRecipientCard, isQoreSealError } from "@qorechain/qoreseal";
import { fetchKemKey, sealToAddresses } from "@qorechain/qoreseal/network";
import { postRollupDataMsg, signQledgerTx, encodeQledgerTx, bytesToHex } from "@qorechain/rdk";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { account, ledgerKey, NET, STATE_DIR, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const ROLLUP = process.argv[2] ?? "wicketgate-pay";
const NOTE = process.argv[3] ?? "Invoice #0042: November hosting. Thanks!";
const PURPOSE = `wicketgate-memo:${ROLLUP}`;
const NONCES = join(STATE_DIR, "ledger-nonces.json");
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

async function main() {
  const A = await account("ADMIN_A");
  const W1 = await account("W1");
  const W2 = await account("W2");
  const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
  const memoBoard = dep.memoBoard as Address;

  // 1. recipient keys, registry and card
  const keys = deriveSealKeys({ mnemonic: W1.mnemonic! });
  const kem = await fetchKemKey({ rest: NET.rest, address: W1.cosmos });
  if (!kem.registered) {
    // the SDK registry encodes MsgRegisterKEMKey from an object (QoreSeal's builder returns bytes)
    const r = await sendNative(W1, [{ typeUrl: "/qorechain.pqc.v1.MsgRegisterKEMKey", value: { sender: W1.cosmos, algorithmId: 2, publicKey: keys.mlkemPublicKey } }], { gas: 600_000 });
    console.log(`W1 registered its ML-KEM-1024 key: ${explorerTx(r.transactionHash)}`);
  } else {
    console.log(`W1's ML-KEM-1024 key is already registered (height ${kem.registeredHeight})`);
  }
  const card = signRecipientCard({
    chainId: NET.chainId, address: W1.cosmos, keys,
    classicalKey: { type: "eth_secp256k1", privateKey: hexBytes(W1.privateKey), publicKey: hexBytes(W1.publicKey) },
    pqKey: { secretKey: W1.pqc.secretKey },
  });
  const cardsDir = new URL("../../../cards/", import.meta.url);
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(new URL("W1.json", cardsDir), JSON.stringify(card, null, 2) + "\n");
  console.log(`W1's signed recipient card written to cards/W1.json (public)`);

  // 2. a ledger payment to W1, and a sealed note bound to it
  const la = await ledgerKey("ADMIN_A"), lb = await ledgerKey("W1");
  const nonces = existsSync(NONCES) ? JSON.parse(readFileSync(NONCES, "utf8")) : {};
  const nk = `${ROLLUP}:${bytesToHex(la.accountId)}`;
  const nonce = BigInt(nonces[nk] ?? 0);
  const tx = encodeQledgerTx(signQledgerTx({ chainId: NET.chainId, rollupId: ROLLUP, secretKey: la.secretKey, publicKey: la.publicKey, nonce, amount: 200_000n, to: lb.accountId }));
  const p = await sendNative(A, [postRollupDataMsg({ poster: A.cosmos, rollupId: ROLLUP, data: tx })], { gas: 700_000 });
  nonces[nk] = (nonce + 1n).toString();
  writeFileSync(NONCES, JSON.stringify(nonces, null, 2));
  const ledgerTxHash = `0x${createHash("sha256").update(tx).digest("hex")}` as Hex;
  console.log(`paid W1 0.2 QOR on ${ROLLUP}: ${explorerTx(p.transactionHash)} (ledger tx ${ledgerTxHash.slice(0, 18)}…)`);

  const envelope = await sealToAddresses({
    rest: NET.rest, chainId: NET.chainId, purpose: PURPOSE,
    recipients: [{ address: W1.cosmos, card }],
    plaintext: new TextEncoder().encode(NOTE),
    aad: hexBytes(ledgerTxHash),
  });
  console.log(`sealed a ${envelope.length}-byte hybrid envelope (ML-KEM-1024 + X25519) to W1`);

  // 3. on chain through MemoBoard
  const { abi } = artifact("MemoBoard");
  const rollupKey = keccak256(toHex(ROLLUP));
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 1_500_000n), allowedTargets: [memoBoard] });
  let hash: Hex;
  try {
    hash = await walletFor(A).writeContract({ address: memoBoard, abi, functionName: "post", args: [rollupKey, toHex(lb.accountId), ledgerTxHash, toHex(envelope)] } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`MemoBoard.post: ${rc.status} ${hash} (gas ${rc.gasUsed})`);
  } finally {
    await closeWindow(A);
  }

  // read it back from the event log and open it
  const rc = await publicClient.getTransactionReceipt({ hash });
  const { decodeEventLog } = await import("viem");
  const log = rc.logs.find((l) => l.address.toLowerCase() === memoBoard.toLowerCase())!;
  const ev: any = decodeEventLog({ abi, data: log.data, topics: log.topics });
  const onChain = hexBytes(ev.args.envelope);
  const text = new TextDecoder().decode(open({ chainId: NET.chainId, purpose: PURPOSE, envelope: onChain, keys, aad: hexBytes(ev.args.ledgerTxHash) }));
  console.log(`W1 opened the note from the event log: "${text}" -> ${text === NOTE ? "PASS" : "FAIL"}`);
  try {
    open({ chainId: NET.chainId, purpose: PURPOSE, envelope: onChain, keys: deriveSealKeys({ mnemonic: W2.mnemonic! }), aad: hexBytes(ev.args.ledgerTxHash) });
    console.log("W2 opened it too -> FAIL");
  } catch (e) {
    console.log(`W2 cannot open it: ${isQoreSealError(e) ? (e as any).code : (e as Error).message} -> PASS`);
  }
  try {
    open({ chainId: NET.chainId, purpose: "other-purpose", envelope: onChain, keys, aad: hexBytes(ev.args.ledgerTxHash) });
    console.log("opened under another purpose -> FAIL");
  } catch (e) {
    console.log(`the same envelope does not open under another purpose: ${isQoreSealError(e) ? (e as any).code : "error"} -> PASS`);
  }
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
