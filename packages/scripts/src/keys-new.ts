// Run by the owner, once: creates fresh testnet-only mnemonics for every role in a
// file outside the repository (mode 0600) and prints the public addresses only.
// It refuses to overwrite an existing file.
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { generateMnemonic, deriveUnifiedAccount } from "@qorechain/sdk";
import { KEYS_FILE, ROLES } from "@wicketgate/core/env";

async function main() {
  if (existsSync(KEYS_FILE)) {
    console.error(`${KEYS_FILE} already exists. Not overwriting it.`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(KEYS_FILE), { recursive: true, mode: 0o700 });
  const lines = [
    "# Wicketgate testnet keys. Testnet only: never fund these on mainnet, never commit this file.",
    `# Created ${new Date().toISOString()}`,
  ];
  const addrs: string[] = [];
  for (const role of ROLES) {
    const m = generateMnemonic(256);
    const a = await deriveUnifiedAccount(m);
    lines.push(`WG_${role}_MNEMONIC="${m}"`);
    addrs.push(`${role.padEnd(8)} ${a.cosmos}  ${a.evm}`);
  }
  writeFileSync(KEYS_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(KEYS_FILE, 0o600);
  console.log(`Wrote ${ROLES.length} testnet accounts to ${KEYS_FILE} (mode 600). Addresses:`);
  for (const l of addrs) console.log("  " + l);
  console.log("Fund ADMIN_A from the faucet (100 QOR), then run: pnpm fund");
}
main();
