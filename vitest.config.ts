import { configDefaults, defineConfig } from "vitest/config";

// Unit tests only. Browser tests live in apps/*/e2e and run with Playwright (pnpm e2e).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "apps/*/e2e/**", ".claude/**"],
  },
});
