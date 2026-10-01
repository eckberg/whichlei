import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_ORIGIN } from "./env.ts";

const ERICSSON = "549300W9JLPW15XIFM52";
// Valid check digits, and the same code with the last digit changed.
const VALID_LEI = "HWUPKR0MPOU8FGXBT394";
const BAD_LEI = "HWUPKR0MPOU8FGXBT395";
// Bad check digits, and no name in the fixture is that code.
const UNKNOWN_BAD_LEI = "549300W9JLPW15XIFM51";
// A legal name that is twenty characters of LEI shape once its spaces are gone.
const LEI_SHAPED_NAME = "AST Bond Portfolio 2021";

test("serves the page with security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("https://api.gleif.org");
  expect(csp).toContain("font-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
});

test("answers unknown paths with 404", async ({ request }) => {
  const response = await request.get("/no-such-page");
  expect(response.status()).toBe(404);
});

// Everything below reads the fixture index, which only a local run serves.
test.describe("search", () => {
  test.skip(!!process.env.BASE_URL, "needs the fixture index of a local run");

  const box = (page: Page) => page.getByRole("combobox");

  /** Open the page and wait until the manifest is in, so requests after this are the search's. */
  async function open(page: Page) {
    await page.goto("/");
    await expect(page.locator("#meta")).toContainText("index:");
  }

  test("loads fonts and scripts from the site only, with no console errors", async ({ page }) => {
    const hosts = new Set<string>();
    const errors: string[] = [];
    page.on("request", (request) => hosts.add(new URL(request.url()).origin));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect([...hosts].sort()).toEqual(["http://localhost:8787", FIXTURE_ORIGIN].sort());
    expect(errors).toEqual([]);
  });

  test("starts on the empty state with examples, and the box focused", async ({ page }) => {
    await open(page);
    await expect(box(page)).toBeFocused();
    await expect(page.getByRole("button", { name: "ericsson" })).toBeVisible();
    await expect(page.locator("#list")).toBeHidden();
    await expect(page.locator("#meta")).toContainText("2,927 entities");
    await expect(page.locator("#meta")).toContainText("gleif 2026-09-16");
  });

  test("finds Ericsson by name", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    await expect(page.locator("#opt-0 mark")).toHaveText("Ericsson");
    await expect(page.locator("#info")).toContainText("matches");
    await expect(page.locator("#preview")).toContainText("Telefonaktiebolaget LM Ericsson");
    await expect(page.locator("#preview")).toContainText("Sweden");
  });

  test("finds Ericsson typed one key at a time", async ({ page }) => {
    await open(page);
    await box(page).pressSequentially("telefonaktiebolaget lm eric", { delay: 20 });
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
  });

  test("searches in a worker, and on the page itself where there is none", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    expect(page.workers().map((w) => new URL(w.url()).pathname)).toEqual(["/search-worker.js"]);

    const bare = await page.context().newPage();
    await bare.addInitScript(() => {
      (window as { Worker?: unknown }).Worker = undefined;
    });
    await bare.goto("/");
    await expect(bare.locator("#meta")).toContainText("index:");
    await bare.getByRole("combobox").fill("ericsson");
    await expect(bare.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    expect(bare.workers()).toEqual([]);
  });

  test("runs the search on the page when the worker script cannot load", async ({ page }) => {
    await page.route("**/search-worker.js", (route) => route.abort());
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    expect(page.workers()).toEqual([]);
  });

  /** A worker that answers `init` and then throws on the first input. */
  const FAILING_WORKER = `
    onmessage = (e) => {
      if (e.data.type === "init") {
        postMessage({ type: "state", seq: 0, stats: null, state: { text: "", phase: "empty",
          hits: [], tokens: [], message: "", reload: false, lei: null,
          index: { asOf: "2026-09-16", entities: 1 } } });
      }
      if (e.data.type === "input") throw new Error("boom");
    };`;

  test("starts the worker once more when it fails after answering, and goes on", async ({
    page,
  }) => {
    let scripts = 0;
    await page.route("**/search-worker.js", (route) => {
      scripts++;
      if (scripts === 1) {
        return route.fulfill({ body: FAILING_WORKER, contentType: "text/javascript" });
      }
      return route.continue();
    });
    await page.goto("/");
    await expect(page.locator("#meta")).toContainText("index:");
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    expect(scripts).toBe(2);
  });

  test("shows an error when the restarted worker fails too", async ({ page }) => {
    await page.route("**/search-worker.js", (route) =>
      route.fulfill({ body: FAILING_WORKER, contentType: "text/javascript" }),
    );
    await page.goto("/");
    await expect(page.locator("#meta")).toContainText("index:");
    // The page reloads itself once, as it does for an index it cannot read.
    await Promise.all([page.waitForEvent("load"), box(page).fill("ericsson")]);
    await expect(page.locator("#meta")).toContainText("index:");
    await box(page).fill("ericsson");
    await expect(page.locator("#info")).toContainText("the search could not start");
    await expect(page.getByRole("button", { name: "reload" })).toBeVisible();
  });

  test("ends on the right result after fast typing, with no older answer after it", async ({
    page,
  }) => {
    await open(page);
    // Every change of the first result, as the page draws it.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __seen: string[] }).__seen = seen;
      new MutationObserver(() => {
        seen.push(document.querySelector("#opt-0 .lei")?.textContent ?? "");
      }).observe(document.querySelector("#list") as Element, { childList: true, subtree: true });
    });
    await box(page).pressSequentially("telefonaktiebolaget", { delay: 10 });
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    await expect(page.locator("body")).not.toHaveAttribute("data-phase", "loading");
    await page.waitForTimeout(500);
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen.at(-1)).toBe(ERICSSON);
    // Once Ericsson is first, it stays first: nothing older is drawn over it.
    const first = seen.indexOf(ERICSSON);
    expect(seen.slice(first).every((lei) => lei === ERICSSON || lei === "")).toBe(true);
  });

  test("moves the selection and the preview with the arrow keys", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-1")).toBeVisible();
    // Final results: the typing pass and the pause pass (150 ms) have both drawn, so nothing
    // redraws the list after the key is pressed.
    await expect(page.locator("body")).toHaveAttribute("data-phase", "done");
    await page.waitForTimeout(300);
    await expect(box(page)).toHaveAttribute("aria-activedescendant", "opt-0");
    const first = await page.locator("#preview .label").innerText();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#opt-1")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#opt-0")).toHaveAttribute("aria-selected", "false");
    await expect(box(page)).toHaveAttribute("aria-activedescendant", "opt-1");
    const second = await page.locator("#opt-1 .lei").innerText();
    await expect(page.locator("#preview .label")).toHaveText(second);
    expect(second).not.toBe(first);
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#opt-0")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#preview .label")).toHaveText(first);
    // The top of the list stays put.
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#opt-0")).toHaveAttribute("aria-selected", "true");
    await expect(box(page)).toHaveAttribute("aria-activedescendant", "opt-0");
    // With no results there is no active option, and the attribute is absent, not empty.
    await box(page).fill("zzzqqqxxx");
    await expect(page.locator("#info")).toHaveText("no matches");
    expect(await box(page).getAttribute("aria-activedescendant")).toBeNull();
  });

  test("numbers the results for screen readers", async ({ page }) => {
    await open(page);
    await box(page).fill("bank");
    const total = Number(await page.locator("#opt-0").getAttribute("aria-setsize"));
    expect(total).toBeGreaterThan(30);
    await expect(page.locator("#list [role=option]")).toHaveCount(total);
    await expect(page.locator(`#opt-${total - 1}`)).toHaveAttribute("aria-posinset", String(total));
    for (let i = 0; i < 3; i++) await page.keyboard.press("PageDown");
    await expect(box(page)).toHaveAttribute("aria-activedescendant", "opt-30");
  });

  test("copies the selected LEI on enter and says so", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    await page.keyboard.press("Enter");
    await expect(page.locator("#info")).toHaveText(`copied ${ERICSSON}`);
    await expect(page.locator("#status")).toHaveText(`copied ${ERICSSON}`);
    expect(await page.evaluate("navigator.clipboard.readText()")).toBe(ERICSSON);
    // The second result copies its own LEI.
    await page.keyboard.press("ArrowDown");
    const second = await page.locator("#opt-1 .lei").innerText();
    await page.keyboard.press("Enter");
    await expect(page.locator("#info")).toHaveText(`copied ${second}`);
    expect(await page.evaluate("navigator.clipboard.readText()")).toBe(second);
    await context.close();
  });

  test("opens the record on the right arrow", async ({ page }) => {
    // The record page needs GLEIF; this test is about where the page goes.
    await page.route("**/lei/*", (route) => route.fulfill({ status: 200, body: "record" }));
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/lei/${ERICSSON}$`));
  });

  test("opens the record from the preview link", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.getByRole("link", { name: "open record" })).toHaveAttribute(
      "href",
      `/lei/${ERICSSON}`,
    );
  });

  test("keeps the right arrow for the caret while it is not at the end", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0")).toBeVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/localhost:8787\/$/);
  });

  test("clears on escape", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(box(page)).toHaveValue("");
    await expect(page.locator("#list")).toBeHidden();
    await expect(page.getByRole("button", { name: "ericsson" })).toBeVisible();
  });

  test("focuses the box on slash", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await page.locator("#info").click();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(box(page)).not.toBeFocused();
    await page.keyboard.press("/");
    await expect(box(page)).toBeFocused();
    // The slash is a command here, not text.
    await expect(box(page)).toHaveValue("ericsson");
  });

  test("starts a search when a letter is typed outside the box", async ({ page }) => {
    await open(page);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.type("ericsson");
    await expect(box(page)).toHaveValue("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
  });

  test("shows the about page on question mark, and goes back", async ({ page }) => {
    await open(page);
    await page.keyboard.press("?");
    await expect(page).toHaveURL(/#about$/);
    await expect(page.locator("#man")).toContainText("WHICHLEI(1)");
    await expect(page.locator("#man")).toContainText("2026-09-16");
    await expect(page.locator("#keys")).toContainText("quit");
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/#about/);
    await expect(page.locator("#man")).toBeHidden();
    await expect(box(page)).toBeFocused();
    // The button does the same, and q leaves.
    await page.getByRole("button", { name: "about" }).click();
    await expect(page.locator("#man")).toBeVisible();
    await page.keyboard.press("q");
    await expect(page.locator("#man")).toBeHidden();
  });

  test("shows the about page with the index date when opened by its address", async ({ page }) => {
    await page.goto("/#about");
    await expect(page.locator("#man")).toBeVisible();
    await expect(page.locator("#meta")).toContainText("gleif 2026-09-16");
    await expect(page.locator("#man")).toContainText("2,927 entities");
  });

  test("leaves the site in one Back press from the search after the about page", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "about" }).click();
    await expect(page.locator("#man")).toBeVisible();
    // Typing leaves the about page, and its history entry goes with it.
    await page.keyboard.type("e");
    await expect(page.locator("#man")).toBeHidden();
    await expect(page).not.toHaveURL(/#about/);
    await expect(box(page)).toHaveValue("e");
    await page.goBack();
    expect(page.url()).toBe("about:blank");
  });

  test("keeps what was typed out of the performance timeline", async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __measures: string[] }).__measures = seen;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) seen.push(JSON.stringify(e));
      }).observe({ type: "measure" });
    });
    await open(page);
    await box(page).pressSequentially("ericsson", { delay: 30 });
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    await page.waitForTimeout(400);
    const seen = await page.evaluate(
      () => (window as unknown as { __measures: string[] }).__measures,
    );
    expect(seen.some((entry) => entry.includes("whichlei:results"))).toBe(true);
    expect(seen.join()).not.toMatch(/ericsson|eric/i);
  });

  test("does not take the question mark while there is text in the box", async ({ page }) => {
    await open(page);
    await box(page).fill("what");
    await page.keyboard.type("?");
    await expect(box(page)).toHaveValue("what?");
    await expect(page).not.toHaveURL(/#about/);
  });

  test("puts the row of a valid LEI first, with the names that are that code below it", async ({
    page,
  }) => {
    await open(page);
    await box(page).fill(VALID_LEI.toLowerCase());
    await expect(page.locator("#opt-0 .lei")).toHaveText(VALID_LEI);
    await expect(page.locator("#info")).toContainText("check digits ok");
    await expect(page.getByRole("link", { name: "open record" })).toHaveAttribute(
      "href",
      `/lei/${VALID_LEI}`,
    );
    // The fixture has an entity whose legal name is this code (and one a character away): a
    // name search runs too, and the exact one is first among the names.
    await expect(page.locator("#opt-1 .nm")).toHaveText(VALID_LEI);
    await expect(page.locator("#list [role=option]")).toHaveCount(3);
    await expect(page.locator("#info")).toContainText("2 matches");
  });

  test("shows only the row for a valid LEI that no name has", async ({ page }) => {
    await open(page);
    await box(page).fill(ERICSSON);
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    await expect(page.locator("body")).not.toHaveAttribute("data-phase", "loading");
    await expect(page.locator("#list [role=option]")).toHaveCount(1);
  });

  test("says the check digits are wrong when no name matches either", async ({ page }) => {
    await open(page);
    await box(page).fill(UNKNOWN_BAD_LEI);
    await expect(page.locator("#info")).toContainText("not a valid lei");
    await expect(page.locator("#info")).toContainText("check digits");
    await expect(page.locator("#list")).toBeHidden();
  });

  test("searches names for an input that is an LEI's shape with bad check digits", async ({
    page,
  }) => {
    await open(page);
    // The fixture has an entity whose legal name is this code: it is found, with a quiet note.
    await box(page).fill(BAD_LEI);
    await expect(page.locator("#opt-0 .nm")).toHaveText(BAD_LEI);
    await expect(page.locator("#info")).toContainText("2 matches");
    await expect(page.locator("#info")).toContainText("not a valid lei");
  });

  test("says it on the last key of a typed LEI too", async ({ page }) => {
    await open(page);
    await box(page).pressSequentially(BAD_LEI, { delay: 20 });
    await expect(page.locator("#opt-0 .nm")).toHaveText(BAD_LEI);
    await expect(page.locator("#info")).toContainText("not a valid lei");
  });

  test("finds a name that is an LEI's shape once its spaces are gone", async ({ page }) => {
    await open(page);
    await box(page).pressSequentially(LEI_SHAPED_NAME, { delay: 15 });
    await expect(page.locator("#opt-0 .nm")).toHaveText(LEI_SHAPED_NAME);
    await expect(page.locator("#info")).not.toContainText("not a valid lei");
    await expect(page.locator("#info")).toContainText("match");
  });

  test("says so when nothing matches", async ({ page }) => {
    await open(page);
    await box(page).fill("zzzqqqxxx");
    await expect(page.locator("#info")).toHaveText("no matches");
  });

  test("keeps results on screen while a new word loads", async ({ page }) => {
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    // Hold the index files so that the next query has to wait for one.
    await page.route(`${FIXTURE_ORIGIN}/*/*.txt`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await box(page).fill("volvo");
    await expect(page.locator("#info")).toHaveText("searching…");
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
    await expect(page.locator("#info")).toContainText("match");
    await expect(page.locator("#opt-0 .lei")).not.toHaveText(ERICSSON);
  });

  test("says so when the index cannot be reached, and retries", async ({ page }) => {
    await open(page);
    let down = true;
    await page.route(`${FIXTURE_ORIGIN}/*/*.txt`, (route) =>
      down ? route.abort("connectionrefused") : route.continue(),
    );
    await box(page).fill("ericsson");
    await expect(page.locator("#info")).toContainText("could not reach the index");
    down = false;
    await page.getByRole("button", { name: "retry" }).click();
    await expect(page.locator("#opt-0 .lei")).toHaveText(ERICSSON);
  });

  test("reloads once when the index has another format, then says the page is out of date", async ({
    page,
  }) => {
    let manifests = 0;
    await page.route(`${FIXTURE_ORIGIN}/index.json`, (route) => {
      manifests++;
      return route.fulfill({
        json: { format: 2 },
        headers: { "access-control-allow-origin": "*" },
      });
    });
    await page.goto("/");
    await expect(page.locator("#info")).toContainText("out of date");
    await expect(page.getByRole("button", { name: "reload" })).toBeVisible();
    expect(manifests).toBe(2);
    // Not a third time, however long one waits.
    await page.waitForTimeout(500);
    expect(manifests).toBe(2);
  });

  test("shows the list as a listbox with a live region for counts", async ({ page }) => {
    await open(page);
    await expect(box(page)).toHaveAttribute("aria-expanded", "false");
    await box(page).fill("ericsson");
    await expect(page.getByRole("listbox", { name: "Results" })).toBeVisible();
    await expect(box(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#status")).toHaveText(/\d+ matches|top 50 matches/);
  });

  test("follows a dark colour scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await open(page);
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await background()).toBe("rgb(251, 251, 252)");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await background()).toBe("rgb(19, 20, 23)");
  });

  test("uses the self-hosted font", async ({ page }) => {
    await open(page);
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.evaluate(() =>
      [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
    );
    expect(loaded.join()).toContain("Red Hat Mono");
  });

  test("fits a phone without a horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await open(page);
    await box(page).fill("ericsson");
    await expect(page.locator("#opt-0")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  for (const scheme of ["light", "dark"] as const) {
    test.describe(`axe, ${scheme}`, () => {
      test.use({ colorScheme: scheme });

      async function violations(page: Page) {
        const { violations } = await new AxeBuilder({ page }).analyze();
        return violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        );
      }

      test("the empty state has no violations", async ({ page }) => {
        await open(page);
        expect(await violations(page)).toEqual([]);
      });

      test("results have no violations", async ({ page }) => {
        await open(page);
        await box(page).fill("ericsson");
        await expect(page.locator("#opt-1")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("an error message has no violations", async ({ page }) => {
        await open(page);
        await box(page).fill(UNKNOWN_BAD_LEI);
        await expect(page.locator("#info .bad")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("the about page has no violations", async ({ page }) => {
        await open(page);
        await page.keyboard.press("?");
        await expect(page.locator("#man")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    });
  }
});
