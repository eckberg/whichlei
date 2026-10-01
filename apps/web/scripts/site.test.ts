import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalOrigin, indexOrigin, pageCsp, searchPage } from "./site.ts";

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
  it("allows only the site, the index, the GLEIF API and Fathom", () => {
    const csp = pageCsp("https://index.whichlei.com");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(
      "connect-src 'self' https://index.whichlei.com https://api.gleif.org https://cdn.usefathom.com;",
    );
    expect(csp).toContain("script-src 'self' https://cdn.usefathom.com;");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("img-src 'self' data: https://cdn.usefathom.com;");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("google");
  });

  it("leaves the index out when there is none", () => {
    expect(pageCsp("")).toContain(
      "connect-src 'self' https://api.gleif.org https://cdn.usefathom.com;",
    );
  });
});

describe("canonicalOrigin", () => {
  it("reads the variable from wrangler.jsonc, comments and all", () => {
    const text = `{
  "vars": {
    // The site's own origin, such as "https://whichlei.com".
    "CANONICAL_ORIGIN": "https://whichlei.com/",
  }
}`;
    expect(canonicalOrigin(text)).toBe("https://whichlei.com");
  });

  it("is empty before launch and refuses a missing variable or a bad one", () => {
    expect(canonicalOrigin('{ "CANONICAL_ORIGIN": "" }')).toBe("");
    expect(() => canonicalOrigin("{}")).toThrow();
    expect(() => canonicalOrigin('{ "CANONICAL_ORIGIN": "whichlei.com" }')).toThrow();
  });

  it("is set in the real wrangler.jsonc", () => {
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(() => canonicalOrigin(wrangler)).not.toThrow();
  });
});

describe("searchPage", () => {
  const page = "<!doctype html>\n<title>whichlei</title>\n<link rel=icon href=x>\n";

  it("links the canonical apex after the title", () => {
    expect(searchPage(page, "https://whichlei.com")).toContain(
      '</title>\n<link rel="canonical" href="https://whichlei.com/">\n',
    );
  });

  it("adds nothing before launch", () => {
    expect(searchPage(page, "")).toBe(page);
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
