"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { FEED_BASE, REPO_URL } from "../lib/config";
import { ago } from "../lib/format";
import { ErrorBox, Hash, Loading, Pill } from "../components/ui";

const ROLLUP = "wicketgate-pay";

const CHECKS: { key: string; name: string; what: string }[] = [
  { key: "chainBinding", name: "Chain binding", what: "The receipt names the chain that was actually queried, so a mainnet receipt cannot pass on testnet or the reverse." },
  { key: "rollupLayerBinding", name: "Rollup belongs to the layer", what: "The chain says this rollup id belongs to the receipt's layer." },
  { key: "batchStateRoot", name: "Batch state root", what: "The chain's own record of this batch carries the same state root." },
  { key: "anchorOnChain", name: "Anchor on chain", what: "An anchor exists on QoreChain matching every anchor field: state root, heights, validator-set hash, signature and time." },
  { key: "creatorAuthority", name: "Signer from chain", what: "The key that must have signed was read from the chain, not taken from the receipt." },
  { key: "pqcSignature", name: "ML-DSA-87 signature", what: "The post-quantum signature over the canonical anchor message verifies." },
];

interface IndexRow { batch: number; status: string; valid: boolean; checks: string; file: string }
interface Verification {
  valid: boolean;
  mode: string;
  checks: Record<string, boolean> | null;
  signBytesVersion: string | null;
  reason: string | null;
  checkedAt: string;
  chainId: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const verify = (receipt: unknown) =>
  getJson<Verification>("/api/receipt/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt }) });

/** The same receipt with one hex digit of its state root changed: a forgery the chain must reject. */
function tamper(receipt: any) {
  const r = structuredClone(receipt);
  const s: string = r.stateRoot;
  r.stateRoot = s.slice(0, -1) + (s.at(-1) === "0" ? "1" : "0");
  return r;
}

export function Receipt() {
  const index = useQuery({
    queryKey: ["receipts", ROLLUP],
    queryFn: () => getJson<{ generatedAt: string; batches: number; valid: number; rows: IndexRow[] }>(`${FEED_BASE}/receipts/${ROLLUP}/index.json`),
  });
  const [batch, setBatch] = useState<number>();
  const [pasted, setPasted] = useState("");
  const [receipt, setReceipt] = useState<any>();
  const [loadError, setLoadError] = useState<string>();
  const [result, setResult] = useState<{ label: string; v?: Verification; error?: string; busy?: boolean }>();

  useEffect(() => {
    if (batch === undefined && index.data?.rows.length) setBatch(index.data.rows.at(-1)!.batch);
  }, [index.data, batch]);

  useEffect(() => {
    if (batch === undefined) return;
    setLoadError(undefined);
    setResult(undefined);
    getJson<any>(`${FEED_BASE}/receipts/${ROLLUP}/batch-${batch}.json`)
      .then((j) => setReceipt(j.receipt ?? j))
      .catch((e) => setLoadError(e.message));
  }, [batch]);

  const run = async (label: string, r: unknown) => {
    setResult({ label, busy: true });
    try {
      setResult({ label, v: await verify(r) });
    } catch (e) {
      setResult({ label, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Receipt checker</h1>
        <p><strong>A receipt is a claim, not evidence.</strong> A settlement receipt says a rollup batch was anchored on QoreChain with a post-quantum signature. Checking it means re-reading every field from the chain and verifying the ML-DSA-87 signature; nothing in the file is trusted.</p>
      </div>

      <div className="grid two">
        <div className="card">
          <h3>A receipt from <span className="mono">{ROLLUP}</span></h3>
          {index.error ? (
            <ErrorBox error={index.error} />
          ) : !index.data ? (
            <Loading lines={2} />
          ) : (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>
                {index.data.valid} of {index.data.batches} batches have a valid receipt in the{" "}
                <a href={`${FEED_BASE.replace("raw.githubusercontent.com", "github.com").replace("/main", "/tree/main")}/receipts/${ROLLUP}`} target="_blank" rel="noreferrer">public feed</a>, rebuilt {ago(index.data.generatedAt)}.
              </p>
              <div className="row">
                <label className="small muted" htmlFor="batch">Batch</label>
                <select id="batch" className="input" style={{ flex: "0 1 160px" }} value={batch ?? ""} onChange={(e) => setBatch(Number(e.target.value))}>
                  {index.data.rows.map((r) => <option key={r.batch} value={r.batch}>{r.batch}</option>)}
                </select>
                <button className="btn" disabled={!receipt || result?.busy} onClick={() => run(`Batch ${batch}, as published`, receipt)}>Verify against the chain</button>
              </div>
              {loadError && <p className="small" style={{ color: "var(--bad)" }}>{loadError}</p>}
              {receipt && (
                <dl className="kv small" style={{ marginTop: 12 }}>
                  <dt>Rollup / batch</dt><dd><Link href={`/r/${receipt.rollupId}/${receipt.batchIndex}`} className="mono">{receipt.rollupId} #{receipt.batchIndex}</Link></dd>
                  <dt>State root</dt><dd><Hash value={receipt.stateRoot} /></dd>
                  <dt>Signed by</dt><dd><Hash value={receipt.creator} /> ({receipt.algorithm})</dd>
                  <dt>Anchored at height</dt><dd>{Number(receipt.mainChainHeight).toLocaleString()}</dd>
                </dl>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <button className="icon-btn" disabled={!receipt || result?.busy} onClick={() => run(`Batch ${batch}, with one digit of its state root changed`, tamper(receipt))}>
                  Try a forged copy
                </button>
                <span className="small muted">Changes one hex digit of the state root; the chain must reject it.</span>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3>Or paste any receipt</h3>
          <textarea className="input" style={{ height: 150, padding: 10, width: "100%", resize: "vertical" }} placeholder='{ "version": 2, "chainId": "qorechain-diana", "rollupId": … }' value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn"
              disabled={!pasted.trim() || result?.busy}
              onClick={() => {
                try {
                  run("Pasted receipt", JSON.parse(pasted));
                } catch {
                  setResult({ label: "Pasted receipt", error: "That is not valid JSON" });
                }
              }}
            >
              Verify
            </button>
            <span className="small muted">Works for a receipt from any rollup on the testnet.</span>
          </div>
        </div>
      </div>

      {result && (
        <div className="section">
          <div className="section-head">
            <h2>{result.label}</h2>
            {result.v && <p>checked {ago(result.v.checkedAt)} against {result.v.chainId}{result.v.signBytesVersion && `, ${result.v.signBytesVersion} anchor message`}</p>}
          </div>
          {result.busy ? (
            <Loading lines={3} />
          ) : result.error ? (
            <div className="card error-box">{result.error}</div>
          ) : result.v ? (
            <>
              <div className={`banner ${result.v.valid ? "ok" : "bad"}`} style={{ marginBottom: 12 }}>
                <div>
                  <strong>{result.v.valid ? "Valid: reproduced from live chain state" : "Not valid"}</strong>
                  {result.v.reason && <span className="small">{result.v.reason}</span>}
                </div>
              </div>
              {result.v.checks && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Check</th><th>What it proves</th><th>Result</th></tr></thead>
                    <tbody>
                      {CHECKS.map((c) => (
                        <tr key={c.key}>
                          <td><strong>{c.name}</strong></td>
                          <td className="small" style={{ whiteSpace: "normal" }}>{c.what}</td>
                          <td>{result.v!.checks![c.key] ? <Pill tone="ok">pass</Pill> : <Pill tone="bad">fail</Pill>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      <p className="small muted section">
        The check runs on this site&apos;s server with <code>verifySettlementReceipt</code> from <code>@qorechain/rdk</code>, because QoreChain&apos;s
        public REST and RPC endpoints do not allow requests from web pages. To check without trusting this site, run it yourself from a clone of the{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer">repository</a>: <code>cd packages/scripts &amp;&amp; npx tsx src/verify-receipt.ts &lt;receipt.json&gt;</code>.
      </p>
    </>
  );
}
