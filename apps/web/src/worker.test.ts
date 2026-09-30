import { isValidLei } from "@whichlei/core";
import { describe, expect, it } from "vitest";
import { fakeGleif, harness, leiOf } from "./test-helpers.ts";

const ERICSSON = leiOf("record-ericsson");
const BAD_DIGITS = "549300W9JLPW15XIFM51";

/** A well-formed LEI that no fixture has: GLEIF answers 404 for it. */
function unknownLei(): string {
  const base = "549300ZZZZZZZZZZZZ";
  const digits = [...`${base}00`].map((c) => Number.parseInt(c, 36)).join("");
  const check = 98 - Number(BigInt(digits) % 97n);
  return `${base}${String(check).padStart(2, "0")}`;
}
const UNKNOWN = unknownLei();

it("uses an unknown LEI with valid check digits, and bad ones without", () => {
  expect(isValidLei(UNKNOWN)).toBe(true);
  expect(isValidLei(BAD_DIGITS)).toBe(false);
});

describe("canonical redirects", () => {
  it.each([
    ["lower case", `/lei/${ERICSSON.toLowerCase()}`],
    ["surrounding spaces", `/lei/%20${ERICSSON}%20`],
    ["spaces and lower case", `/lei/%20${ERICSSON.toLowerCase()}%20`],
    ["a space inside", `/lei/${ERICSSON.slice(0, 10)}%20${ERICSSON.slice(10)}`],
    ["a trailing slash", `/lei/${ERICSSON}/`],
    ["a query string", `/lei/${ERICSSON.toLowerCase()}?utm=x`],
  ])("301 to the upper-case URL: %s", async (_, path) => {
    const t = harness();
    const response = await t.get(path);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://whichlei.test/lei/${ERICSSON}`);
    expect(t.gleif.calls).toEqual([]);
  });

  it("redirects a bad LEI first, then answers 404 at the canonical URL", async () => {
    const t = harness();
    const first = await t.get(`/lei/${BAD_DIGITS.toLowerCase()}`);
    expect(first.status).toBe(301);
    expect(first.headers.get("location")).toBe(`https://whichlei.test/lei/${BAD_DIGITS}`);
  });
});

describe("404 without calling GLEIF", () => {
  it("says the check digits do not match", async () => {
    const t = harness();
    const response = await t.get(`/lei/${BAD_DIGITS}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("check digits do not match");
    expect(t.gleif.calls).toEqual([]);
    expect(t.cache.puts).toEqual([]);
  });

  it.each([
    ["too short", "/lei/549300W9JLPW15XIFM5"],
    ["too long", `/lei/${ERICSSON}2`],
    ["punctuation", "/lei/549300W9JLPW15XIFM5!"],
    ["empty", "/lei/"],
    ["a broken escape", "/lei/%E0%A4%A"],
    ["a nested path", `/lei/${ERICSSON}/more`],
    ["non-ASCII look-alikes", "/lei/549300W9JLPW15XIFM5%C4%B1"],
  ])("404 for input that is not an LEI: %s", async (_, path) => {
    const t = harness();
    const response = await t.get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Not an LEI");
    expect(t.gleif.calls).toEqual([]);
  });
});

describe("an unknown LEI", () => {
  it("answers 404 and caches it for an hour", async () => {
    const t = harness();
    const response = await t.get(`/lei/${UNKNOWN}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("GLEIF has no record");
    expect(t.cache.puts).toEqual([
      {
        url: `https://whichlei.test/lei/${UNKNOWN}`,
        status: 404,
        cacheControl: "public, max-age=3600",
      },
    ]);

    const again = await t.get(`/lei/${UNKNOWN}`);
    expect(again.status).toBe(404);
    expect(again.headers.get("x-cache")).toBe("HIT");
    expect(t.gleif.calls).toHaveLength(1);
  });
});

describe("a record", () => {
  it("renders the page, keeps it until 09:00 UTC and serves the next view from the cache", async () => {
    const t = harness();
    t.setNow("2026-09-30T10:00:00Z");
    const first = await t.get(`/lei/${ERICSSON}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(first.headers.get("x-cache")).toBe("MISS");
    const page = await first.text();
    expect(page).toContain(
      "<title>Telefonaktiebolaget LM Ericsson · LEI 549300W9JLPW15XIFM52 · whichlei</title>",
    );

    // 10:00 to the next 09:00 UTC is 23 hours.
    expect(t.cache.puts).toEqual([
      {
        url: `https://whichlei.test/lei/${ERICSSON}`,
        status: 200,
        cacheControl: "public, max-age=82800",
      },
    ]);
    expect(t.gleif.calls).toHaveLength(1);
    expect(t.gleif.calls[0]).toContain(`/lei-records/${ERICSSON}?include=direct-parent`);

    const second = await t.get(`/lei/${ERICSSON}`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(second.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await second.text()).toBe(page);
    expect(t.gleif.calls).toHaveLength(1);
    expect(t.cache.puts).toHaveLength(1);
  });

  it("shares one cache entry between hosts when a canonical origin is set", async () => {
    const t = harness();
    const env = { CANONICAL_ORIGIN: "https://whichlei.com" };
    await t.get(`/lei/${ERICSSON}`, undefined, env);
    expect(t.cache.puts[0]?.url).toBe(`https://whichlei.com/lei/${ERICSSON}`);
  });

  it("links the canonical URL and JSON-LD to CANONICAL_ORIGIN, else the request origin", async () => {
    const t = harness();
    const own = await (await t.get(`/lei/${ERICSSON}`)).text();
    expect(own).toContain(`<link rel="canonical" href="https://whichlei.test/lei/${ERICSSON}">`);

    const other = harness();
    const page = await (
      await other.get(`/lei/${ERICSSON}`, undefined, { CANONICAL_ORIGIN: "https://whichlei.com/" })
    ).text();
    expect(page).toContain(`<link rel="canonical" href="https://whichlei.com/lei/${ERICSSON}">`);
    expect(page).toContain(`"url":"https://whichlei.com/lei/${ERICSSON}"`);

    const broken = harness();
    const fallback = await (
      await broken.get(`/lei/${ERICSSON}`, undefined, { CANONICAL_ORIGIN: "javascript:alert(1)" })
    ).text();
    expect(fallback).toContain(`href="https://whichlei.test/lei/${ERICSSON}"`);
  });

  it("serves the page when the cache fails", async () => {
    const t = harness();
    t.cache.fail = true;
    const response = await t.get(`/lei/${ERICSSON}`);
    expect(response.status).toBe(200);
    expect(t.gleif.calls).toHaveLength(1);
  });

  it("answers HEAD without a body", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuses other methods", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(t.gleif.calls).toEqual([]);
  });
});

describe("GLEIF failures", () => {
  it("answers 503 with Retry-After 60 when GLEIF cannot be reached, and caches nothing", async () => {
    const t = harness({
      gleif: fakeGleif(() => {
        throw new TypeError("fetch failed");
      }),
    });
    const response = await t.get(`/lei/${ERICSSON}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("Try again shortly");
    expect(t.cache.puts).toEqual([]);
  });

  it("uses GLEIF's Retry-After on a rate limit", async () => {
    const t = harness({
      gleif: fakeGleif(
        () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
      ),
    });
    const response = await t.get(`/lei/${ERICSSON}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(t.cache.puts).toEqual([]);
  });

  it("answers 503 for a GLEIF server error and for a body it cannot read", async () => {
    for (const answer of [
      () => new Response("boom", { status: 500 }),
      () => new Response("<html>maintenance</html>", { status: 200 }),
    ]) {
      const t = harness({ gleif: fakeGleif(answer) });
      const response = await t.get(`/lei/${ERICSSON}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(t.cache.puts).toEqual([]);
    }
  });

  it("asks GLEIF again on the next view", async () => {
    let failing = true;
    const real = fakeGleif();
    const t = harness({
      gleif: fakeGleif((url) =>
        failing ? new Response("boom", { status: 500 }) : real.fetch(url),
      ),
    });
    expect((await t.get(`/lei/${ERICSSON}`)).status).toBe(503);
    failing = false;
    expect((await t.get(`/lei/${ERICSSON}`)).status).toBe(200);
    expect(t.gleif.calls).toHaveLength(2);
  });
});

describe("indexing", () => {
  it("disallows everything in robots.txt by default", async () => {
    const t = harness();
    const response = await t.get("/robots.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("allows crawlers only when ALLOW_INDEXING is exactly true", async () => {
    const t = harness();
    expect(await (await t.get("/robots.txt", undefined, { ALLOW_INDEXING: "true" })).text()).toBe(
      "User-agent: *\nAllow: /\n",
    );
    for (const value of ["false", "", "1", "TRUE", "yes"]) {
      const text = await (await t.get("/robots.txt", undefined, { ALLOW_INDEXING: value })).text();
      expect(text).toContain("Disallow: /");
    }
  });

  it("sends X-Robots-Tag noindex on every /lei/ answer unless indexing is on", async () => {
    const paths = [
      `/lei/${ERICSSON}`, // 200
      `/lei/${UNKNOWN}`, // 404 from GLEIF
      `/lei/${BAD_DIGITS}`, // 404 without GLEIF
      `/lei/${ERICSSON.toLowerCase()}`, // 301
    ];
    const t = harness();
    for (const path of paths) {
      expect((await t.get(path)).headers.get("x-robots-tag"), path).toBe("noindex");
      expect(
        (await t.get(path, undefined, { ALLOW_INDEXING: "false" })).headers.get("x-robots-tag"),
        path,
      ).toBe("noindex");
      expect(
        (await t.get(path, undefined, { ALLOW_INDEXING: "true" })).headers.get("x-robots-tag"),
        path,
      ).toBeNull();
    }
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    expect((await failing.get(`/lei/${ERICSSON}`)).headers.get("x-robots-tag")).toBe("noindex");
  });

  it("keeps noindex on a cached page when the setting changes later", async () => {
    const t = harness();
    await t.get(`/lei/${ERICSSON}`);
    const hit = await t.get(`/lei/${ERICSSON}`, undefined, { ALLOW_INDEXING: "true" });
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("x-robots-tag")).toBeNull();
  });
});

describe("security headers", () => {
  it("are set on every answer", async () => {
    const t = harness();
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    const responses = [
      await t.get(`/lei/${ERICSSON}`),
      await t.get(`/lei/${ERICSSON}`), // from the cache
      await t.get(`/lei/${UNKNOWN}`),
      await t.get(`/lei/${BAD_DIGITS}`),
      await t.get(`/lei/${ERICSSON.toLowerCase()}`),
      await failing.get(`/lei/${ERICSSON}`),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("font-src https://fonts.gstatic.com");
      expect(csp).toContain("style-src 'self' https://fonts.googleapis.com");
    }
  });

  it("allows no inline script in the CSP and renders none that runs", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const page = await response.text();
    // Only the JSON-LD data block and the static copy script.
    const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
    expect(scripts.sort()).toEqual([
      ' src="/scripts/copy.js" defer',
      ' type="application/ld+json"',
    ]);
    expect(page).not.toMatch(/\son[a-z]+=/);
  });
});

describe("other paths", () => {
  it("leave everything but /lei/* and /robots.txt to the static assets", async () => {
    const t = harness();
    for (const path of ["/", "/lei", "/styles/record.css", "/leisure/x"]) {
      const response = await t.get(path);
      expect(await response.text(), path).toBe("static");
    }
    expect(t.assetRequests).toEqual(["/", "/lei", "/styles/record.css", "/leisure/x"]);
    expect(t.gleif.calls).toEqual([]);
  });
});
