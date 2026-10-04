import { isValidLei } from "@whichlei/core";
import { describe, expect, it } from "vitest";
import { fakeGleif, harness, leiOf, loadFixture } from "./test-helpers.ts";

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

// What robots.txt says on the canonical host once indexing is on, word for word.
const OPEN_ROBOTS = `# whichlei. Every record comes from GLEIF under CC0. For bulk data, use GLEIF's golden copy:
# https://www.gleif.org/en/lei-data/gleif-golden-copy/download-the-golden-copy/

User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Allow: /

# Crawlers that collect training data: the static pages, not the records.
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: CCBot
User-agent: Applebot-Extended
User-agent: Bytespider
User-agent: Meta-ExternalAgent
User-agent: Amazonbot
User-agent: cohere-training-data-crawler
User-agent: Diffbot
User-agent: omgili
Content-Signal: search=yes, ai-input=yes, ai-train=no
Disallow: /lei/

Sitemap: https://whichlei.test/sitemap.xml
`;

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

  it("redirects to CANONICAL_ORIGIN when it is set", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON.toLowerCase()}`, undefined, {
      CANONICAL_ORIGIN: "https://whichlei.com",
    });
    expect(response.headers.get("location")).toBe(`https://whichlei.com/lei/${ERICSSON}`);
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
        url: `https://whichlei.test/lei/${UNKNOWN}?doc=1`,
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
  it("renders the page, keeps it until 25 hours after its golden copy and serves the next view from the cache", async () => {
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

    // The golden copy is dated 2026-09-30T08:00Z: it expires 2026-10-01T09:00Z, 23 hours on.
    expect(t.cache.puts).toEqual([
      {
        url: `https://whichlei.test/lei/${ERICSSON}?doc=1`,
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

  it("keeps a record for at least 5 minutes and at most 24 hours", async () => {
    const stale = harness();
    stale.setNow("2026-10-09T00:00:00Z"); // a week after the golden copy
    await stale.get(`/lei/${ERICSSON}`);
    expect(stale.cache.puts[0]?.cacheControl).toBe("public, max-age=300");

    const early = harness();
    early.setNow("2026-09-30T08:00:00Z"); // the moment of the golden copy
    await early.get(`/lei/${ERICSSON}`);
    expect(early.cache.puts[0]?.cacheControl).toBe("public, max-age=86400");
  });

  it("keeps a record with no golden copy date for an hour", async () => {
    const real = fakeGleif();
    const t = harness({
      gleif: fakeGleif(async (url) => {
        const body = await (await real.fetch(url)).json();
        delete (body as { meta?: unknown }).meta;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    });
    await t.get(`/lei/${ERICSSON}`);
    expect(t.cache.puts[0]?.cacheControl).toBe("public, max-age=3600");
  });

  it("ignores the visitor's query string in the cache key", async () => {
    const t = harness();
    await t.get(`/lei/${ERICSSON}`);
    const hit = await t.get(`/lei/${ERICSSON}?x=${Math.random()}`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(t.gleif.calls).toHaveLength(1);
    expect(t.cache.puts).toHaveLength(1);
    // The key is ours alone: not the page's URL, which the production Worker before this one
    // kept rendered pages under.
    expect(t.cache.puts[0]?.url).toBe(`https://whichlei.test/lei/${ERICSSON}?doc=1`);
    const visitor = await t.get(`/lei/${ERICSSON}?doc=2&x=1`);
    expect(visitor.headers.get("x-cache")).toBe("HIT");
    expect(t.cache.puts).toHaveLength(1);
  });

  it("shares one cache entry between hosts when a canonical origin is set", async () => {
    const t = harness();
    const env = { CANONICAL_ORIGIN: "https://whichlei.com" };
    await t.get(`/lei/${ERICSSON}`, undefined, env);
    expect(t.cache.puts[0]?.url).toBe(`https://whichlei.com/lei/${ERICSSON}?doc=1`);
  });

  it("links the canonical URL and JSON-LD to CANONICAL_ORIGIN, else the request origin", async () => {
    const t = harness();
    const own = await (await t.get(`/lei/${ERICSSON}`)).text();
    expect(own).toContain(`<link rel="canonical" href="https://whichlei.test/lei/${ERICSSON}">`);
    expect(own).toContain(`"@id":"https://whichlei.test/lei/${ERICSSON}"`);

    for (const value of ["https://whichlei.com/", "https://whichlei.com"]) {
      const other = harness();
      const page = await (
        await other.get(`/lei/${ERICSSON}`, undefined, { CANONICAL_ORIGIN: value })
      ).text();
      expect(page).toContain(`<link rel="canonical" href="https://whichlei.com/lei/${ERICSSON}">`);
      expect(page).toContain(`"@id":"https://whichlei.com/lei/${ERICSSON}"`);
    }

    for (const value of ["javascript:alert(1)", "", "not a url"]) {
      const broken = harness();
      const fallback = await (
        await broken.get(`/lei/${ERICSSON}`, undefined, { CANONICAL_ORIGIN: value })
      ).text();
      expect(fallback).toContain(`href="https://whichlei.test/lei/${ERICSSON}"`);
    }
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

  it("refuses other methods, with the security headers", async () => {
    const t = harness();
    for (const path of [`/lei/${ERICSSON}`, "/robots.txt"]) {
      const response = await t.get(path, { method: "POST" });
      expect(response.status, path).toBe(405);
      expect(response.headers.get("allow"), path).toBe("GET, HEAD");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("content-security-policy"), path).toContain("default-src 'none'");
    }
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

  it("never sends a Retry-After below 1", async () => {
    for (const value of ["0", "Mon, 01 Jan 2001 00:00:00 GMT"]) {
      const t = harness({
        gleif: fakeGleif(
          () => new Response("slow down", { status: 429, headers: { "retry-after": value } }),
        ),
      });
      const response = await t.get(`/lei/${ERICSSON}`);
      expect(response.status, value).toBe(503);
      expect(response.headers.get("retry-after"), value).toBe("1");
    }
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

  it("gives up on a GLEIF that does not answer in time", async () => {
    // The fake never answers: it fails only when the signal it was given aborts.
    const t = harness({
      gleifTimeoutMs: 20,
      gleif: fakeGleif(
        (_, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    });
    const response = await t.get(`/lei/${ERICSSON}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(t.cache.puts).toEqual([]);
  });

  it("does not show or cache a record for another LEI than the one asked for", async () => {
    const other = loadFixture("record-subsidiary");
    const t = harness({
      gleif: fakeGleif(() => new Response(JSON.stringify(other.body), { status: 200 })),
    });
    const response = await t.get(`/lei/${ERICSSON}`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("VONAGE");
    expect(t.cache.puts).toEqual([]);
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
  // Indexing needs both the setting and a request to the canonical host.
  const launched = { ALLOW_INDEXING: "true", CANONICAL_ORIGIN: "https://whichlei.test" };

  it("disallows everything in robots.txt by default", async () => {
    const t = harness();
    const response = await t.get("/robots.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("allows crawlers only when ALLOW_INDEXING is exactly true and the host is canonical", async () => {
    const t = harness();
    const robots = async (env: Record<string, string>) =>
      (await t.get("/robots.txt", undefined, env)).text();

    expect(await robots(launched)).toBe(OPEN_ROBOTS);
    for (const value of ["false", "", "1", "TRUE", "yes"]) {
      expect(await robots({ ...launched, ALLOW_INDEXING: value }), value).toBe(
        "User-agent: *\nDisallow: /\n",
      );
    }
  });

  it("names the canonical origin as the sitemap's, and keeps records from training crawlers only", async () => {
    const t = harness();
    const text = await (
      await t.get("/robots.txt", undefined, {
        ...launched,
        CANONICAL_ORIGIN: "https://whichlei.test/",
      })
    ).text();
    expect(text).toContain("\nSitemap: https://whichlei.test/sitemap.xml\n");
    // Search crawlers and agents that fetch a page for a person stay under `*`.
    for (const agent of [
      "Googlebot",
      "Bingbot",
      "OAI-SearchBot",
      "ChatGPT-User",
      "Claude-SearchBot",
      "Claude-User",
      "PerplexityBot",
      "Perplexity-User",
    ]) {
      expect(text, agent).not.toContain(agent);
    }
    // Google-Extended also covers Gemini's grounding, which `ai-input=yes` wants.
    expect(text).not.toContain("Google-Extended");
    for (const agent of ["GPTBot", "ClaudeBot", "CCBot", "Applebot-Extended", "Bytespider"]) {
      expect(text, agent).toContain(`User-agent: ${agent}\n`);
    }
    // The signal is said in both groups: a crawler that matches a named group ignores `*`.
    expect(text.match(/^Content-Signal: search=yes, ai-input=yes, ai-train=no$/gm)).toHaveLength(2);
    // One `Disallow` for the whole group of training crawlers.
    expect(text.match(/^Disallow:.*$/gm)).toEqual(["Disallow: /lei/"]);
  });

  it("never allows a host that is not the canonical one, such as workers.dev", async () => {
    const workersDev = harness({ origin: "https://whichlei-site.example.workers.dev" });
    expect(await (await workersDev.get("/robots.txt", undefined, launched)).text()).toBe(
      "User-agent: *\nDisallow: /\n",
    );
    expect(await (await workersDev.get("/robots.txt", undefined, launched)).text()).not.toContain(
      "Sitemap",
    );
    const page = await workersDev.get(`/lei/${ERICSSON}`, undefined, launched);
    expect(page.headers.get("x-robots-tag")).toBe("noindex");

    // Nor without a canonical origin, whatever ALLOW_INDEXING says.
    for (const env of [
      { ALLOW_INDEXING: "true" },
      { ALLOW_INDEXING: "true", CANONICAL_ORIGIN: "" },
    ]) {
      const t = harness();
      expect(await (await t.get("/robots.txt", undefined, env)).text()).toBe(
        "User-agent: *\nDisallow: /\n",
      );
      expect((await t.get(`/lei/${ERICSSON}`, undefined, env)).headers.get("x-robots-tag")).toBe(
        "noindex",
      );
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
        (await t.get(path, undefined, { ...launched, ALLOW_INDEXING: "false" })).headers.get(
          "x-robots-tag",
        ),
        path,
      ).toBe("noindex");
      expect((await t.get(path, undefined, launched)).headers.get("x-robots-tag"), path).toBeNull();
    }
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    expect((await failing.get(`/lei/${ERICSSON}`)).headers.get("x-robots-tag")).toBe("noindex");
  });

  it("applies the indexing setting to a cached page when it is served, not when it was stored", async () => {
    const t = harness();
    const stored = await t.get(`/lei/${ERICSSON}`);
    expect(stored.headers.get("x-robots-tag")).toBe("noindex");
    const hit = await t.get(`/lei/${ERICSSON}`, undefined, launched);
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
      expect(csp).toContain("script-src 'self' https://cdn.usefathom.com;");
      expect(csp).toContain("img-src 'self' data: https://cdn.usefathom.com;");
      expect(csp).toContain("connect-src https://cdn.usefathom.com;");
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("google");
    }
  });

  it("allows no inline script in the CSP and renders none that runs", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const page = await response.text();
    // Only the two JSON data blocks (JSON-LD, and the record for copy json) and the static copy
    // and stats scripts.
    const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
    expect(scripts.sort()).toEqual([
      ' src="/scripts/copy.js" defer',
      ' src="/scripts/stats.js" defer',
      ' type="application/json" id="record-json"',
      ' type="application/ld+json"',
    ]);
    expect(page).not.toMatch(/\son[a-z]+=/);
  });
});

describe("the version header", () => {
  const VERSION = { CF_VERSION_METADATA: { id: "6ea33c29-2bd4-465a-93c1-26cce04efee6" } };

  it("names the Worker version on every answer of its own", async () => {
    const t = harness();
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    const responses = [
      await t.get("/robots.txt", { method: "HEAD" }, VERSION),
      await t.get(`/lei/${ERICSSON}`, undefined, VERSION),
      await t.get(`/lei/${ERICSSON}.json`, undefined, VERSION), // from the cache
      await t.get(`/lei/${BAD_DIGITS}`, undefined, VERSION),
      await t.get(`/lei/${ERICSSON.toLowerCase()}`, undefined, VERSION),
      await t.get("/robots.txt", { method: "POST" }, VERSION),
      await failing.get(`/lei/${ERICSSON}`, undefined, VERSION),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-whichlei-version")).toBe(VERSION.CF_VERSION_METADATA.id);
    }
  });

  it("is left out without the binding", async () => {
    const t = harness();
    expect((await t.get("/robots.txt")).headers.get("x-whichlei-version")).toBeNull();
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
