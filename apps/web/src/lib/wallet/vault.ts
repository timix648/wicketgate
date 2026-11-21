// The app's own rollup key (frontend brief, section 8.6). A fresh random 32-byte seed made in the
// browser, never derived from the wallet and never sent anywhere. Only the seed is stored, encrypted
// with AES-GCM under a key derived from the user's passphrase (PBKDF2-SHA-256), in IndexedDB.
// Exit salts are stored with it: losing a salt loses that exit's money.
import { qledgerKeypairFromSeed } from "@qorechain/rdk";

export const KDF_ITERATIONS = 600_000; // brief: at least 310,000
export const MIN_PASSPHRASE = 10;

export interface Kdf {
  name: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
}

/** What a withdrawal to an exit address needs to be paid out later. */
export interface ExitRecord {
  rollupId: string;
  salt: `0x${string}`;
  exitAddr: `0x${string}`;
  beneficiary: `0x${string}`;
  amountUqor: string;
  nonce: string;
  createdAt: number;
  relayId?: string;
  exitId?: string;
}

export type ActivityKind = "deposit" | "send" | "withdraw";

export interface Activity {
  kind: ActivityKind;
  rollupId: string;
  amountUqor: string;
  at: number;
  txHash?: string;
  relayId?: string;
  exitId?: string;
  to?: string;
  nonce?: string;
  exitAddr?: string;
}

/** The backup file and the stored record share this shape (brief: version, rollupId, accountId, encryptedSeed, kdf, salt, iv). */
export interface VaultRecord {
  version: 1;
  rollupId: string;
  accountId: string;
  encryptedSeed: string;
  kdf: Kdf;
  salt: string;
  iv: string;
  exits: ExitRecord[];
  activity?: Activity[];
  /** Next nonce this browser will use, per rollup, for transactions not yet seen in a batch. */
  nextNonce?: Record<string, string>;
  createdAt: number;
}

export interface Unlocked {
  accountId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

// ------------------------------------------------------------- encoding

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toHexStr = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const aad = (accountId: string) => new TextEncoder().encode(`wicketgate-rollup-seed-v1:${accountId}`);

async function deriveKey(passphrase: string, salt: Uint8Array, kdf: Kdf) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: kdf.hash, salt, iterations: kdf.iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function keysFromSeed(seed: Uint8Array): Unlocked {
  const kp = qledgerKeypairFromSeed(seed);
  return { accountId: toHexStr(kp.accountId), publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Makes a new rollup account. Returns the record to store and the unlocked keys. */
export async function createAccount(passphrase: string, rollupId: string): Promise<{ record: VaultRecord; keys: Unlocked }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = keysFromSeed(seed);
  const kdf: Kdf = { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, kdf);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(keys.accountId) }, key, seed));
  seed.fill(0);
  const record: VaultRecord = {
    version: 1,
    rollupId,
    accountId: keys.accountId,
    encryptedSeed: b64(ct),
    kdf,
    salt: b64(salt),
    iv: b64(iv),
    exits: [],
    activity: [],
    nextNonce: {},
    createdAt: Date.now(),
  };
  return { record, keys };
}

/** Decrypts the seed and rebuilds the keys; a wrong passphrase or a tampered file fails here. */
export async function unlock(record: VaultRecord, passphrase: string): Promise<Unlocked> {
  const key = await deriveKey(passphrase, unb64(record.salt), record.kdf);
  let seed: Uint8Array;
  try {
    seed = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(record.iv), additionalData: aad(record.accountId) }, key, unb64(record.encryptedSeed)),
    );
  } catch {
    throw new Error("Wrong passphrase, or the backup has been changed");
  }
  const keys = keysFromSeed(seed);
  seed.fill(0);
  if (keys.accountId !== record.accountId) throw new Error("This backup's seed does not match its account id");
  return keys;
}

/** Checks the shape of a backup file before trying to unlock it. */
export function parseBackup(text: string): VaultRecord {
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    throw new Error("That file is not a Wicketgate backup (not JSON)");
  }
  const ok =
    r?.version === 1 &&
    typeof r.accountId === "string" && /^[0-9a-f]{64}$/.test(r.accountId) &&
    typeof r.rollupId === "string" &&
    typeof r.encryptedSeed === "string" && typeof r.salt === "string" && typeof r.iv === "string" &&
    r.kdf?.name === "PBKDF2" && r.kdf?.hash === "SHA-256" && Number.isInteger(r.kdf?.iterations) && r.kdf.iterations >= 310_000;
  if (!ok) throw new Error("That file is not a Wicketgate backup, or it is from a newer version");
  return { exits: [], activity: [], nextNonce: {}, createdAt: Date.now(), ...r } as VaultRecord;
}

export function backupBlob(record: VaultRecord): Blob {
  return new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
}

export function downloadBackup(record: VaultRecord) {
  const url = URL.createObjectURL(backupBlob(record));
  const a = document.createElement("a");
  a.href = url;
  a.download = `wicketgate-rollup-account-${record.accountId.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------- IndexedDB

const DB = "wicketgate";
const STORE = "rollup-accounts";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "accountId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is unavailable in this browser"));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Storage was refused (private window or full disk?)"));
      }),
  );
}

export const listRecords = () => run<VaultRecord[]>("readonly", (s) => s.getAll() as IDBRequest<VaultRecord[]>);
export const saveRecord = (r: VaultRecord) => run("readwrite", (s) => s.put(r));
export const deleteRecord = (accountId: string) => run("readwrite", (s) => s.delete(accountId));
