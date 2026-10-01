import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { indexOrigin, pageCsp } from "./site.ts";

describe("indexOrigin", () => {
  it("is empty when nothing is configured", () => {
    expect(indexOrigin(undefined)).toBe("");
    expect(indexOrigin("")).toBe("");
    expect(indexOrigin("  ")).toBe("");
  });

  it("keeps the origin and drops a path or trailing slash", () => {
    expect(indexOrigin("https://index.whichlei.com/")).toBe("https://index.whichlei.com");
    expect(indexOrigin("http://127.0.0.1:8788/index.json")).toBe("http://127.0.0.1:8788");
  });

  it("refuses what is not an http(s) URL", () => {
    expect(() => indexOrigin("ftp://index.example")).toThrow();
    expect(() => indexOrigin("index.example")).toThrow();
  });
});

describe("pageCsp", () => {
  it("allows only the site, the index and the GLEIF API", () => {
    const csp = pageCsp("https://index.whichlei.com");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://index.whichlei.com https://api.gleif.org");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("google");
  });

  it("leaves the index out when there is none", () => {
    expect(pageCsp("")).toContain("connect-src 'self' https://api.gleif.org;");
  });
});

describe("the index origin of the Worker", () => {
  it("is the one the site is built with", () => {
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const workflow = readFileSync(
      new URL("../../../.github/workflows/deploy-site.yml", import.meta.url),
      "utf8",
    );
    const worker = /"INDEX_ORIGIN":\s*"([^"]*)"/.exec(wrangler)?.[1];
    const built = /INDEX_ORIGIN:\s*(\S+)/.exec(workflow)?.[1];
    expect(worker).toMatch(/^https:\/\//);
    expect(worker).toBe(built);
  });
});
