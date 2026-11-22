// Live check of the sealed exit relay against the real chain: seal a request to the exit
// operator through the chain's KEM registry and the operator's signed card (exactly as the
// wallet does), then open it with the operator's key. Also shows a swapped key is refused.
//   npx tsx src/probe-sealexit.ts
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { deriveSealKeys, generateSealKeys } from "@qorechain/qoreseal";
import { NET, DEPLOYMENTS_FILE, account } from "@wicketgate/core/env";
import { EXIT_OPERATOR, openExitRequest, sealExitRequest, mlkemFingerprint } from "@wicketgate/core/sealed-exit";

const card = JSON.parse(readFileSync(new URL("../../../cards/security.json", import.meta.url), "utf8"));
const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as string;
const request = { rollupId: "wicketgate-pay", beneficiary: "0x000000000000000000000000000000000000dEaD", salt: `0x${randomBytes(32).toString("hex")}`, amountUqor: "1000000" };

const text = await sealExitRequest({ rest: NET.rest, chainId: NET.chainId, pool, card, request });
console.log(`sealed to ${EXIT_OPERATOR.address} (ML-KEM-1024 key sha3 ${EXIT_OPERATOR.mlkemKeySha3.slice(0, 16)}...): ${text.length} chars`);
console.log(`plaintext fields visible in envelope: ${[request.beneficiary.slice(2), request.salt.slice(2, 18)].filter((s) => text.toLowerCase().includes(s.toLowerCase())).length}`);

const A = await account("ADMIN_A");
const keys = deriveSealKeys({ mnemonic: A.mnemonic!, index: 1 });
const got = openExitRequest({ text, keys, chainId: NET.chainId, rollupId: request.rollupId, pool });
console.log(`operator opened it: ${JSON.stringify(got) === JSON.stringify({ ...request, salt: request.salt.toLowerCase() }) ? "MATCH" : "MISMATCH"}`);

// A relay that swaps in its own key: the chain answer is rewritten to the attacker's key.
const evil = generateSealKeys();
const swap = (async (u: string, i?: RequestInit) => {
  const r = await fetch(u, i);
  if (!u.includes("/pqc/v1/kem/")) return r;
  const j: any = await r.json();
  j.key.public_key = Buffer.from(evil.mlkemPublicKey).toString("base64");
  return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
try {
  await sealExitRequest({ rest: NET.rest, fetch: swap, chainId: NET.chainId, pool, card, request });
  console.log("swapped key: ACCEPTED (bad)");
  process.exitCode = 1;
} catch (e: any) {
  console.log(`swapped key (sha3 ${mlkemFingerprint(evil.mlkemPublicKey).slice(0, 16)}...): refused (${e.message})`);
}
