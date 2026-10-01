import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { parseCodes } from "../src/codes.ts";
import { renderRecordPage } from "../src/record.ts";
import { parsedRecord } from "../src/test-helpers.ts";
import { mockGleif } from "./gleif.ts";

const ERICSSON = "549300W9JLPW15XIFM52";
const FATHOM = "cdn.usefathom.com";

// Analytics run on the canonical host only (DESIGN.md decision 30). Here, on localhost or
// workers.dev, the loader is served and does nothing: no request reaches Fathom, which the
// Playwright config also blocks at the browser, so a test cannot count a page view by mistake.

function watchFathom(page: Page) {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === FATHOM) asked.push(request.url());
  });
  return asked;
}

test("serves the stats loader and asks Fathom for nothing on the search page", async ({ page }) => {
  const asked = watchFathom(page);
  const loader = page.waitForResponse((response) => response.url().endsWith("/scripts/stats.js"));
  await page.goto("/");
  expect((await loader).status()).toBe(200);
  // Past the 2 s a search takes to settle, so a counter that sent would have by now.
  await page.waitForTimeout(2500);
  expect(await page.evaluate("typeof window.fathom")).toBe("undefined");
  expect(await page.evaluate("document.querySelectorAll('script[src*=usefathom]').length")).toBe(0);
  expect(asked).toEqual([]);
});

test("asks Fathom for nothing on a record page", async ({ page }) => {
  const asked = watchFathom(page);
  const codes = parseCodes(
    JSON.parse(readFileSync(new URL("../fixtures/codes.json", import.meta.url), "utf8")),
  );
  const record = await parsedRecord("record-ericsson");
  await page.route(`**/lei/${ERICSSON}`, async (route) => {
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: renderRecordPage(record, { canonicalOrigin: "http://localhost:8787", codes }),
    });
  });
  const loader = page.waitForResponse((response) => response.url().endsWith("/scripts/stats.js"));
  await page.goto(`/lei/${ERICSSON}`);
  expect((await loader).status()).toBe(200);
  await page.waitForTimeout(500);
  expect(await page.evaluate("typeof window.fathom")).toBe("undefined");
  expect(asked).toEqual([]);
});

test.describe("a search", () => {
  test.skip(!!process.env.BASE_URL, "needs the fixture index of a local run");

  test("counts nothing off the canonical host: type, wait, copy, open", async ({ page }) => {
    await mockGleif(page.context());
    const asked = watchFathom(page);
    await page.goto("/");
    await expect(page.locator("#meta")).toContainText("index:");
    await page.getByRole("combobox").fill("telefonaktiebolaget");
    await expect(page.locator("#opt-0")).toBeVisible();
    await page.waitForTimeout(2500);
    await page.keyboard.press("Enter");
    await expect(page.locator("#info")).toContainText("copied");
    expect(asked).toEqual([]);
  });
});
