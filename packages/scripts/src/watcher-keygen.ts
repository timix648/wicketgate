// Create a fresh, testnet-only key for an independent watcher operator, on the operator's own
// machine. Appends WG_<NAME>_MNEMONIC to the key file (mode 600), refuses to replace an existing
// one, and prints only the public addresses. Nobody else ever sees the recovery phrase.
// Usage: npx tsx src/watcher-keygen.ts <NAME>
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateMnemonic, deriveUnifiedAccount } from "@qorechain/sdk";
import { KEYS_FILE } from "@wicketgate/core/env";

const name = (process.argv[2] ?? "").toUpperCase();
if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(name)) throw new Error("usage: watcher-keygen.ts <NAME> (letters, digits, _; e.g. DAB0S)");
mkdirSync(dirname(KEYS_FILE), { recursive: true, mode: 0o700 });
if (!existsSync(KEYS_FILE)) writeFileSync(KEYS_FILE, "# Wicketgate testnet watcher key. Testnet only; never share or commit this file.\n", { mode: 0o600 });
chmodSync(KEYS_FILE, 0o600);
if (readFileSync(KEYS_FILE, "utf8").includes(`WG_${name}_MNEMONIC=`)) {
  console.error(`WG_${name}_MNEMONIC already exists in ${KEYS_FILE}; not replacing it.`);
  process.exit(1);
}
const m = generateMnemonic(256);
const a = await deriveUnifiedAccount(m);
appendFileSync(KEYS_FILE, `WG_${name}_MNEMONIC="${m}"\n`);
console.log(`watcher ${name}\n  native: ${a.cosmos}\n  evm:    ${a.evm}\nKey saved to ${KEYS_FILE} (mode 600). Back that file up somewhere safe; send only the native address for funding.`);
