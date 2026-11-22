// Sealed exit requests. The wallet seals each instant-exit request with QoreSeal (ML-KEM-1024 +
// X25519 hybrid, AES-256-GCM) to the exit operator's ML-KEM-1024 key as registered in the chain's
// KEM registry, so the app, its queue and its hosts only ever hold ciphertext. The envelope is
// bound to the chain, the rollup and the pool through its associated data: a sealed request
// moved to another rollup or pool does not open.
//
// The operator's key is checked three ways before anything is sealed: the key the chain returns
// must hash to the fingerprint pinned in the app (EXIT_OPERATOR.mlkemKeySha3), the operator's
// recipient card must carry the same fingerprint, and the card's QoreSign signature must verify
// against the operator's own post-quantum account key on chain. A relay that swaps in its own key
// fails all three.
import { envelopeFromText, envelopeToText, open, parseEnvelope, seal, type SealKeyPair, type RecipientCard } from "@qorechain/qoreseal";
import { resolveRecipient } from "@qorechain/qoreseal/network";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const EXIT_REQUEST_PURPOSE = "wicketgate-exit-request";
/** Envelope text is about 3.2 KB for one recipient; refuse anything far larger. */
export const MAX_SEALED_EXIT_CHARS = 8192;

/** The exit operator (op-pay, ADMIN_A) and the SHA3-256 of its registered ML-KEM-1024 key. */
export const EXIT_OPERATOR = {
  address: "qor16087dpc985wvk6hlsl2x8p0kyumz394q0lvm6k",
  mlkemKeySha3: "028cce4ae45fee22d5b5adc0144ea391dbe360a7fc303c3be357434c3c80b3b0",
} as const;

export interface ExitRequest {
  rollupId: string;
  beneficiary: string;
  salt: string;
  amountUqor: string;
}

const ROLLUP = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SALT = /^0x[0-9a-fA-F]{64}$/;
const UQOR = /^[1-9][0-9]{0,20}$/;

/** The associated data every sealed exit request is bound to. */
export const exitRequestAad = (chainId: string, rollupId: string, pool: string) =>
  new TextEncoder().encode(`${EXIT_REQUEST_PURPOSE}|${chainId}|${rollupId}|${pool.toLowerCase()}`);

/** A well-formed request, or the reason it is not one. */
export function checkExitRequest(r: unknown): ExitRequest | string {
  const x = r as Partial<ExitRequest> | null;
  if (!x || typeof x !== "object") return "not an object";
  if (typeof x.rollupId !== "string" || !ROLLUP.test(x.rollupId)) return "rollupId is missing or malformed";
  if (typeof x.beneficiary !== "string" || !ADDR.test(x.beneficiary)) return "beneficiary must be a 0x address";
  if (typeof x.salt !== "string" || !SALT.test(x.salt)) return "salt must be 0x followed by 64 hex characters";
  if (typeof x.amountUqor !== "string" || !UQOR.test(x.amountUqor)) return "amountUqor must be a positive decimal string";
  return { rollupId: x.rollupId, beneficiary: x.beneficiary, salt: x.salt.toLowerCase(), amountUqor: x.amountUqor };
}

export const mlkemFingerprint = (key: Uint8Array) => bytesToHex(sha3_256(key));

/**
 * Seal a request to the exit operator. `rest` is a chain REST endpoint (or a relay of one: the
 * pinned fingerprint and the card signature make a relay unable to substitute a key).
 */
export async function sealExitRequest(args: {
  rest: string;
  fetch?: typeof fetch;
  chainId: string;
  pool: string;
  card: RecipientCard;
  request: ExitRequest;
  operator?: { address: string; mlkemKeySha3: string };
}): Promise<string> {
  const op = args.operator ?? EXIT_OPERATOR;
  const req = checkExitRequest(args.request);
  if (typeof req === "string") throw new Error(`exit request: ${req}`);
  if (args.card.address !== op.address) throw new Error("the operator card is for another account");
  if (args.card.mlkemKeySha3.toLowerCase() !== op.mlkemKeySha3) throw new Error("the operator card does not carry the pinned key");
  const recipient = await resolveRecipient({ rest: args.rest, fetch: args.fetch as any, chainId: args.chainId, address: op.address, card: args.card });
  if (mlkemFingerprint(recipient.mlkemPublicKey) !== op.mlkemKeySha3) throw new Error("the chain's key for the operator is not the pinned key");
  const env = seal({
    chainId: args.chainId,
    purpose: EXIT_REQUEST_PURPOSE,
    recipients: [recipient],
    plaintext: new TextEncoder().encode(JSON.stringify(req)),
    aad: exitRequestAad(args.chainId, req.rollupId, args.pool),
    anonymous: true,
  });
  return envelopeToText(env);
}

/** Cheap shape check for the relay, which cannot open the envelope. */
export function isSealedExitText(text: unknown): text is string {
  if (typeof text !== "string" || text.length > MAX_SEALED_EXIT_CHARS) return false;
  try {
    const p = parseEnvelope(envelopeFromText(text));
    return p.mode === "hybrid" && p.entries.length === 1;
  } catch {
    return false;
  }
}

/** Open a sealed request for `rollupId`; throws if it is not for this chain, rollup and pool. */
export function openExitRequest(args: { text: string; keys: SealKeyPair; chainId: string; rollupId: string; pool: string }): ExitRequest {
  const plain = open({
    chainId: args.chainId,
    purpose: EXIT_REQUEST_PURPOSE,
    envelope: envelopeFromText(args.text),
    keys: args.keys,
    aad: exitRequestAad(args.chainId, args.rollupId, args.pool),
  });
  const req = checkExitRequest(JSON.parse(new TextDecoder().decode(plain)));
  if (typeof req === "string") throw new Error(`sealed exit request: ${req}`);
  if (req.rollupId !== args.rollupId) throw new Error("sealed exit request is for another rollup");
  return req;
}
