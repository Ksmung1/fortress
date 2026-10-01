import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});

const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", error => errors.push(error.message));

try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await page.getByRole("heading", { name: "Sign in to FORTRESS" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Record transaction" }).count(), 0, "Finance workspace must not render before login");
  await page.getByLabel("Email address").fill("person@example.com");
  await page.getByLabel("Password", { exact: true }).fill("secret123");
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("type"), "password");
  await page.getByRole("button", { name: "Show password" }).click();
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("type"), "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("type"), "password");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByRole("heading", { name: "Create your account" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Close dialog" }).count(), 0, "Required login cannot be dismissed");

  assert.equal(errors.length, 0, `Browser errors: ${errors.join(" | ")}`);
  console.log("Smoke test passed: login gate blocks finance access and password visibility controls work.");
} finally {
  await browser.close();
}
