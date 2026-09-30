import { defineConfig } from "@playwright/test";

// BASE_URL points the tests at a deployed site; without it they run against `wrangler dev`.
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
        webServer: {
          command: "pnpm build && pnpm dev --port 8787",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
