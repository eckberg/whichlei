import { loadStats } from "./stats-loader.ts";

// Set by scripts/build.ts from CANONICAL_ORIGIN in wrangler.jsonc.
loadStats(
  { location, history, document, window } as unknown as Parameters<typeof loadStats>[0],
  __CANONICAL_ORIGIN__,
);
