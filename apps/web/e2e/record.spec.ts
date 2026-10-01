import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { parseCodes } from "../src/codes.ts";
import { renderRecordPage } from "../src/record.ts";
import { buildDocument } from "../src/record-document.ts";
import { parsedRecord } from "../src/test-helpers.ts";

const ERICSSON = "549300W9JLPW15XIFM52";
const BAD_DIGITS = "549300W9JLPW15XIFM51";

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

// The same record as JSON and Markdown: `.json` and `.md`, or `Accept` on the page's own URL.
test("redirects a lower-case LEI to the canonical URL, keeping .json and .md", async ({
  request,
}) => {
  for (const extension of [".json", ".md"]) {
    const response = await request.get(`/lei/${ERICSSON.toLowerCase()}${extension}`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(301);
    expect(new URL(response.headers().location ?? "").pathname).toBe(
      `/lei/${ERICSSON}${extension}`,
    );
  }
});

test("answers a bad LEI as JSON, as Markdown, or as HTML, by extension or by Accept", async ({
  request,
}) => {
  const json = await request.get(`/lei/${BAD_DIGITS}.json`);
  expect(json.status()).toBe(404);
  expect(json.headers()["content-type"]).toBe("application/json; charset=utf-8");
  expect(await json.json()).toMatchObject({ error: "Not a valid LEI" });
  expect(json.headers()["x-robots-tag"]).toBe("noindex");
  // The canonical URL is on CANONICAL_ORIGIN, not on the host asked.
  expect(json.headers().link).toMatch(
    new RegExp(`^<https?://[^/]+/lei/${BAD_DIGITS}>; rel="canonical"$`),
  );

  const markdown = await request.get(`/lei/${BAD_DIGITS}.md`);
  expect(markdown.status()).toBe(404);
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await markdown.text()).toMatch(/^# Not a valid LEI\n\n/);

  const accept = (value: string) =>
    request.get(`/lei/${BAD_DIGITS}`, { headers: { accept: value } });
  for (const [value, type] of [
    ["application/json", "application/json; charset=utf-8"],
    ["text/markdown", "text/markdown; charset=utf-8"],
    ["text/html", "text/html; charset=utf-8"],
    ["*/*", "text/html; charset=utf-8"],
  ] as const) {
    const response = await accept(value);
    expect(response.status(), value).toBe(404);
    expect(response.headers()["content-type"], value).toBe(type);
    // The page's URL answers in several formats: caches must keep them apart.
    expect(response.headers().vary, value).toBe("accept");
  }
});

test("keeps crawlers out of a host that is not the canonical one", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
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
  const names = new Map([[ERICSSON, "Telefonaktiebolaget LM Ericsson"]]);

  async function open(page: import("@playwright/test").Page, fixture = "record-ericsson") {
    const record = await parsedRecord(fixture);
    await page.route(`**/lei/${record.lei}`, async (route) => {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: renderRecordPage(record, { canonicalOrigin: "http://localhost:8787", codes, names }),
      });
    });
    await page.goto(`/lei/${record.lei}`);
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

  test("shows a parent by name, linked to its page, with its LEI beside it", async ({ page }) => {
    await open(page, "record-subsidiary");
    const parent = page.locator('[data-field="parent"]');
    await expect(parent).toHaveText(`Telefonaktiebolaget LM Ericsson ${ERICSSON}`);
    await expect(parent.getByRole("link")).toHaveAttribute("href", `/lei/${ERICSSON}`);
    await expect(page.locator('[data-field="ultimate-parent"]')).toHaveText(
      `Telefonaktiebolaget LM Ericsson ${ERICSSON}`,
    );
  });

  test("heads the page with the LEI large and the name on its own line below", async ({ page }) => {
    await open(page);
    await expect(page.locator("h1")).toHaveText(`${ERICSSON} Telefonaktiebolaget LM Ericsson`);
    const lei = page.locator("h1 #lei");
    const name = page.locator("h1 .name");
    await expect(lei).toHaveText(ERICSSON);
    await expect(name).toHaveText("Telefonaktiebolaget LM Ericsson");
    const [leiBox, nameBox] = [await lei.boundingBox(), await name.boundingBox()];
    // One above the other, the name starting below the LEI's line.
    expect(nameBox?.y ?? 0).toBeGreaterThanOrEqual((leiBox?.y ?? 0) + (leiBox?.height ?? 0) - 1);
    const size = (locator: typeof lei) =>
      locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(await size(lei)).toBeGreaterThan(await size(name));
    expect(await lei.evaluate((element) => getComputedStyle(element).fontWeight)).toBe("700");
    expect(await name.evaluate((element) => getComputedStyle(element).fontWeight)).toBe("500");
  });

  test("links the icons, and not the JSON and Markdown URLs", async ({ page }) => {
    await open(page);
    await expect(page.locator('link[rel="icon"]')).toHaveCount(2);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      "href",
      "/apple-touch-icon.png",
    );
    await expect(page.locator('link[rel="alternate"]')).toHaveCount(0);
  });

  test("copies the record document as JSON", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const record = await open(page);
    await page.getByRole("button", { name: "copy json" }).click();
    await expect(page.getByRole("status")).toHaveText("copied json");
    const copied = await page.evaluate("navigator.clipboard.readText()");
    const doc = buildDocument(record, { canonicalOrigin: "http://localhost:8787", codes, names });
    expect(JSON.parse(copied as string)).toEqual(JSON.parse(JSON.stringify(doc)));
    // Readable: indented, one field to a line, the page's URL after the LEI.
    expect(copied).toContain(
      `{\n  "lei": "549300W9JLPW15XIFM52",\n  "url": "http://localhost:8787/lei/${ERICSSON}",`,
    );
    await context.close();
  });

  test("shows no copy json button without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await open(page);
    await expect(page.getByRole("button", { name: "copy json" })).toBeHidden();
    await expect(page.locator("#lei")).toHaveText(ERICSSON);
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
    await expect(page.locator("#lei")).toHaveText(ERICSSON);
    await expect(page.locator("h1")).toContainText("Telefonaktiebolaget LM Ericsson");
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

  test("answers the record as JSON, by extension and by Accept", async ({ request }) => {
    for (const response of [
      await request.get(`/lei/${ERICSSON}.json`),
      await request.get(`/lei/${ERICSSON}`, { headers: { accept: "application/json" } }),
    ]) {
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.headers()["x-robots-tag"]).toBe("noindex");
      const doc = await response.json();
      expect(doc.lei).toBe(ERICSSON);
      expect(doc.url).toMatch(new RegExp(`/lei/${ERICSSON}$`));
      expect(doc.legalName.name).toBe("Telefonaktiebolaget LM Ericsson");
      // Names for the codes come from the published index.
      expect(doc.legalForm.name).toBe("Aktiebolag");
      expect(doc.registrationAuthority.name).toBe("Bolagsverket");
    }
  });

  test("answers the record as Markdown, by extension and by Accept", async ({ request }) => {
    for (const response of [
      await request.get(`/lei/${ERICSSON}.md`),
      await request.get(`/lei/${ERICSSON}`, { headers: { accept: "text/markdown" } }),
    ]) {
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
      expect(response.headers()["x-robots-tag"]).toBe("noindex");
      const text = await response.text();
      expect(text).toMatch(new RegExp(`^# Telefonaktiebolaget LM Ericsson\n\nLEI: ${ERICSSON}\n`));
      expect(text).toContain("- **status:** active");
    }
  });
});
