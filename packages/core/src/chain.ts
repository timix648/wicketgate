// Small helpers for reading the chain and sending hybrid-signed native transactions
// from a unified eth-native account.
import { StargateClient } from "@cosmjs/stargate";
import { createRdkRegistry } from "@qorechain/rdk";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
type EncodeObject = { typeUrl: string; value: unknown };
import { NET } from "./env.js";
import { politeFetch } from "./polite.js";

const UA = { "User-Agent": "wicketgate-scripts/0.1" };

export async function restGet<T = any>(path: string): Promise<{ status: number; body: T }> {
  const r = await politeFetch(NET.rest + path, { headers: UA });
  const body = (await r.json().catch(() => ({}))) as T;
  return { status: r.status, body };
}

/** Throws when the balance cannot be read, so a failed read is never mistaken for an empty account. */
export async function balanceUqor(address: string): Promise<bigint> {
  const { status, body } = await restGet<any>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`);
  if (status !== 200 || body?.balance?.amount === undefined) throw new Error(`balance of ${address} unreadable (HTTP ${status})`);
  return BigInt(body.balance.amount);
}

export async function pqcStatus(address: string): Promise<{ registered: boolean; proven: boolean }> {
  const { status, body } = await restGet<any>(`/qorechain/pqc/v1/account/${address}`);
  if (status !== 200) return { registered: false, proven: false };
  const a = body?.account ?? body?.pqc_account ?? body;
  const registered = Boolean(a?.public_key || a?.pubkey || a?.pqc_pubkey);
  const proven = Boolean(a?.possession_proven ?? a?.possessionProven);
  return { registered, proven };
}

export async function accountSeq(address: string): Promise<{ accountNumber: number; sequence: number } | undefined> {
  const { status, body } = await restGet<any>(`/cosmos/auth/v1beta1/accounts/${address}`);
  if (status === 404) return undefined; // the account does not exist yet
  if (status !== 200) throw new Error(`account ${address} unreadable (HTTP ${status})`);
  const a = body?.account?.base_account ?? body?.account;
  return { accountNumber: Number(a.account_number), sequence: Number(a.sequence ?? 0) };
}

export const qor = (uqor: bigint) => `${(Number(uqor) / 1e6).toFixed(6)} QOR`;

let transport: StargateClient | undefined;
async function getTransport() {
  transport ??= await StargateClient.connect(NET.rpc);
  return transport;
}

/** Sign and broadcast native messages from a unified account. Throws on a non-zero code. */
export async function sendNative(
  acc: UnifiedAccount,
  messages: EncodeObject[],
  opts: { gas?: number; classical?: boolean; memo?: string } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce(acc, messages, opts);
    } catch (e: any) {
      // another process signing for the same account took the sequence: re-read it and retry
      if (attempt < 4 && /sequence mismatch|incorrect account sequence/i.test(String(e?.message))) {
        await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
        continue;
      }
      throw e;
    }
  }
}

async function sendOnce(acc: UnifiedAccount, messages: EncodeObject[], opts: { gas?: number; classical?: boolean; memo?: string }) {
  const seq = await accountSeq(acc.cosmos);
  if (!seq) throw new Error(`${acc.cosmos} does not exist on chain yet: fund it first`);
  const gas = opts.gas ?? 600_000;
  // The SDK registry predates the v3.2.8 rollup messages; the RDK's registry knows all of them.
  const rdk = messages.some((m) => m.typeUrl.startsWith("/qorechain.rdk."));
  const signer = new EthNativeSigner(acc, {
    rest: NET.rest,
    signMode: opts.classical ? "classical" : "hybrid",
    ...(rdk ? { registry: createRdkRegistry() as any } : {}),
  });
  const res = await signer.signAndBroadcast(await getTransport(), {
    chainId: NET.chainId,
    accountNumber: seq.accountNumber,
    sequence: seq.sequence,
    fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.15)) }], gas: String(gas) },
    messages,
    memo: opts.memo,
  });
  if (res.code !== 0) throw new Error(`tx ${res.transactionHash} failed (code ${res.code}): ${res.rawLog ?? ""}`);
  return res;
}

/** Register the account's ML-DSA-87 key with a proof of possession (the one bootstrap-exempt classical tx). */
export async function registerPqc(acc: UnifiedAccount) {
  const proofOfPossession = signProofOfPossession({ chainId: NET.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  return sendNative(acc, [msg], { classical: true, gas: 700_000 });
}

export function explorerTx(hash: string) {
  return `${NET.explorer}/tx/${hash}`;
}
