// Sealed vulnerability reports. A reporter seals the report to the Wicketgate security key
// (ADMIN_A's ML-KEM-1024 key, registered on chain, with its signed recipient card in
// cards/security.json) and pastes the printed `qoreseal:` text into a public GitHub issue.
// Only the team can open it.
//   Reporter:  npx tsx src/disclose.ts "what you found"          (no key needed)
//   Team:      npx tsx src/disclose.ts --open "qoreseal:..."     (needs the team's key file)
//   Team, once: npx tsx src/disclose.ts --setup                   (register the key, write the card)
import { readFileSync, writeFileSync } from "node:fs";
import { deriveSealKeys, open, signRecipientCard, envelopeToText, envelopeFromText } from "@qorechain/qoreseal";
import { fetchKemKey, sealToAddresses } from "@qorechain/qoreseal/network";
import { NET } from "@wicketgate/core/env";

const SECURITY = "qor16087dpc985wvk6hlsl2x8p0kyumz394q0lvm6k"; // ADMIN_A
const PURPOSE = "wicketgate-security-report";
const CARD = new URL("../../../cards/security.json", import.meta.url);
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

async function teamKeys() {
  const { account } = await import("@wicketgate/core/env");
  const A = await account("ADMIN_A");
  return { A, keys: deriveSealKeys({ mnemonic: A.mnemonic!, index: 1 }) }; // index 1: separate from note keys
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--setup") {
    const { sendNative, explorerTx } = await import("@wicketgate/core/chain");
    const { A, keys } = await teamKeys();
    const kem = await fetchKemKey({ rest: NET.rest, address: A.cosmos });
    if (!kem.registered || Buffer.compare(Buffer.from(kem.publicKey!), Buffer.from(keys.mlkemPublicKey)) !== 0) {
      const r = await sendNative(A, [{ typeUrl: "/qorechain.pqc.v1.MsgRegisterKEMKey", value: { sender: A.cosmos, algorithmId: 2, publicKey: keys.mlkemPublicKey } }], { gas: 600_000 });
      console.log(`security ML-KEM-1024 key registered: ${explorerTx(r.transactionHash)}`);
    }
    const card = signRecipientCard({
      chainId: NET.chainId, address: A.cosmos, keys,
      classicalKey: { type: "eth_secp256k1", privateKey: hexBytes(A.privateKey), publicKey: hexBytes(A.publicKey) },
      pqKey: { secretKey: A.pqc.secretKey },
    });
    writeFileSync(CARD, JSON.stringify(card, null, 2) + "\n");
    console.log("wrote cards/security.json");
    return;
  }
  if (args[0] === "--open") {
    const { keys } = await teamKeys();
    console.log(new TextDecoder().decode(open({ chainId: NET.chainId, purpose: PURPOSE, envelope: envelopeFromText(args[1]), keys })));
    return;
  }
  const report = args.join(" ");
  if (!report) throw new Error('usage: npx tsx src/disclose.ts "what you found"');
  const card = JSON.parse(readFileSync(CARD, "utf8"));
  const env = await sealToAddresses({ rest: NET.rest, chainId: NET.chainId, purpose: PURPOSE, recipients: [{ address: SECURITY, card }], plaintext: new TextEncoder().encode(report) });
  console.log("Paste this into a GitHub issue titled \"Sealed security report\". Only the Wicketgate team can read it:\n");
  console.log(envelopeToText(env));
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
