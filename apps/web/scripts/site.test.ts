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

  it("is empty when the setting is empty, and refuses a missing variable or a bad one", () => {
    expect(canonicalOrigin('{ "CANONICAL_ORIGIN": "" }')).toBe("");
    expect(() => canonicalOrigin("{}")).toThrow();
    expect(() => canonicalOrigin('{ "CANONICAL_ORIGIN": "whichlei.com" }')).toThrow();
  });

  it("is the apex in the real wrangler.jsonc", () => {
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(canonicalOrigin(wrangler)).toBe("https://whichlei.com");
  });
});

describe("searchPage", () => {
  const page = "<!doctype html>\n<title>whichlei</title>\n<link rel=icon href=x>\n";

  it("links the canonical apex after the title", () => {
    expect(searchPage(page, "https://whichlei.com")).toContain(
      '</title>\n<link rel="canonical" href="https://whichlei.com/">\n',
    );
  });

  it("adds nothing when the origin is empty", () => {
    expect(searchPage(page, "")).toBe(page);
  });
});

describe("the launch settings of wrangler.jsonc", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  it("serves the apex as a custom domain, and keeps workers.dev", () => {
    expect(wrangler).toContain('"routes": [{ "pattern": "whichlei.com", "custom_domain": true }]');
    expect(wrangler).toContain('"workers_dev": true');
  });

  it("lets crawlers in, on the canonical host only", () => {
    expect(wrangler).toContain('"ALLOW_INDEXING": "true"');
    expect(wrangler).toContain('"CANONICAL_ORIGIN": "https://whichlei.com"');
  });

  it("reads the index from index.whichlei.com, in every place that names it", () => {
    expect(wrangler).toContain('"INDEX_ORIGIN": "https://index.whichlei.com"');
    for (const file of ["deploy-site.yml", "publish-index.yml", "rollback-index.yml"]) {
      const workflow = readFileSync(
        new URL(`../../../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      expect(workflow, file).toMatch(/INDEX_ORIGIN: https:\/\/index\.whichlei\.com\s/);
      expect(workflow, file).not.toContain("lumenspring");
    }
  });

  it("is checked against the apex by the deploy workflow, in a production environment", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/deploy-site.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("name: production");
    expect(workflow).toContain("url: https://whichlei.com");
    expect(workflow).toContain("LIVE_URL: https://whichlei.com");
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
