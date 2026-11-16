// Probe 5: check the testnet's ML-DSA-87 verify precompile (0x0A01) with an
// ephemeral in-memory key, using eth_call only. Read-only: no key is stored,
// nothing is signed on chain, no funds are needed.
import { randomBytes } from "node:crypto";
import { mldsa87 } from "@qorechain/pqc";
import { createPublicClient, http, encodeAbiParameters, keccak256, toHex, parseAbi, encodeFunctionData } from "viem";

const EVM = process.env.QORE_EVM ?? "https://evm-testnet.qore.host";
const client = createPublicClient({ transport: http(EVM) });
const PQC = parseAbi([
  "function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)",
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);
const VERIFY = "0x0000000000000000000000000000000000000a01" as const;
const STATUS = "0x0000000000000000000000000000000000000a02" as const;

async function main() {
  const kp = mldsa87.keygen(randomBytes(32));
  // a message shaped like a Wicketgate attestation (256 bytes)
  const message = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [keccak256(toHex("Wicketgate.Attestation.v1")), 9800n, "0x0000000000000000000000000000000000000001", keccak256(toHex("rdk-v328-e2e-mwd5v89d")), 0n,
     `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, `0x${"33".repeat(32)}`],
  );
  const msg = Uint8Array.from(Buffer.from(message.slice(2), "hex"));
  const sig = mldsa87.sign(kp.secretKey, msg);
  console.log(`pubkey ${kp.publicKey.length} bytes, signature ${sig.length} bytes, message ${msg.length} bytes, local verify ${mldsa87.verify(kp.publicKey, msg, sig)}`);

  const call = async (m: Uint8Array) =>
    client.readContract({ address: VERIFY, abi: PQC, functionName: "pqcVerify", args: [toHex(kp.publicKey), toHex(sig), toHex(m)] });
  const good = await call(msg);
  const bad = Uint8Array.from(msg); bad[100] ^= 1;
  const tampered = await call(bad);
  const data = encodeFunctionData({ abi: PQC, functionName: "pqcVerify", args: [toHex(kp.publicKey), toHex(sig), toHex(msg)] });
  const gas = await client.estimateGas({ to: VERIFY, data });
  console.log(`on-chain pqcVerify: valid=${good} tampered=${tampered} gas(estimate, whole call)=${gas}`);

  const st = await client.readContract({ address: STATUS, abi: PQC, functionName: "pqcKeyStatus", args: ["0x6E2198c7198Ce3B718DFCf38103120C8346fD28A"] });
  console.log(`pqcKeyStatus(known fest account): registered=${st[0]} alg=${st[1]} keyLen=${(st[2].length - 2) / 2} possessionProven=${st[3]}`);
  console.log(good === true && tampered === false ? "RESULT: precompile verifies ML-DSA-87 as expected" : "RESULT: unexpected");
}
main().catch((e) => { console.error("probe failed:", e?.shortMessage ?? e?.message ?? e); process.exitCode = 2; });
