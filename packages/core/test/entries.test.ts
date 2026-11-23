// Reading a rollup's inbox through every transaction shape a post can arrive in.
//
// The chain commits to each post's sha256 in an `rdk_data_posted` event but does not serve the
// payload, so a reader must recover it from the posting transaction. These tests build the same
// four posts and deliver them in different wrappers, then show:
//   - the RDK's own fetcher handles only top-level posts (the bug used on wicketgate-pay batch 12);
//   - robustRest (the RDK path our main watchers use) handles every JSON-decoded wrapper, at any
//     field and depth, but not a wrapper the node could not decode to JSON;
//   - the independent reader handles every shape, including the undecoded one, because it matches
//     the committed hash instead of looking for a message type;
//   - and neither path ever accepts a wrong payload or a range that disagrees with the accumulator.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { EMPTY_INBOX_ACC, fetchQledgerEntries, postedDataHash, qledgerAccumulate, type RestClient } from "@qorechain/rdk";
import { fetchEntriesIndependent } from "../src/independent-entries.ts";
import { robustRest } from "../src/robust-rest.ts";

const CHAIN = "qorechain-diana";
const R = "test-rollup";
const POST = "/qorechain.rdk.v1.MsgPostRollupData";
const POSTER = "qor1posterxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** Minimal protobuf encoding of MsgPostRollupData {1: poster, 2: rollup_id, 3: data}. */
function protoPost(poster: string, rollupId: string, data: Uint8Array): Uint8Array {
  const field = (no: number, bytes: Uint8Array) => {
    const out: number[] = [(no << 3) | 2];
    let n = bytes.length;
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n);
    return Buffer.concat([Buffer.from(out), Buffer.from(bytes)]);
  };
  return Buffer.concat([field(1, Buffer.from(poster)), field(2, Buffer.from(rollupId)), field(3, data)]);
}

const payloads = [1, 2, 3, 4].map(() => new Uint8Array(randomBytes(200)));
const entries = payloads.map((p, i) => ({ height: BigInt(100 + i), poster: POSTER, payload: p }));
const accTo = hex(qledgerAccumulate({ chainId: CHAIN, rollupId: R, from: 0n, accFrom: EMPTY_INBOX_ACC, entries } as any));

const post = (p: Uint8Array) => ({ "@type": POST, poster: POSTER, rollup_id: R, data: b64(p) });
const event = (seq: number, p: Uint8Array) => ({
  type: "rdk_data_posted",
  attributes: [
    { key: "rollup_id", value: R }, { key: "sequence", value: String(seq) },
    { key: "poster", value: POSTER }, { key: "data_hash", value: hex(postedDataHash(p)) },
  ],
});

/** Each shape wraps the post message differently. */
const SHAPES: Record<string, (p: Uint8Array) => any[]> = {
  "top level": (p) => [post(p)],
  "authz MsgExec": (p) => [{ "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: "qor1grantee", msgs: [post(p)] }],
  "MsgExec inside MsgExec": (p) => [{ "@type": "/cosmos.authz.v1beta1.MsgExec", msgs: [{ "@type": "/cosmos.authz.v1beta1.MsgExec", msgs: [post(p)] }] }],
  "group proposal": (p) => [{ "@type": "/cosmos.group.v1.MsgSubmitProposal", messages: [post(p)], exec: "EXEC_TRY" }],
  "unknown wrapper field": (p) => [{ "@type": "/some.account.v1.MsgExecuteCosmos", cosmos_messages: [{ inner: post(p) }] }],
  "wrapper the node could not decode": (p) => [{ "@type": "/some.wrapper.v1.MsgRun", call: { "@type": "/google.protobuf.Any", value: b64(protoPost(POSTER, R, p)) } }],
};

function restFor(shape: (p: Uint8Array) => any[], opts: { tamper?: boolean; badAcc?: boolean } = {}): RestClient {
  const txs = payloads.map((p, i) => {
    const carried = opts.tamper && i === 2 ? new Uint8Array(randomBytes(200)) : p; // tx carries other bytes than the event committed to
    return { txhash: `TX${i}`, height: String(100 + i), tx: { body: { messages: shape(carried) } }, events: [event(i + 1, p)] };
  });
  return {
    searchTxs: async (q: string) => (q.startsWith("rdk_data_posted") ? structuredClone(txs) : []),
    getPostedData: async () => ({ inboxAcc: opts.badAcc ? "00".repeat(32) : accTo }),
    getInbox: async () => ({ headSequence: 4, headAcc: accTo }),
  } as unknown as RestClient;
}

const input = { chainId: CHAIN, rollupId: R, from: 0, to: 4, accFrom: EMPTY_INBOX_ACC };
const same = (got: any[]) => expect(got.map((e) => hex(e.payload))).toEqual(payloads.map(hex));

describe("reading inbox posts through wrappers", () => {
  it("the RDK fetcher reads top-level posts but is blinded by a single authz MsgExec", async () => {
    same(await fetchQledgerEntries(restFor(SHAPES["top level"]), input as any));
    await expect(fetchQledgerEntries(restFor(SHAPES["authz MsgExec"]), input as any)).rejects.toThrow(/could not be matched/);
  });

  for (const name of ["top level", "authz MsgExec", "MsgExec inside MsgExec", "group proposal", "unknown wrapper field"]) {
    it(`robustRest + RDK reads a post delivered as: ${name}`, async () => {
      same(await fetchQledgerEntries(robustRest(restFor(SHAPES[name])), input as any));
    });
  }

  it("robustRest + RDK cannot see inside a wrapper the node could not decode (this is why a second reader exists)", async () => {
    await expect(fetchQledgerEntries(robustRest(restFor(SHAPES["wrapper the node could not decode"])), input as any)).rejects.toThrow();
  });

  for (const name of Object.keys(SHAPES)) {
    it(`the independent reader reads a post delivered as: ${name}`, async () => {
      same(await fetchEntriesIndependent(restFor(SHAPES[name]), input));
    });
  }

  it("the independent reader refuses a transaction that carries different bytes than the chain committed to", async () => {
    await expect(fetchEntriesIndependent(restFor(SHAPES["authz MsgExec"], { tamper: true }), input)).rejects.toThrow(/not anywhere in transaction/);
  });

  it("both readers refuse a range that disagrees with the chain's inbox accumulator", async () => {
    await expect(fetchEntriesIndependent(restFor(SHAPES["top level"], { badAcc: true }), input)).rejects.toThrow(/accumulator/);
    await expect(fetchQledgerEntries(robustRest(restFor(SHAPES["top level"], { badAcc: true })), input as any)).rejects.toThrow(/accumulator/);
  });
});

describe("pruned accumulator records", () => {
  // The node prunes old posted-data records: GET /posted_data/{rollup}/{seq} answers 404 for early
  // sequences. A fresh watcher must still check an old range, so the reader reads on to the inbox
  // head and checks the head's accumulator, which authenticates every entry before it.
  const pruned = (opts: { tamper?: boolean } = {}) => {
    const r = restFor(SHAPES["top level"], opts) as any;
    r.getPostedData = async () => { const e: any = new Error("REST GET /qorechain/rdk/v1/posted_data/x/2 failed: 404 Not Found"); e.status = 404; throw e; };
    return r as RestClient;
  };
  it("checks an old range against the head and returns only the range asked for", async () => {
    const got = await fetchEntriesIndependent(pruned(), { ...input, to: 2 });
    expect(got.map((e) => hex(e.payload))).toEqual(payloads.slice(0, 2).map(hex));
  });
  it("still refuses a tampered entry inside or after the range", async () => {
    await expect(fetchEntriesIndependent(pruned({ tamper: true }), { ...input, to: 2 })).rejects.toThrow();
  });
});

describe("incremental transaction search", () => {
  // a node that honours `AND tx.height>=N`, ascending, capped like the RDK's searchTxs (limit x pages)
  function node(cap: number) {
    const all: any[] = [];
    const calls: { q: string; n: number }[] = [];
    const rest = {
      searchTxs: async (q: string) => {
        const m = / AND tx\.height>=(\d+)$/.exec(q);
        const minH = m ? Number(m[1]) : 0;
        const res = all.filter((t) => Number(t.height) >= minH).slice(0, cap);
        calls.push({ q, n: res.length });
        return structuredClone(res);
      },
    } as unknown as RestClient;
    const add = (h: number) => all.push({ txhash: `H${all.length}`, height: String(h), tx: { body: { messages: [] } }, events: [] });
    return { rest, add, calls };
  }

  it("downloads each search once, then only what is new", async () => {
    const { rest, add, calls } = node(5_000);
    for (let h = 1; h <= 50; h++) add(h);
    const r = robustRest(rest);
    expect((await r.searchTxs("x")).length).toBe(50);
    for (let h = 51; h <= 53; h++) add(h);
    await new Promise((res) => setTimeout(res, 2_100)); // past the freshness window
    expect((await r.searchTxs("x")).length).toBe(53);
    expect(calls[1].q).toBe("x AND tx.height>=50");
    expect(calls[1].n).toBe(4); // height 50 again (deduplicated) plus 51..53
  }, 10_000);

  it("follows a search past the node's result cap instead of silently truncating", async () => {
    const { rest, add, calls } = node(10); // the node returns at most 10 = pageLimit 5 x maxPages 2
    for (let h = 1; h <= 35; h++) add(h);
    expect((await robustRest(rest).searchTxs("y", { pageLimit: 5, maxPages: 2 } as any)).length).toBe(35);
    expect(calls.length).toBe(4); // 1..10, then from 10, 19 and 28
  });
});
