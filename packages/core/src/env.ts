// Network settings and the location of the key file. The key file lives outside the
// repository (default ~/.wicketgate/keys.env, mode 0600) and is created by the owner
// with `pnpm keys:new`. Nothing in this repository ever prints a secret from it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deriveUnifiedAccount, unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";
import { qledgerKeypairFromSeed } from "@qorechain/rdk";

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

const cache = new Map<string, UnifiedAccount>();

/**
 * The unified (eth-native) account for a role: one key on both the EVM and native lanes. Any
 * name works, not only the team's roles: an outside watcher puts WG_<NAME>_MNEMONIC in its own
 * key file and runs with `--as <NAME>` (see docs/WATCHERS.md).
 */
export async function account(role: Role | string): Promise<UnifiedAccount> {
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(role)) throw new Error(`account name "${role}" must be upper case letters, digits or _`);
  const hit = cache.get(role);
  if (hit) return hit;
  const mnemonic = readKeyFile()[`WG_${role}_MNEMONIC`];
  if (!mnemonic) throw new Error(`WG_${role}_MNEMONIC missing from ${KEYS_FILE}`);
  const acc = await deriveUnifiedAccount(mnemonic);
  cache.set(role, acc);
  return acc;
}

/**
 * A role's qledger-v1 account (ML-DSA-44), derived from the role's recovery phrase with a
 * domain tag, so no extra secret is stored. Same phrase, same ledger account, on any rollup.
 */
export async function ledgerKey(role: Role | string) {
  const mnemonic = readKeyFile()[`WG_${role}_MNEMONIC`];
  if (!mnemonic) throw new Error(`WG_${role}_MNEMONIC missing from ${KEYS_FILE}`);
  const seed = createHash("sha256").update(`wicketgate:qledger:v1|${mnemonic}`).digest();
  return qledgerKeypairFromSeed(seed);
}

/**
 * Local, non-secret state (exit salts, ledger nonces) kept next to the key file.
 * WICKETGATE_STATE points elsewhere, e.g. to keep a test deployment's exits apart from the live ones.
 */
export const STATE_DIR = process.env.WICKETGATE_STATE ?? join(homedir(), ".wicketgate");

/** Deployed addresses. WICKETGATE_DEPLOYMENTS points at another file (e.g. deployments/diana-v1.json). */
export const DEPLOYMENTS_FILE = process.env.WICKETGATE_DEPLOYMENTS
  ? new URL(`file://${require_abs(process.env.WICKETGATE_DEPLOYMENTS)}`)
  : new URL("../../../deployments/diana.json", import.meta.url);

function require_abs(p: string) {
  return p.startsWith("/") ? p : join(process.cwd(), p);
}

/**
 * The two accounts of the Q-Day simulation (packages/scripts/src/qday-*.ts):
 *  - W4, a watcher whose secp256k1 key is deliberately weak (a 40-bit scalar), standing in for any
 *    classical key after Q-Day; its ML-DSA-87 key comes from a separate full-strength secret;
 *  - MALLORY, the attacker: an ordinary account.
 * Both live in the key file like every other role. The attacker script never reads them.
 */
export async function qdayAccount(name: "W4" | "MALLORY"): Promise<UnifiedAccount> {
  const k = readKeyFile();
  if (name === "MALLORY") {
    if (!k.WG_MALLORY_MNEMONIC) throw new Error("WG_MALLORY_MNEMONIC missing: run qday-setup.ts first");
    return deriveUnifiedAccount(k.WG_MALLORY_MNEMONIC);
  }
  if (!k.WG_W4_WEAK_KEY || !k.WG_W4_PQC_SECRET) throw new Error("W4 keys missing: run qday-setup.ts first");
  const seed = Buffer.from(k.WG_W4_WEAK_KEY.replace(/^0x/, "").padStart(64, "0"), "hex");
  return unifiedAccountFromSeed(new Uint8Array(seed), { pqcSecret: new Uint8Array(Buffer.from(k.WG_W4_PQC_SECRET, "hex")) });
}
