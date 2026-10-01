import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { redirectLocation } from "./worker.ts";

const ask = (url: string, method = "GET", env = {}) =>
  worker.fetch(new Request(url, { method }), env);

describe("whichlei-redirect", () => {
  it("answers 301 to the apex, keeping path and query", () => {
    const response = ask("https://www.whichlei.com/lei/549300W9JLPW15XIFM52?x=1");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://whichlei.com/lei/549300W9JLPW15XIFM52?x=1",
    );
  });

  it("sends the root to the root", () => {
    expect(ask("https://www.whichlei.com/").headers.get("location")).toBe("https://whichlei.com/");
    expect(ask("https://www.whichlei.com").headers.get("location")).toBe("https://whichlei.com/");
  });

  it("keeps an encoded path and a query as sent", () => {
    expect(ask("https://www.whichlei.com/a%20b").headers.get("location")).toBe(
      "https://whichlei.com/a%20b",
    );
    expect(ask("https://www.whichlei.com/robots.txt?a=1&b=%C3%A5").headers.get("location")).toBe(
      "https://whichlei.com/robots.txt?a=1&b=%C3%A5",
    );
  });

  it("answers every method the same way", () => {
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      const response = ask("https://www.whichlei.com/x", method);
      expect(response.status, method).toBe(301);
      expect(response.headers.get("location"), method).toBe("https://whichlei.com/x");
    }
  });

  it("cannot be turned into a redirect to another host", () => {
    for (const path of [
      "//evil.example/x",
      "///evil.example",
      "/\\evil.example",
      "/@evil.example",
    ]) {
      const location = redirectLocation(`https://www.whichlei.com${path}`);
      expect(new URL(location).origin, path).toBe("https://whichlei.com");
    }
  });

  it("sends no body", async () => {
    expect(await ask("https://www.whichlei.com/").text()).toBe("");
  });

  it("uses the target from its settings, and the apex without one", () => {
    const other = ask("https://www.example.test/x?y=1", "GET", {
      TARGET_ORIGIN: "https://example.test/",
    });
    expect(other.headers.get("location")).toBe("https://example.test/x?y=1");
    expect(ask("https://www.whichlei.com/x").headers.get("location")).toBe(
      "https://whichlei.com/x",
    );
  });
});

describe("wrangler.jsonc", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  it("is whichlei-redirect, on the www custom domain only", () => {
    expect(wrangler).toContain('"name": "whichlei-redirect"');
    expect(wrangler).toContain('{ "pattern": "www.whichlei.com", "custom_domain": true }');
    expect(wrangler).toContain('"TARGET_ORIGIN": "https://whichlei.com"');
    expect(wrangler).toContain('"workers_dev": false');
  });
});
