import { expect, type Page, type Request, test } from "@playwright/test";

// The live check (docs/specs/11-launch.md): one visit to the canonical host, in a browser, with
// Fathom let in. Runs only with LIVE_URL (`LIVE_URL=https://whichlei.com pnpm e2e live`), and
// is not part of the regular runs, which block Fathom.
//
//   search "ericsson", wait for the event, copy, open the record, back, open about.
//   No cookie anywhere. No CSP violation. Fathom sees `/`, `/lei/` and one `search` event,
//   and nothing in any request to it holds the query or the LEI.
//
// Fathom's page views are images and its events beacons, all to cdn.usefathom.com. The check
// answers every one of them itself (nothing is counted) when Playwright can intercept them,
// and lets them through when it cannot: a few views per deploy.

const LIVE_URL = process.env.LIVE_URL;
const FATHOM = "cdn.usefathom.com";
const SITE_ID = "IWPQIWKG";
const ERICSSON_LEI = "549300W9JLPW15XIFM52";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

test.skip(!LIVE_URL, "needs LIVE_URL: the canonical host, such as https://whichlei.com");

interface FathomCall {
  url: URL;
  body: string;
}

test("the live site: no cookies, no CSP violations, Fathom sees pages and one search", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: LIVE_URL as string });
  const page = await context.newPage();

  // Every request to Fathom: its script is let through, the rest is answered here.
  const calls: FathomCall[] = [];
  let intercepted = 0;
  await context.route(`https://${FATHOM}/**`, async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/script.js") {
      await route.continue();
      return;
    }
    intercepted++;
    await route.fulfill({ status: 200, contentType: "image/gif", body: GIF });
  });
  context.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (url.hostname === FATHOM && url.pathname !== "/script.js") {
      calls.push({ url, body: request.postData() ?? "" });
    }
  });

  // Set-Cookie on any response, from any host.
  const cookieHeaders: string[] = [];
  const pending: Promise<void>[] = [];
  context.on("response", (response) => {
    pending.push(
      response
        .headerValue("set-cookie")
        .then((value) => {
          if (value) cookieHeaders.push(`${response.url()}: ${value}`);
        })
        .catch(() => {}),
    );
  });

  // Console messages that name the CSP, and page errors.
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy|refused to (load|connect|execute|apply)/i.test(text)) {
      violations.push(text);
    }
  });
  page.on("pageerror", (error) => violations.push(error.message));

  // Documents of the search page that loaded: each runs the loader, so each sends a page view.
  let searchLoads = 0;
  page.on("domcontentloaded", () => {
    if (new URL(page.url()).pathname === "/") searchLoads++;
  });

  // Fathom's leave pings (sent on pagehide, and not answerable by a route) would count a real
  // view. It honours localStorage.blockFathomTracking, so each page sets it just before it is
  // left, and each new document clears it before Fathom's script runs.
  await context.addInitScript(() => {
    try {
      localStorage.removeItem("blockFathomTracking");
    } catch {
      // No storage: nothing to clear.
    }
  });
  const leaving = (on: Page) =>
    on.evaluate(() => localStorage.setItem("blockFathomTracking", "true"));

  const noCookie = async (where: string, on: Page) => {
    expect(await on.evaluate(() => document.cookie), `document.cookie on ${where}`).toBe("");
  };
  const views = (path: string) =>
    calls.filter(
      ({ url }) =>
        url.searchParams.has("p") &&
        !url.searchParams.has("name") &&
        !url.searchParams.has("dp") &&
        url.searchParams.get("sid") === SITE_ID &&
        url.searchParams.get("p") === path,
    );
  const events = () => calls.filter(({ url }) => url.searchParams.get("name") === "search");

  // The search page.
  await page.goto("/");
  await expect(page.locator("#meta")).toContainText("index:");
  await expect.poll(() => views("/").length, { message: "page view of /" }).toBe(1);
  await noCookie("the search page", page);
  // The loader stripped the query: an address with one is left clean.
  await leaving(page);
  await page.goto("/?q=ericsson&utm_source=check");
  await expect(page.locator("#meta")).toContainText("index:");
  expect(new URL(page.url()).search).toBe("");
  await expect.poll(() => views("/").length, { message: "page view of / again" }).toBe(2);

  // Search, wait for the event (2 s after the results), copy, open the record.
  const box = page.getByRole("combobox");
  await box.fill("ericsson");
  await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON_LEI);
  await expect.poll(() => events().length, { timeout: 10_000 }).toBe(1);
  await page.keyboard.press("Enter");
  await expect(page.locator("#info")).toContainText(`copied ${ERICSSON_LEI}`);
  await noCookie("the search page after a search", page);

  await leaving(page);
  const recordResponse = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" &&
      new URL(response.url()).pathname === `/lei/${ERICSSON_LEI}`,
  );
  await page.getByRole("link", { name: "open record" }).click();
  await expect(page).toHaveURL(new RegExp(`/lei/${ERICSSON_LEI}$`));
  await expect(page.locator("h1")).toHaveText(ERICSSON_LEI);
  // Not degraded: a page built without the index's code names has a shorter max-age and shows
  // only codes. The apex's Worker reads the index host over the public internet; if that fails
  // the page still renders, which only these two checks would show.
  const record = await recordResponse;
  expect(record.status()).toBe(200);
  expect(await record.headerValue("cache-control")).toBe("public, max-age=3600");
  await expect(page.locator('[data-field="legal-form"]')).toContainText("Aktiebolag");
  await expect.poll(() => views("/lei/").length, { message: "page view of /lei/" }).toBe(1);
  await noCookie("the record page", page);

  // Back, then about.
  await leaving(page);
  await page.goBack();
  await expect(page.locator("#meta")).toContainText("index:");
  await noCookie("the search page after back", page);
  await expect.poll(() => views("/").length, { message: "page view after back" }).toBe(searchLoads);
  await page.getByRole("button", { name: "about" }).click();
  await expect(page.locator("#man")).toContainText("PRIVACY");
  await noCookie("the about page", page);
  await leaving(page);

  await Promise.all(pending);

  // No cookie, in the jar or on the wire.
  expect(await context.cookies()).toEqual([]);
  expect(cookieHeaders).toEqual([]);
  expect(violations).toEqual([]);

  // Fathom: `/` once for each time the search page loaded (going back reloads it here: the
  // test browser keeps no back/forward cache), `/lei/` once, one search, and nothing else.
  expect(views("/").length).toBe(searchLoads);
  expect(views("/lei/")).toHaveLength(1);
  expect(events()).toHaveLength(1);
  for (const { url, body } of calls) {
    const text = decodeURIComponent(`${url.search}${body}`).toLowerCase();
    expect(text).not.toContain("ericsson");
    expect(text).not.toContain(ERICSSON_LEI.toLowerCase());
    expect(url.searchParams.get("sid") ?? SITE_ID).toBe(SITE_ID);
  }
  console.log(
    `fathom: ${calls.length} requests, ${intercepted} answered by the check, ` +
      `${calls.length - intercepted} let through`,
  );
});
