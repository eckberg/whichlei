// The record as JSON and Markdown: the routes `/lei/<LEI>.json` and `/lei/<LEI>.md`, and
// `/lei/<LEI>` answering in the format `Accept` asks for. One cached document serves all three.
import { describe, expect, it } from "vitest";
import { fakeGleif, harness, leiOf } from "./test-helpers.ts";

const ERICSSON = leiOf("record-ericsson");
const BAD_DIGITS = "549300W9JLPW15XIFM51";
const UNKNOWN = "549300ZZZZZZZZZZZZ46";
const ORIGIN = "https://whichlei.test";
const JSON_TYPE = "application/json; charset=utf-8";
const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
const asking = (accept: string) => ({ headers: { accept } });
const launched = { ALLOW_INDEXING: "true", CANONICAL_ORIGIN: ORIGIN };

const pageJson = (page: string) =>
  JSON.parse(
    /<script type="application\/json" id="record-json">(.*?)<\/script>/s.exec(page)?.[1] ?? "",
  );

describe("/lei/<LEI>.json", () => {
  it("answers the record document, pretty-printed", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("x-cache")).toBe("MISS");
    const text = await response.text();
    expect(
      text.startsWith(`{\n  "lei": "${ERICSSON}",\n  "url": "${ORIGIN}/lei/${ERICSSON}",\n`),
    ).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    const doc = JSON.parse(text);
    expect(doc.legalName.name).toBe("Telefonaktiebolaget LM Ericsson");
    expect(doc.source.goldenCopyDate).toBe("2026-09-30T08:00:00Z");
  });

  it("is the document the page embeds for copy json", async () => {
    const t = harness();
    const page = await (await t.get(`/lei/${ERICSSON}`)).text();
    const doc = JSON.parse(await (await t.get(`/lei/${ERICSSON}.json`)).text());
    expect(doc).toEqual(pageJson(page));
    expect(t.gleif.calls).toHaveLength(1);
  });

  it("is the record with its URL, and the names of the codes when the index has them", async () => {
    const t = harness();
    const doc = JSON.parse(await (await t.get(`/lei/${ERICSSON}.json`)).text());
    // No INDEX_ORIGIN here, so no names for codes.
    expect(doc.legalForm).toEqual({ code: "XJHM", other: null });
    expect(doc.registrationAuthority).toEqual({ id: "RA000544", other: null });
    expect(doc.url).toBe(`${ORIGIN}/lei/${ERICSSON}`);
  });

  it("sends noindex on its own URL, and points at the page as the canonical URL, even when indexing is on", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}.json`, undefined, launched);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("link")).toBe(`<${ORIGIN}/lei/${ERICSSON}>; rel="canonical"`);
    // The page itself is indexed, and sends no Link.
    const page = await t.get(`/lei/${ERICSSON}`, undefined, launched);
    expect(page.headers.get("x-robots-tag")).toBeNull();
    expect(page.headers.get("link")).toBeNull();
  });

  it("points at CANONICAL_ORIGIN, not at the host that was asked", async () => {
    const t = harness({ origin: "https://whichlei-site.example.workers.dev" });
    const response = await t.get(`/lei/${ERICSSON}.json`, undefined, launched);
    expect(response.headers.get("link")).toBe(`<${ORIGIN}/lei/${ERICSSON}>; rel="canonical"`);
    expect(JSON.parse(await response.text()).url).toBe(`${ORIGIN}/lei/${ERICSSON}`);
  });

  it("has no Vary: the URL says what it is", async () => {
    const t = harness();
    expect((await t.get(`/lei/${ERICSSON}.json`)).headers.get("vary")).toBeNull();
    expect((await t.get(`/lei/${ERICSSON}.md`)).headers.get("vary")).toBeNull();
  });

  it("answers HEAD without a body", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}.json`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await response.text()).toBe("");
  });
});

describe("/lei/<LEI>.md", () => {
  it("answers the record as Markdown", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(MARKDOWN_TYPE);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("link")).toBe(`<${ORIGIN}/lei/${ERICSSON}>; rel="canonical"`);
    const text = await response.text();
    expect(
      text.startsWith(
        `# Telefonaktiebolaget LM Ericsson\n\nLEI: ${ERICSSON}\n\n- **status:** active\n`,
      ),
    ).toBe(true);
    expect(text).toContain(`permalink: <${ORIGIN}/lei/${ERICSSON}>`);
  });

  it("has absolute links, to CANONICAL_ORIGIN", async () => {
    const t = harness({ origin: "https://whichlei-site.example.workers.dev" });
    const text = await (
      await t.get(`/lei/${leiOf("record-subsidiary")}.md`, undefined, launched)
    ).text();
    expect(text).toContain(`[Telefonaktiebolaget LM Ericsson](${ORIGIN}/lei/${ERICSSON})`);
    expect(text).not.toContain("workers.dev");
  });
});

describe("redirects to the canonical form", () => {
  it.each([
    ["json", ".json"],
    ["md", ".md"],
  ])("301 keeps the .%s extension", async (_, extension) => {
    for (const path of [
      `/lei/${ERICSSON.toLowerCase()}${extension}`,
      `/lei/%20${ERICSSON}%20${extension}`,
      `/lei/${ERICSSON.slice(0, 10)}%20${ERICSSON.slice(10)}${extension}`,
      `/lei/${ERICSSON}${extension}/`,
      `/lei/${ERICSSON.toLowerCase()}${extension}?utm=x`,
    ]) {
      const t = harness();
      const response = await t.get(path);
      expect(response.status, path).toBe(301);
      expect(response.headers.get("location"), path).toBe(`${ORIGIN}/lei/${ERICSSON}${extension}`);
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(t.gleif.calls, path).toEqual([]);
    }
  });

  it("redirects to CANONICAL_ORIGIN when it is set", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON.toLowerCase()}.json`, undefined, {
      CANONICAL_ORIGIN: "https://whichlei.com",
    });
    expect(response.headers.get("location")).toBe(`https://whichlei.com/lei/${ERICSSON}.json`);
  });

  it("does not mix the extension into the page's redirects", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON.toLowerCase()}`);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/lei/${ERICSSON}`);
  });
});

describe("answers that are not a record, in the format asked for", () => {
  it("404 for check digits that do not match, without calling GLEIF", async () => {
    const t = harness();
    const json = await t.get(`/lei/${BAD_DIGITS}.json`);
    expect(json.status).toBe(404);
    expect(json.headers.get("content-type")).toBe(JSON_TYPE);
    expect(JSON.parse(await json.text())).toEqual({
      error: "Not a valid LEI",
      detail: `${BAD_DIGITS} is not an LEI: its check digits do not match (ISO 7064 mod 97-10). Check what you typed.`,
    });
    const markdown = await t.get(`/lei/${BAD_DIGITS}.md`);
    expect(markdown.status).toBe(404);
    expect(markdown.headers.get("content-type")).toBe(MARKDOWN_TYPE);
    expect(await markdown.text()).toBe(
      `# Not a valid LEI\n\n${BAD_DIGITS} is not an LEI: its check digits do not match (ISO 7064 mod 97-10). Check what you typed.\n`,
    );
    expect(t.gleif.calls).toEqual([]);
    expect(t.cache.puts).toEqual([]);
  });

  it("404 for something that is not an LEI", async () => {
    const t = harness();
    for (const [path, type] of [
      ["/lei/nonsense.json", JSON_TYPE],
      ["/lei/nonsense.md", MARKDOWN_TYPE],
      ["/lei/.json", "text/html; charset=utf-8"],
    ] as const) {
      const response = await t.get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe(type);
    }
    const json = await (await t.get("/lei/nonsense.json")).json();
    expect(json).toMatchObject({ error: "Not an LEI" });
    expect(t.gleif.calls).toEqual([]);
  });

  it("404 for an LEI GLEIF does not have, and caches it for an hour for every format", async () => {
    const t = harness();
    const json = await t.get(`/lei/${UNKNOWN}.json`);
    expect(json.status).toBe(404);
    expect(json.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(JSON.parse(await json.text())).toEqual({
      error: "No such LEI",
      detail: `GLEIF has no record for ${UNKNOWN}. The code is well formed, but no entity has it.`,
    });
    expect(t.cache.puts).toEqual([
      { url: `${ORIGIN}/lei/${UNKNOWN}?doc=1`, status: 404, cacheControl: "public, max-age=3600" },
    ]);

    // The other formats are served from the same entry.
    const markdown = await t.get(`/lei/${UNKNOWN}.md`);
    expect(markdown.status).toBe(404);
    expect(markdown.headers.get("x-cache")).toBe("HIT");
    expect(await markdown.text()).toBe(
      `# No such LEI\n\nGLEIF has no record for ${UNKNOWN}. The code is well formed, but no entity has it.\n`,
    );
    const page = await t.get(`/lei/${UNKNOWN}`);
    expect(page.status).toBe(404);
    expect(page.headers.get("x-cache")).toBe("HIT");
    expect(await page.text()).toContain("<h1>No such LEI</h1>");
    expect((await t.get(`/lei/${UNKNOWN}`, asking("application/json"))).status).toBe(404);
    expect(t.gleif.calls).toHaveLength(1);
    expect(t.cache.puts).toHaveLength(1);
  });

  it("503 with Retry-After when GLEIF fails, never cached", async () => {
    for (const [extension, type] of [
      [".json", JSON_TYPE],
      [".md", MARKDOWN_TYPE],
    ] as const) {
      const t = harness({
        gleif: fakeGleif(
          () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
        ),
      });
      const response = await t.get(`/lei/${ERICSSON}${extension}`);
      expect(response.status, extension).toBe(503);
      expect(response.headers.get("content-type"), extension).toBe(type);
      expect(response.headers.get("retry-after"), extension).toBe("120");
      expect(response.headers.get("cache-control"), extension).toBe("no-store");
      expect(response.headers.get("x-robots-tag"), extension).toBe("noindex");
      expect(response.headers.get("link"), extension).toBe(
        `<${ORIGIN}/lei/${ERICSSON}>; rel="canonical"`,
      );
      expect(t.cache.puts, extension).toEqual([]);
    }
    const t = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    expect(JSON.parse(await (await t.get(`/lei/${ERICSSON}.json`)).text())).toMatchObject({
      error: "Try again shortly",
    });
    expect(await (await t.get(`/lei/${ERICSSON}.md`)).text()).toMatch(/^# Try again shortly\n\n/);
  });

  it("sends noindex on every answer at a .json or .md URL, indexing on or not", async () => {
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    for (const extension of [".json", ".md"]) {
      const t = harness();
      for (const path of [
        `/lei/${ERICSSON}${extension}`,
        `/lei/${UNKNOWN}${extension}`,
        `/lei/${BAD_DIGITS}${extension}`,
        `/lei/${ERICSSON.toLowerCase()}${extension}`,
        `/lei/nonsense${extension}`,
      ]) {
        const response = await t.get(path, undefined, launched);
        expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
      }
      const response = await failing.get(`/lei/${ERICSSON}${extension}`, undefined, launched);
      expect(response.headers.get("x-robots-tag"), extension).toBe("noindex");
    }
  });
});

describe("content negotiation on /lei/<LEI>", () => {
  it("answers HTML without an Accept header, for */*, and for what a browser sends", async () => {
    const t = harness();
    for (const accept of [
      undefined,
      "*/*",
      "text/html",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "application/json, text/html",
      "image/png",
    ]) {
      const response = await t.get(`/lei/${ERICSSON}`, accept ? asking(accept) : undefined);
      expect(response.headers.get("content-type"), String(accept)).toBe("text/html; charset=utf-8");
    }
  });

  it("answers Markdown when text/markdown ranks above text/html", async () => {
    const t = harness();
    for (const accept of [
      "text/markdown",
      "text/markdown, text/html;q=0.9",
      "text/markdown, */*;q=0.1",
      "TEXT/MARKDOWN",
    ]) {
      const response = await t.get(`/lei/${ERICSSON}`, asking(accept));
      expect(response.status, accept).toBe(200);
      expect(response.headers.get("content-type"), accept).toBe(MARKDOWN_TYPE);
    }
    const same = await (await t.get(`/lei/${ERICSSON}.md`)).text();
    expect(await (await t.get(`/lei/${ERICSSON}`, asking("text/markdown"))).text()).toBe(same);
  });

  it("answers JSON when application/json ranks above text/html", async () => {
    const t = harness();
    for (const accept of ["application/json", "application/json, text/html;q=0.5"]) {
      const response = await t.get(`/lei/${ERICSSON}`, asking(accept));
      expect(response.headers.get("content-type"), accept).toBe(JSON_TYPE);
    }
    const same = await (await t.get(`/lei/${ERICSSON}.json`)).text();
    expect(await (await t.get(`/lei/${ERICSSON}`, asking("application/json"))).text()).toBe(same);
  });

  it("goes by weight: Markdown, JSON or the page, whichever ranks highest", async () => {
    const t = harness();
    const type = async (accept: string) =>
      (await t.get(`/lei/${ERICSSON}`, asking(accept))).headers.get("content-type");
    expect(await type("text/html;q=0.5, application/json;q=0.6, text/markdown;q=0.7")).toBe(
      MARKDOWN_TYPE,
    );
    expect(await type("text/html;q=0.5, application/json;q=0.8, text/markdown;q=0.7")).toBe(
      JSON_TYPE,
    );
    expect(await type("text/html;q=0.9, application/json;q=0.8, text/markdown;q=0.7")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await type("text/html, text/markdown")).toBe("text/html; charset=utf-8");
  });

  it("follows the indexing setting like the page, and points at the page with a canonical Link", async () => {
    const t = harness();
    for (const accept of ["text/markdown", "application/json", "text/html"]) {
      // The canonical URL itself: indexable on the canonical host, with indexing on.
      const open = await t.get(`/lei/${ERICSSON}`, asking(accept), launched);
      expect(open.headers.get("x-robots-tag"), accept).toBeNull();
      // Not indexable: indexing off, or no canonical origin.
      for (const env of [
        {},
        { ...launched, ALLOW_INDEXING: "false" },
        { ALLOW_INDEXING: "true" },
      ]) {
        const closed = await t.get(`/lei/${ERICSSON}`, asking(accept), env);
        expect(closed.headers.get("x-robots-tag"), `${accept} ${JSON.stringify(env)}`).toBe(
          "noindex",
        );
      }
      // Not on the canonical host.
      const elsewhere = harness({ origin: "https://whichlei-site.example.workers.dev" });
      const preview = await elsewhere.get(`/lei/${ERICSSON}`, asking(accept), launched);
      expect(preview.headers.get("x-robots-tag"), accept).toBe("noindex");
    }
    for (const accept of ["text/markdown", "application/json"]) {
      const response = await t.get(`/lei/${ERICSSON}`, asking(accept), launched);
      expect(response.headers.get("link"), accept).toBe(
        `<${ORIGIN}/lei/${ERICSSON}>; rel="canonical"`,
      );
    }
    const page = await t.get(`/lei/${ERICSSON}`, asking("text/html"), launched);
    expect(page.headers.get("link")).toBeNull();
  });

  it("follows the setting on errors too: a 404 or 503 in Markdown or JSON", async () => {
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    const t = harness();
    for (const accept of ["text/markdown", "application/json"]) {
      for (const [harnessed, path] of [
        [t, `/lei/${UNKNOWN}`],
        [t, `/lei/${BAD_DIGITS}`],
        [failing, `/lei/${ERICSSON}`],
      ] as const) {
        const open = await harnessed.get(path, asking(accept), launched);
        expect(open.headers.get("x-robots-tag"), `${accept} ${path}`).toBeNull();
        const closed = await harnessed.get(path, asking(accept));
        expect(closed.headers.get("x-robots-tag"), `${accept} ${path}`).toBe("noindex");
      }
    }
  });

  it("answers errors in the format asked for", async () => {
    const t = harness();
    const json = await t.get(`/lei/${BAD_DIGITS}`, asking("application/json"));
    expect(json.status).toBe(404);
    expect(json.headers.get("content-type")).toBe(JSON_TYPE);
    expect(JSON.parse(await json.text())).toMatchObject({ error: "Not a valid LEI" });
    const markdown = await t.get("/lei/nonsense", asking("text/markdown"));
    expect(markdown.status).toBe(404);
    expect(await markdown.text()).toMatch(/^# Not an LEI\n\n/);
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    const unavailable = await failing.get(`/lei/${ERICSSON}`, asking("text/markdown"));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("content-type")).toBe(MARKDOWN_TYPE);
    expect(unavailable.headers.get("retry-after")).toBe("60");
  });

  it("keeps the asked-for format through a redirect: the client asks again with its Accept", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON.toLowerCase()}`, asking("application/json"));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/lei/${ERICSSON}`);
  });

  it("does not negotiate on a URL with an extension: the extension wins", async () => {
    const t = harness();
    const response = await t.get(`/lei/${ERICSSON}.json`, asking("text/markdown"));
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
  });
});

describe("Vary: Accept", () => {
  it("is on every answer for /lei/<LEI>, whatever its status or format", async () => {
    const failing = harness({ gleif: fakeGleif(() => new Response("boom", { status: 500 })) });
    const t = harness();
    const answers = [
      await t.get(`/lei/${ERICSSON}`), // 200, a miss
      await t.get(`/lei/${ERICSSON}`), // 200, a hit
      await t.get(`/lei/${ERICSSON}`, asking("text/markdown")),
      await t.get(`/lei/${ERICSSON}`, asking("application/json")),
      await t.get(`/lei/${ERICSSON}`, { method: "HEAD" }),
      await t.get(`/lei/${UNKNOWN}`), // 404 from GLEIF
      await t.get(`/lei/${UNKNOWN}`), // 404 from the cache
      await t.get(`/lei/${BAD_DIGITS}`), // 404 without GLEIF
      await t.get("/lei/nonsense"), // 404, not an LEI
      await t.get(`/lei/${ERICSSON.toLowerCase()}`), // 301
      await t.get(`/lei/${ERICSSON}`, { method: "POST" }), // 405
      await failing.get(`/lei/${ERICSSON}`), // 503
    ];
    expect(answers.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 404, 404, 404, 404, 301, 405, 503,
    ]);
    for (const response of answers) expect(response.headers.get("vary")).toBe("accept");
  });

  it("is not on robots.txt or on a URL that has an extension", async () => {
    const t = harness();
    expect((await t.get("/robots.txt")).headers.get("vary")).toBeNull();
    expect((await t.get(`/lei/${ERICSSON}.json`)).headers.get("vary")).toBeNull();
    expect((await t.get(`/lei/${BAD_DIGITS}.md`)).headers.get("vary")).toBeNull();
  });
});

describe("one cached document for every format", () => {
  it("makes one GLEIF call and one cache entry, and serves the page, JSON and Markdown from it", async () => {
    const t = harness();
    t.setNow("2026-09-30T10:00:00Z");
    const page = await t.get(`/lei/${ERICSSON}`);
    expect(page.headers.get("x-cache")).toBe("MISS");
    expect(t.cache.puts).toEqual([
      {
        url: `${ORIGIN}/lei/${ERICSSON}?doc=1`,
        status: 200,
        cacheControl: "public, max-age=82800",
      },
    ]);

    for (const [path, init] of [
      [`/lei/${ERICSSON}.json`, undefined],
      [`/lei/${ERICSSON}.md`, undefined],
      [`/lei/${ERICSSON}`, asking("application/json")],
      [`/lei/${ERICSSON}`, asking("text/markdown")],
      [`/lei/${ERICSSON}`, undefined],
    ] as const) {
      const response = await t.get(path, init);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("x-cache"), path).toBe("HIT");
      expect(response.headers.get("cache-control"), path).toBe("public, max-age=3600");
    }
    expect(t.gleif.calls).toHaveLength(1);
    expect(t.cache.puts).toHaveLength(1);
  });

  it("serves the same page from the cache as it rendered on the miss", async () => {
    const t = harness();
    const first = await (await t.get(`/lei/${ERICSSON}`)).text();
    const second = await (await t.get(`/lei/${ERICSSON}`)).text();
    expect(second).toBe(first);
  });

  it("starts with JSON or Markdown as well as with the page", async () => {
    for (const first of [`/lei/${ERICSSON}.json`, `/lei/${ERICSSON}.md`]) {
      const t = harness();
      expect((await t.get(first)).headers.get("x-cache")).toBe("MISS");
      const page = await t.get(`/lei/${ERICSSON}`);
      expect(page.headers.get("x-cache"), first).toBe("HIT");
      expect(await page.text()).toContain('<h1 class="title">');
      expect(t.gleif.calls, first).toHaveLength(1);
    }
  });

  it("stores the document, not a rendered page", async () => {
    const t = harness();
    await t.get(`/lei/${ERICSSON}`);
    const hit = await t.cache.match(new Request(`${ORIGIN}/lei/${ERICSSON}?doc=1`));
    expect(hit?.headers.get("content-type")).toBe("application/json");
    const stored = JSON.parse((await hit?.text()) ?? "");
    expect(stored.lei).toBe(ERICSSON);
    expect(stored.url).toBe(`${ORIGIN}/lei/${ERICSSON}`);
  });

  it("never reads an entry the production Worker before this one wrote under the page's URL", async () => {
    for (const [path, init] of [
      [`/lei/${ERICSSON}`, undefined],
      [`/lei/${ERICSSON}.json`, undefined],
      [`/lei/${ERICSSON}`, asking("text/markdown")],
    ] as const) {
      const t = harness();
      await t.cache.put(
        new Request(`${ORIGIN}/lei/${ERICSSON}`),
        new Response("<!doctype html><title>an old rendered page</title>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }),
      );
      t.cache.puts.length = 0;
      const response = await t.get(path, init);
      expect(response.headers.get("x-cache"), path).toBe("MISS");
      expect(await response.text(), path).not.toContain("an old rendered page");
      expect(t.gleif.calls, path).toHaveLength(1);
      expect(
        t.cache.puts.map((put) => put.url),
        path,
      ).toEqual([`${ORIGIN}/lei/${ERICSSON}?doc=1`]);
    }
  });

  it("treats an entry under the document's key that is not a document as a miss, and replaces it", async () => {
    for (const body of ["<html>old page</html>", "{}", "null", ""]) {
      const t = harness();
      await t.cache.put(
        new Request(`${ORIGIN}/lei/${ERICSSON}?doc=1`),
        new Response(body, { headers: { "cache-control": "public, max-age=3600" } }),
      );
      t.cache.puts.length = 0;
      const response = await t.get(`/lei/${ERICSSON}.json`);
      expect(response.status, body).toBe(200);
      expect(response.headers.get("x-cache"), body).toBe("MISS");
      expect(JSON.parse(await response.text()).lei, body).toBe(ERICSSON);
      expect(t.cache.puts, body).toHaveLength(1);
    }
  });

  it("keeps the 5 minutes of a record that lacks names, for every format and for browsers", async () => {
    // The index host is down: the names of the codes are missing.
    const env = { INDEX_ORIGIN: "https://index.test" };
    const real = fakeGleif();
    const t = harness({
      gleif: fakeGleif((url, init) =>
        url.startsWith("https://index.test")
          ? new Response("boom", { status: 500 })
          : real.fetch(url, init),
      ),
    });
    const miss = await t.get(`/lei/${ERICSSON}.json`, undefined, env);
    expect(miss.headers.get("cache-control")).toBe("public, max-age=300");
    expect(t.cache.puts.find((put) => put.url.endsWith("?doc=1"))?.cacheControl).toBe(
      "public, max-age=300",
    );
    for (const [path, init] of [
      [`/lei/${ERICSSON}.md`, undefined],
      [`/lei/${ERICSSON}`, asking("application/json")],
      [`/lei/${ERICSSON}`, undefined],
    ] as const) {
      const hit = await t.get(path, init, env);
      expect(hit.headers.get("x-cache"), path).toBe("HIT");
      expect(hit.headers.get("cache-control"), path).toBe("public, max-age=300");
    }
  });

  it("serves from the Worker without a cache", async () => {
    const t = harness();
    t.cache.fail = true;
    for (const path of [`/lei/${ERICSSON}.json`, `/lei/${ERICSSON}.md`, `/lei/${ERICSSON}`]) {
      expect((await t.get(path)).status, path).toBe(200);
    }
    expect(t.gleif.calls).toHaveLength(3);
  });
});
