// Probes 3 and 4: a native (bank) payment to the qor1 form of an exit address that has no
// code yet, then ExitPool deploys the ExitAddress there with CREATE2 and sweeps the funds.
// This is the repayment leg of every instant exit. Costs about 0.1 QOR plus fees (from ADMIN_A).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hexToBech32 } from "@qorechain/rdk";
import { toHex, type Address, type Hex } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

async function main() {
  const A = await account("ADMIN_A");
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
  const { abi } = artifact("ExitPool");
  const salt = toHex(randomBytes(32)) as Hex;
  const exitAddr = (await publicClient.readContract({ address: pool, abi, functionName: "exitAddressFor", args: [A.evm, salt] })) as Address;
  const exitQor = hexToBech32(exitAddr, "qor");
  console.log(`exit address ${exitAddr} (${exitQor}), code before: ${(await publicClient.getCode({ address: exitAddr })) ?? "none"}`);

  const amount = 100_000n; // 0.1 QOR
  const r = await sendNative(A, [
    { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: A.cosmos, toAddress: exitQor, amount: [{ denom: "uqor", amount: amount.toString() }] } },
  ]);
  console.log(`native payment to the codeless exit address: ${explorerTx(r.transactionHash)}`);
  const bal = await publicClient.getBalance({ address: exitAddr });
  console.log(`EVM balance of exit address: ${bal} wei (expected ${amount * 10n ** 12n}) -> ${bal === amount * 10n ** 12n ? "PASS" : "FAIL"}`);

  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 1_000_000n), allowedTargets: [pool] });
  try {
    const before = await publicClient.getBalance({ address: A.evm });
    const hash = await walletFor(A).writeContract({ address: pool, abi, functionName: "sweepToBeneficiary", args: [A.evm, salt] } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    const code = await publicClient.getCode({ address: exitAddr });
    const after = await publicClient.getBalance({ address: exitAddr });
    const gotBack = (await publicClient.getBalance({ address: A.evm })) - before;
    console.log(`sweepToBeneficiary: ${rc.status} ${hash} gas ${rc.gasUsed}`);
    console.log(`exit contract deployed at the predicted address: ${code && code !== "0x" ? "PASS" : "FAIL"}; balance left ${after} wei; beneficiary net change ${gotBack} wei (payment minus gas)`);
    console.log(rc.status === "success" && after === 0n && code && code !== "0x" ? "RESULT: exit addresses receive native payouts and can be swept" : "RESULT: FAIL");
  } finally {
    await closeWindow(A);
  }
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
