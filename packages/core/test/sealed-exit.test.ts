// Sealed exit requests: only the operator's key opens them, and an envelope moved to another
// rollup, pool or chain, or altered in any byte, does not open. (The live check against the
// operator's real on-chain key and signed card is `pnpm sealexit` in packages/scripts.)
import { describe, expect, it } from "vitest";
import { envelopeToText, generateSealKeys, seal } from "@qorechain/qoreseal";
import { EXIT_REQUEST_PURPOSE, checkExitRequest, exitRequestAad, isSealedExitText, openExitRequest } from "../src/sealed-exit.ts";

const CHAIN = "qorechain-diana";
const POOL = "0x8ea2ae9d7182261398f62d9ee8be9648025805b4";
const REQ = { rollupId: "wicketgate-pay", beneficiary: "0x1111111111111111111111111111111111111111", salt: `0x${"ab".repeat(32)}`, amountUqor: "2000000" };

function sealTo(keys: ReturnType<typeof generateSealKeys>, req: object = REQ, aad = exitRequestAad(CHAIN, REQ.rollupId, POOL), mode: "hybrid" | "mlkem" = "hybrid") {
  return envelopeToText(seal({
    chainId: CHAIN, purpose: EXIT_REQUEST_PURPOSE, anonymous: true, mode, aad,
    recipients: [{ mlkemPublicKey: keys.mlkemPublicKey, ...(mode === "hybrid" ? { x25519PublicKey: keys.x25519PublicKey } : {}) }],
    plaintext: new TextEncoder().encode(JSON.stringify(req)),
  }));
}

describe("sealed exit requests", () => {
  const op = generateSealKeys();
  const text = sealTo(op);

  it("opens for the operator and returns the request", () => {
    expect(isSealedExitText(text)).toBe(true);
    expect(openExitRequest({ text, keys: op, chainId: CHAIN, rollupId: REQ.rollupId, pool: POOL })).toEqual(REQ);
  });

  it("leaks nothing in the clear", () => {
    for (const s of [REQ.beneficiary.slice(2), REQ.salt.slice(2, 20), REQ.amountUqor, REQ.rollupId]) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
  });

  it("does not open with another key", () => {
    expect(() => openExitRequest({ text, keys: generateSealKeys(), chainId: CHAIN, rollupId: REQ.rollupId, pool: POOL })).toThrow();
  });

  it("does not open when moved to another rollup, pool or chain", () => {
    expect(() => openExitRequest({ text, keys: op, chainId: CHAIN, rollupId: "vigil-pay-1", pool: POOL })).toThrow();
    expect(() => openExitRequest({ text, keys: op, chainId: CHAIN, rollupId: REQ.rollupId, pool: `0x${"22".repeat(20)}` })).toThrow();
    expect(() => openExitRequest({ text, keys: op, chainId: "qorechain-mainnet", rollupId: REQ.rollupId, pool: POOL })).toThrow();
  });

  it("refuses a request whose sealed rollup disagrees with the queue's", () => {
    const t = sealTo(op, { ...REQ, rollupId: "vigil-pay-1" }); // bound to wicketgate-pay but says vigil-pay-1 inside
    expect(() => openExitRequest({ text: t, keys: op, chainId: CHAIN, rollupId: REQ.rollupId, pool: POOL })).toThrow(/another rollup/);
  });

  it("rejects any altered byte", () => {
    const body = text.slice(text.indexOf(":") + 1);
    for (const at of [10, Math.floor(body.length / 2), body.length - 5]) {
      const c = body[at] === "A" ? "B" : "A";
      const bad = text.slice(0, text.indexOf(":") + 1) + body.slice(0, at) + c + body.slice(at + 1);
      expect(() => openExitRequest({ text: bad, keys: op, chainId: CHAIN, rollupId: REQ.rollupId, pool: POOL })).toThrow();
    }
  });

  it("the relay's shape check refuses junk, oversize and ML-KEM-only envelopes", () => {
    expect(isSealedExitText("qoreseal:nope")).toBe(false);
    expect(isSealedExitText(42)).toBe(false);
    expect(isSealedExitText(text + "A".repeat(9000))).toBe(false);
    expect(isSealedExitText(sealTo(op, REQ, undefined, "mlkem"))).toBe(false);
  });

  it("validates the request fields", () => {
    expect(checkExitRequest({ ...REQ, salt: "0x12" })).toMatch(/salt/);
    expect(checkExitRequest({ ...REQ, amountUqor: "0" })).toMatch(/amountUqor/);
    expect(checkExitRequest({ ...REQ, beneficiary: "qor1x" })).toMatch(/beneficiary/);
  });
});
