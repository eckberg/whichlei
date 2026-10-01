import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("the index Worker's settings", () => {
  it("serves from index.whichlei.com as a custom domain, and keeps workers.dev", () => {
    expect(wrangler).toContain(
      '"routes": [{ "pattern": "index.whichlei.com", "custom_domain": true }]',
    );
    expect(wrangler).toContain('"workers_dev": true');
  });
});
