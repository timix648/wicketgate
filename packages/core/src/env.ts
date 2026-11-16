// Network settings and the location of the key file. The key file lives outside the
// repository (default ~/.wicketgate/keys.env, mode 0600) and is created by the owner
// with `pnpm keys:new`. Nothing in this repository ever prints a secret from it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";

export const NET = {
  chainId: process.env.QORE_CHAIN_ID ?? "qorechain-diana",
  evmChainId: 9800,
  rest: process.env.QORE_REST ?? "https://api-testnet.qore.host",
  rpc: process.env.QORE_RPC ?? "https://rpc-testnet.qore.host",
  evm: process.env.QORE_EVM ?? "https://evm-testnet.qore.host",
  explorer: "https://explore.qore.network",
};

/** Every role the project uses. ADMIN_A also deploys and runs the operator. W3 is the drill account. */
export const ROLES = ["ADMIN_A", "ADMIN_B", "W1", "W2", "W3"] as const;
export type Role = (typeof ROLES)[number];

export const KEYS_FILE = process.env.WICKETGATE_KEYS ?? join(homedir(), ".wicketgate", "keys.env");

function readKeyFile(): Record<string, string> {
  if (!existsSync(KEYS_FILE)) {
    throw new Error(`No key file at ${KEYS_FILE}. The owner creates it with: pnpm keys:new`);
  }
  const mode = statSync(KEYS_FILE).mode & 0o777;
  if (mode & 0o077) throw new Error(`${KEYS_FILE} must be readable by its owner only (chmod 600)`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*(WG_[A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const cache = new Map<Role, UnifiedAccount>();

/** The unified (eth-native) account for a role: one key on both the EVM and native lanes. */
export async function account(role: Role): Promise<UnifiedAccount> {
  const hit = cache.get(role);
  if (hit) return hit;
  const mnemonic = readKeyFile()[`WG_${role}_MNEMONIC`];
  if (!mnemonic) throw new Error(`WG_${role}_MNEMONIC missing from ${KEYS_FILE}`);
  const acc = await deriveUnifiedAccount(mnemonic);
  cache.set(role, acc);
  return acc;
}

export const DEPLOYMENTS_FILE = new URL("../../../deployments/diana.json", import.meta.url);
