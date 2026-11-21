// The receipt checker and the pool page, end to end. Both read the public testnet.
import { expect, test } from "@playwright/test";
import { createQorexMock } from "@qorechain/qorex-wallet-mock";

test("receipt checker: a published receipt verifies, a forged copy does not", async ({ page }) => {
  await page.goto("/receipt");
  const verifyButton = page.getByRole("button", { name: "Verify against the chain" });
  await expect(verifyButton).toBeEnabled();

  await verifyButton.click();
  await expect(page.getByText("Valid: reproduced from live chain state")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await expect(page.locator("tbody .pill.ok")).toHaveCount(6);

  await page.getByRole("button", { name: "Try a forged copy" }).click();
  await expect(page.getByText("Not valid", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("tbody tr").filter({ hasText: "Batch state root" }).locator(".pill.bad")).toBeVisible();
});

test("pool: liquidity history is read from chain events, and a deposit explains what QoreX cannot do yet", async ({ page }) => {
  await page.addInitScript({ content: createQorexMock({ profile: "current" }).initScript() });
  await page.goto("/pool");

  // history: the live pool's first deposit is in the table and the chart is drawn
  await expect(page.locator(".chart svg")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("tbody tr").filter({ hasText: "deposit" }).first()).toBeVisible();

  // a deposit needs an EVM transaction, which QoreX (and its mock, profile "current") cannot send yet
  await page.getByRole("button", { name: "Connect Wallet" }).click();
  await page.getByRole("dialog").getByText("QoreX", { exact: true }).click();
  await page.getByLabel("QOR to deposit").fill("1");
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  await expect(page.locator(".banner.warn")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".banner.warn")).toContainText("QoreX cannot send EVM transactions yet");
});
