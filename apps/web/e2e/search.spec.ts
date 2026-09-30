import { expect, test } from "@playwright/test";

const ERICSSON = "549300W9JLPW15XIFM52";

test("serves the page with security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});

test("finds Ericsson by name", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox").fill("ericsson");
  await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
});

test("finds Ericsson by LEI", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox").fill(ERICSSON.toLowerCase());
  await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
});

test("answers unknown paths with 404", async ({ request }) => {
  const response = await request.get("/no-such-page");
  expect(response.status()).toBe(404);
});
