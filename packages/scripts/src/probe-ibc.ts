// Probe: send a small IBC transfer from ADMIN_A to its own address on a counterparty chain
// (same secp256k1 key, cosmos-style address), then watch for the acknowledgement.
// Usage: pnpm probe:ibc [channel] [prefix] [uqor]
import { createHash } from "node:crypto";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { hexToBech32 } from "@qorechain/rdk";
import { account, NET } from "@wicketgate/core/env";
import { sendNative, explorerTx, restGet } from "@wicketgate/core/chain";

const CHANNEL = process.argv[2] ?? "channel-1";
const PREFIX = process.argv[3] ?? "osmo";
const AMOUNT = process.argv[4] ?? "100000";

export function counterpartyAddress(compressedPubHex: string, prefix: string) {
  const pub = Buffer.from(compressedPubHex.replace(/^0x/, ""), "hex");
  const h = ripemd160(createHash("sha256").update(pub).digest());
  return hexToBech32(`0x${Buffer.from(h).toString("hex")}`, prefix);
}

async function main() {
  const A = await account("ADMIN_A");
  const receiver = counterpartyAddress(A.publicKey, PREFIX);
  const timeoutNs = BigInt(Date.now() + 15 * 60_000) * 1_000_000n;
  const r = await sendNative(A, [{
    typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
    value: {
      sourcePort: "transfer", sourceChannel: CHANNEL,
      token: { denom: "uqor", amount: AMOUNT }, sender: A.cosmos, receiver,
      timeoutHeight: { revisionNumber: 0n, revisionHeight: 0n }, timeoutTimestamp: timeoutNs, memo: "wicketgate ibc probe",
    },
  }], { gas: 400_000 });
  console.log(`IBC transfer of ${AMOUNT} uqor over ${CHANNEL} to ${receiver}: ${explorerTx(r.transactionHash)}`);
  const { body } = await restGet<any>(`/cosmos/tx/v1beta1/txs/${r.transactionHash}`);
  const seq = body?.tx_response?.events?.find((e: any) => e.type === "send_packet")?.attributes?.find((a: any) => a.key === "packet_sequence")?.value;
  console.log(`packet sequence ${seq}; waiting for the relayer to deliver and acknowledge it...`);
  for (let i = 0; i < 60; i++) {
    const c = await restGet<any>(`/ibc/core/channel/v1/channels/${CHANNEL}/ports/transfer/packet_commitments/${seq}`);
    if (c.status === 404 || !c.body?.commitment) {
      console.log(`ACKNOWLEDGED after about ${i * 10} s: the packet commitment is cleared, so ${receiver} was credited (or the transfer refunded on error)`);
      return;
    }
    await new Promise((res) => setTimeout(res, 10_000));
  }
  console.log("not acknowledged within 10 minutes: the relayer may be down (the transfer times out and refunds after 15 minutes)");
}
if (process.argv[1]?.endsWith("probe-ibc.ts")) main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
