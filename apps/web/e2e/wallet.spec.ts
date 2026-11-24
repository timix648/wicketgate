// The wallet end to end with the QoreX wallet mock (frontend brief, sections 8.6 and 11).
//
// The mock injects what QoreX injects (window.qorex = { evm, native, svm }) and signs for real,
// with the public test mnemonic: it holds no funds, so nothing here can move money. The deposit is
// rejected in the mock before anything is broadcast. The relay and exit-relay queues are answered by
// this test, so it never reaches Redis or the team's operator; chain reads go to the public testnet.
import { expect, test, type Page } from "@playwright/test";
import { createQorexMock } from "@qorechain/qorex-wallet-mock";
import { decodeQledgerTx, hexToBech32, verifyQledgerTx } from "@qorechain/rdk";

const PASSPHRASE = "e2e-test-passphrase";
const ROLLUP = "wicketgate-pay";

/** A hash or address as the page shows it (shortened text, full value in its title). */
const shown = (page: Page, value: string) => page.locator(`.hash[title="${value}"]`).first();

/** What the page has stored in IndexedDB for its rollup account(s). */
async function storedRecords(page: Page): Promise<any[]> {
  return page.evaluate(
    () =>
      new Promise<any[]>((resolve, reject) => {
        const open = indexedDB.open("wicketgate", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction("rollup-accounts").objectStore("rollup-accounts").getAll();
          req.onsuccess = () => {
            open.result.close();
            resolve(req.result);
          };
        };
      }),
  );
}

test("connect QoreX, create a rollup account, deposit (rejected), withdraw instantly", async ({ page }) => {
  const mock = createQorexMock({ profile: "current" });
  await page.addInitScript({ content: mock.initScript() });

  // ---- the queues, answered here
  const relayBodies: { rollupId: string; tx: string }[] = [];
  const exitBodies: { rollupId: string; sealed: string }[] = [];
  let saltsStoredBeforeRelay: string[] | undefined;

  await page.route("**/api/relay", async (route) => {
    // The exit's salt must already be in IndexedDB when the withdrawal leaves the browser.
    saltsStoredBeforeRelay = (await storedRecords(page)).flatMap((r) => r.exits.map((e: any) => e.salt));
    relayBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { queued: true, id: "relay-1" } });
  });
  await page.route("**/api/exit", async (route) => {
    exitBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { queued: true, id: "exit-1" } });
  });
  let relayStatus = { status: "queued" } as Record<string, string>;
  let exitStatus = { status: "queued" } as Record<string, string>;
  await page.route("**/api/relay/relay-1", (route) => route.fulfill({ json: relayStatus }));
  await page.route("**/api/exit/exit-1", (route) => route.fulfill({ json: exitStatus }));

  await page.goto("/wallet");
  const addresses = await page.evaluate(() => (window as any).__qorexMock.addresses());

  // ---- 1. connect QoreX through @qorechain/qorex-rainbowkit
  await page.getByRole("button", { name: "Connect Wallet" }).click();
  const dialog = page.getByRole("dialog");
  // The QoreX entry from @qorechain/qorex-rainbowkit (not the auto-discovered "QoreX (mock)" one).
  await dialog.getByText("QoreX", { exact: true }).click();
  await expect(shown(page, addresses.evm)).toBeVisible();
  await expect(shown(page, addresses.native)).toBeVisible();

  // ---- 2. create the rollup account (fresh random seed, encrypted in IndexedDB)
  await page.getByPlaceholder(/Passphrase \(at least/).fill(PASSPHRASE);
  await page.getByPlaceholder("Passphrase again").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Create rollup account" }).click();
  await expect(page.getByRole("button", { name: "Download backup" })).toBeVisible();

  const [record] = await storedRecords(page);
  expect(record.accountId).toMatch(/^[0-9a-f]{64}$/);
  expect(record.kdf).toEqual({ name: "PBKDF2", hash: "SHA-256", iterations: 600_000 });
  expect(JSON.stringify(record)).not.toMatch(/secretKey|seed"/);
  await expect(shown(page, record.accountId)).toBeVisible();

  // lock, refuse a wrong passphrase, unlock the same account
  await page.getByRole("button", { name: "Lock" }).click();
  await page.getByPlaceholder("Passphrase", { exact: true }).fill("not-the-passphrase");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText(/Wrong passphrase/)).toBeVisible();
  await page.getByPlaceholder("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(shown(page, record.accountId)).toBeVisible();

  // ---- 3. deposit: QoreX is asked to sign MsgDepositToRollup; the user rejects it
  await page.evaluate(() => {
    const m = (window as any).__qorexMock;
    m.clearRequests();
    m.rejectNext();
  });
  await page.getByLabel("Amount in QOR").fill("1");
  await page.getByRole("button", { name: "Deposit with QoreX" }).click();
  await expect(page.getByText(/rejected/i)).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__qorexMock.requests);
  const sign = calls.find((c: any) => c.method === "native:signAndBroadcast");
  expect(sign?.approval).toBe("rejected");
  const req = typeof sign.params === "string" ? JSON.parse(sign.params) : sign.params;
  expect(req.chainId).toBe("qorechain-diana");
  expect(req.messages).toHaveLength(1);
  expect(req.messages[0].typeUrl).toBe("/qorechain.rdk.v1.MsgDepositToRollup");

  // ---- 4. withdraw instantly: estimate, sign with the rollup key, relay, exit relay
  await page.getByRole("tab", { name: "Withdraw instantly" }).click();
  await page.getByLabel("Amount in QOR").fill("2");
  await expect(page.getByText("You receive").first()).toBeVisible(); // fee and payout read from the pool
  await expect(page.getByText(/^Cheapest of \d+ pools?:/)).toBeVisible(); // the routed choice is shown before signing
  await page.getByRole("button", { name: "Withdraw instantly" }).click();
  await expect(page.getByText(/Queued for an instant exit to/)).toBeVisible();
  // every step is shown, including the sealing to the operator's ML-KEM-1024 key
  await expect(page.getByText("Sealed ✓ (the relay only sees ciphertext)")).toBeVisible();
  await expect(page.getByText("Sealed ✓ ML-KEM-1024 + X25519").first()).toBeVisible();

  // the withdrawal posted to the relay: one valid qledger-v1 transaction for this rollup,
  // signed by this account, paying the exit address the pool computed for (EVM address, salt)
  expect(relayBodies).toHaveLength(1);
  expect(relayBodies[0].rollupId).toBe(ROLLUP);
  const tx = decodeQledgerTx(relayBodies[0].tx);
  expect(tx).toBeDefined();
  expect(verifyQledgerTx(tx!, "qorechain-diana", ROLLUP)).toBe(true);
  expect(tx!.amount).toBe(2_000_000n);

  const [after] = await storedRecords(page);
  expect(after.exits).toHaveLength(1);
  const exit = after.exits[0];
  expect(tx!.recipient).toBe(hexToBech32(exit.exitAddr, "qor"));
  expect(saltsStoredBeforeRelay).toContain(exit.salt);

  // the exit request: paid to the user's own EVM address, with the stored salt
  // The exit request left the browser sealed to the operator's ML-KEM-1024 key: only the rollup id is in the clear.
  expect(exitBodies).toHaveLength(1);
  expect(Object.keys(exitBodies[0]).sort()).toEqual(["rollupId", "sealed"]);
  expect(exitBodies[0].rollupId).toBe(ROLLUP);
  expect(exitBodies[0].sealed).toMatch(/^qoreseal:/);
  for (const secret of [addresses.evm.slice(2), exit.salt.slice(2)]) expect(exitBodies[0].sealed.toLowerCase()).not.toContain(secret.toLowerCase());
  expect(after.nextNonce[ROLLUP]).toBe("1");

  // "What the server saw" shows exactly the body /api/exit received
  await page.getByRole("button", { name: "What the server saw" }).first().click();
  await expect(page.locator(".ciphertext").first()).toHaveText(JSON.stringify(exitBodies[0]));

  // ---- 5. progress follows the queues
  relayStatus = { status: "posted", txHash: "A".repeat(64) };
  exitStatus = { status: "paid", txHash: `0x${"b".repeat(64)}` };
  await expect(page.getByText("Posted to the rollup")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Paid to your EVM address")).toBeVisible({ timeout: 30_000 });

  // ---- 6. send the paid exit on to Osmosis in one QoreX signature (rejected in the mock: nothing is broadcast)
  await page.evaluate(() => {
    const m = (window as any).__qorexMock;
    m.clearRequests();
    m.rejectNext();
  });
  await page.getByLabel("Amount to send on, in QOR").fill("1.5");
  await page.getByRole("button", { name: "Send to Osmosis testnet" }).click();
  await expect(page.getByText(/rejected/i).last()).toBeVisible();
  const ibcCalls = await page.evaluate(() => (window as any).__qorexMock.requests);
  const ibc = ibcCalls.find((c: any) => c.method === "native:signAndBroadcast");
  const ibcReq = typeof ibc.params === "string" ? JSON.parse(ibc.params) : ibc.params;
  const msg = ibcReq.messages[0];
  expect(msg.typeUrl).toBe("/ibc.applications.transfer.v1.MsgTransfer");
  const { MsgTransfer } = await import("cosmjs-types/ibc/applications/transfer/v1/tx");
  const raw = typeof msg.value === "string" ? Buffer.from(msg.value, "base64") : Uint8Array.from(Object.values(msg.value) as number[]);
  const t = MsgTransfer.decode(raw);
  expect(t.sourceChannel).toBe("channel-1");
  expect(t.token?.denom).toBe("uqor");
  expect(t.token?.amount).toBe("1500000");
  expect(t.sender).toBe(addresses.native);
  expect(t.receiver).toMatch(/^osmo1[02-9ac-hj-np-z]{38}$/);
});

