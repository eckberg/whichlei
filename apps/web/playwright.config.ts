import { defineConfig } from "@playwright/test";
import { FIXTURE_ORIGIN, FIXTURE_PORT } from "./e2e/env.ts";

// BASE_URL points the tests at a deployed site; without it they run against `wrangler dev`,
// with the fixture index (scripts/fixture-index.ts) on a second port, and the site built to
// read it. The tests that need the fixture skip when BASE_URL is set.
// PW_CHROMIUM uses a local Chromium instead of the one `playwright install` downloads.
const baseURL = process.env.BASE_URL ?? "http://localhost:8787";
const executablePath = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    browserName: "chromium",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  ...(process.env.BASE_URL
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
