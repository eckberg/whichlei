import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { parseCodes } from "../src/codes.ts";
import { renderRecordPage } from "../src/record.ts";
import { parsedRecord } from "../src/test-helpers.ts";

const ERICSSON = "549300W9JLPW15XIFM52";

// These need no GLEIF: the Worker answers before it would call it.
test("redirects a lower-case LEI to the canonical URL", async ({ request }) => {
  const response = await request.get(`/lei/${ERICSSON.toLowerCase()}`, { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(new URL(response.headers().location ?? "").pathname).toBe(`/lei/${ERICSSON}`);
});

test("redirects spaces around the LEI", async ({ request }) => {
  const response = await request.get(`/lei/%20${ERICSSON}%20`, { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(new URL(response.headers().location ?? "").pathname).toBe(`/lei/${ERICSSON}`);
});

test("answers 404 for an LEI whose check digits do not match", async ({ page }) => {
  const response = await page.goto("/lei/549300W9JLPW15XIFM51");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("check digits do not match")).toBeVisible();
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'none'");
});

test("answers 404 for something that is not an LEI", async ({ request }) => {
  const response = await request.get("/lei/nonsense");
  expect(response.status()).toBe(404);
});

test("keeps crawlers out until launch", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /");
  const page = await request.get("/lei/549300W9JLPW15XIFM51");
  expect(page.headers()["x-robots-tag"]).toBe("noindex");
});

test("leaves the home page to the static assets", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const style = await request.get("/styles/record.css");
  expect(style.status()).toBe(200);
  expect(style.headers()["content-type"]).toContain("text/css");
});

// The page the Worker renders, served from a route: its stylesheet and scripts are the site's.
// The Worker's own calls to GLEIF cannot be mocked from the browser, so these tests give the
// browser the page the renderer makes from a recorded record and the fixture codes.
test.describe("record page with names and copy json", () => {
  const codes = parseCodes(
    JSON.parse(readFileSync(new URL("../fixtures/codes.json", import.meta.url), "utf8")),
  );

  async function open(page: import("@playwright/test").Page) {
    const record = await parsedRecord("record-ericsson");
    await page.route(`**/lei/${ERICSSON}`, async (route) => {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: renderRecordPage(record, { canonicalOrigin: "http://localhost:8787", codes }),
      });
    });
    await page.goto(`/lei/${ERICSSON}`);
    return record;
  }

  test("shows the legal form and the register by name, with the codes beside them", async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator('[data-field="legal-form"]')).toHaveText("Aktiebolag XJHM");
    await expect(page.locator('[data-field="register"]')).toHaveText(
      "556016-0680 Bolagsverket · RA000544",
    );
  });

  test("copies the normalised record as JSON", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const record = await open(page);
    await page.getByRole("button", { name: "copy json" }).click();
    await expect(page.getByRole("status")).toHaveText("copied json");
    const copied = await page.evaluate("navigator.clipboard.readText()");
    expect(JSON.parse(copied as string)).toEqual(JSON.parse(JSON.stringify(record)));
    // Readable: indented, one field to a line.
    expect(copied).toContain('\n  "lei": "549300W9JLPW15XIFM52"');
    await context.close();
  });

  test("shows no copy json button without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await open(page);
    await expect(page.getByRole("button", { name: "copy json" })).toBeHidden();
    await expect(page.locator("h1")).toHaveText(ERICSSON);
    await context.close();
  });
});

// A real record needs the real GLEIF API, so this runs only against a deployed site
// (BASE_URL, as in the deploy workflow).
test.describe("live record", () => {
  test.skip(!process.env.BASE_URL, "needs BASE_URL: a deployed site that can reach GLEIF");

  test("renders Ericsson without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto(`/lei/${ERICSSON}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Telefonaktiebolaget LM Ericsson · LEI 549300W9JLPW15XIFM52/);
    await expect(page.locator("h1")).toHaveText(ERICSSON);
    await expect(page.getByText("Telefonaktiebolaget LM Ericsson").first()).toBeVisible();
    await expect(page.locator('[data-field="status"]')).toContainText("active");
    await expect(page.locator('[data-field="golden-copy"]')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    // The names of the codes come from the published index.
    await expect(page.locator('[data-field="legal-form"]')).toContainText("Aktiebolag");
    await expect(page.locator('[data-field="register"]')).toContainText("Bolagsverket");
    await expect(page.getByRole("button", { name: "copy lei" })).toBeHidden();
    await context.close();
  });

  test("shows a copy button that copies the LEI", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await page.goto(`/lei/${ERICSSON}`);
    await page.getByRole("button", { name: "copy lei" }).click();
    await expect(page.getByRole("status")).toContainText(`copied ${ERICSSON}`);
    expect(await page.evaluate("navigator.clipboard.readText()")).toBe(ERICSSON);
    await context.close();
  });

  test("sends the cache and security headers", async ({ request }) => {
    const response = await request.get(`/lei/${ERICSSON}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["x-robots-tag"]).toBe("noindex");
  });

  test("answers 404 for a well-formed LEI that GLEIF does not have", async ({ request }) => {
    const response = await request.get("/lei/549300ZZZZZZZZZZZZ46");
    expect(response.status()).toBe(404);
    expect(await response.text()).toContain("No such LEI");
  });
});
