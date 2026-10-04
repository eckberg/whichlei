import { defineConfig } from "@playwright/test";
import { FIXTURE_ORIGIN, FIXTURE_PORT } from "./e2e/env.ts";

// BASE_URL points the tests at a deployed site; without it they run against `wrangler dev`,
// with the fixture index (scripts/fixture-index.ts) on a second port, and the site built to
// read it. The tests that need the fixture skip when BASE_URL is set.
// LIVE_URL is the live check (e2e/live.spec.ts), against the canonical host: `pnpm e2e live`.
// It is a deployed site too, and it lets Fathom's script load.
// PW_CHROMIUM uses a local Chromium instead of the one `playwright install` downloads.
const deployed = process.env.BASE_URL ?? process.env.LIVE_URL;
const baseURL = deployed ?? "http://localhost:8787";
const executablePath = process.env.PW_CHROMIUM;
// Fathom is blocked in every test run: the page must not reach it from localhost or workers.dev
// (e2e/stats.spec.ts asserts it), and a test must never count a page view by mistake. The
// live check (e2e/live.spec.ts, LIVE_URL) lets it through on purpose.
const blockFathom = process.env.LIVE_URL
  ? []
  : ["--host-resolver-rules=MAP cdn.usefathom.com ~NOTFOUND"];

export default defineConfig({
  testDir: "e2e",
  // The live check talks to Fathom's CDN and GLEIF: more room, and still a limit.
  ...(process.env.LIVE_URL ? { timeout: 120_000, expect: { timeout: 15_000 } } : {}),
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    browserName: "chromium",
    // A failed test leaves its trace in test-results/, which CI and the deploy workflow keep.
    trace: "retain-on-failure",
    launchOptions: { args: blockFathom, ...(executablePath ? { executablePath } : {}) },
  },
  ...(deployed
    ? {}
    : {
        webServer: [
          {
            command: `node scripts/fixture-server.ts ${FIXTURE_PORT}`,
            url: `${FIXTURE_ORIGIN}/index.json`,
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
          },
          {
            command: `INDEX_ORIGIN=${FIXTURE_ORIGIN} pnpm build && pnpm dev --port 8787`,
            url: baseURL,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ],
      }),
});
