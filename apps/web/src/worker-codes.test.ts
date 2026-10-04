// The record page with the names of its codes, read from the published index.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeGleif, harness, leiOf } from "./test-helpers.ts";

const INDEX = "https://index.test";
const BUILD = "20260916-3f9a1c0e";
const CODES_JSON = readFileSync(new URL("../fixtures/codes.json", import.meta.url), "utf8");
const ERICSSON = leiOf("record-ericsson");
const env = { INDEX_ORIGIN: INDEX };

const field = (page: string, name: string) =>
  new RegExp(`<dd data-field="${name}">(.*?)</dd>`, "s").exec(page)?.[1]?.replace(/<[^>]*>/g, "");

/** GLEIF from the fixtures, and the index host, in one `fetch`. `indexAnswer` is the host. */
function world(
  indexAnswer: (url: string) => Response | Promise<Response> = (url) => {
    if (url === `${INDEX}/index.json`) return new Response(JSON.stringify({ build: BUILD }));
    if (url === `${INDEX}/${BUILD}/codes.json`) return new Response(CODES_JSON);
    return new Response("not found", { status: 404 });
  },
) {
  const gleif = fakeGleif();
  const calls: string[] = [];
  return {
    calls,
    indexCalls: () => calls.filter((url) => url.startsWith(INDEX)),
    gleif: {
      calls,
      fetch: (url: string, init?: RequestInit) => {
        calls.push(url);
        return url.startsWith(INDEX) ? Promise.resolve(indexAnswer(url)) : gleif.fetch(url, init);
      },
    },
  };
}

describe("a record page with the names of its codes", () => {
  it("shows the legal form and the register by name, with the codes beside them", async () => {
    const w = world();
    const t = harness({ gleif: w.gleif });
    const response = await t.get(`/lei/${ERICSSON}`, undefined, env);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(field(page, "legal-form")).toBe("Aktiebolag XJHM");
    expect(field(page, "register")).toBe("556016-0680 Bolagsverket · RA000544");
    expect(w.indexCalls()).toEqual([`${INDEX}/index.json`, `${INDEX}/${BUILD}/codes.json`]);
  });

  it("keeps the record page in the cache for as long as without names", async () => {
    const t = harness({ gleif: world().gleif });
    await t.get(`/lei/${ERICSSON}`, undefined, env);
    const page = t.cache.puts.find((put) => put.url.endsWith(`/lei/${ERICSSON}?doc=1`));
    expect(page?.cacheControl).toBe("public, max-age=82800");
  });

  it("reads the names once for the records that follow, within the Worker's memory", async () => {
    const w = world();
    const t = harness({ gleif: w.gleif });
    await t.get(`/lei/${ERICSSON}`, undefined, env);
    await t.get(`/lei/${leiOf("record-lapsed")}`, undefined, env);
    expect(w.indexCalls()).toHaveLength(2);
  });

  it("does not ask the index host for a page that is served from the cache", async () => {
    const w = world();
    const t = harness({ gleif: w.gleif });
    await t.get(`/lei/${ERICSSON}`, undefined, env);
    const before = w.calls.length;
    const hit = await t.get(`/lei/${ERICSSON}`, undefined, env);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(w.calls).toHaveLength(before);
  });

  it("shows the codes alone for a code the file has no name for", async () => {
    const w = world((url) =>
      url.endsWith("index.json")
        ? new Response(JSON.stringify({ build: BUILD }))
        : new Response(JSON.stringify({ elf: { XJHM: "Aktiebolag" }, ra: {} })),
    );
    const t = harness({ gleif: w.gleif });
    const page = await (await t.get(`/lei/${ERICSSON}`, undefined, env)).text();
    expect(field(page, "legal-form")).toBe("Aktiebolag XJHM");
    expect(field(page, "register")).toBe("556016-0680 RA000544");
  });

  it("asks the index host for nothing when INDEX_ORIGIN is not set", async () => {
    const w = world();
    const t = harness({ gleif: w.gleif });
    const page = await (await t.get(`/lei/${ERICSSON}`)).text();
    expect(w.indexCalls()).toEqual([]);
    expect(field(page, "legal-form")).toBe("XJHM");
    // Nothing was missing that should have been there: kept as long as ever.
    expect(t.cache.puts[0]?.cacheControl).toBe("public, max-age=82800");
  });
});

describe("when the index host fails", () => {
  it.each([
    ["is down", () => Promise.reject(new TypeError("fetch failed"))],
    ["answers 500", () => new Response("boom", { status: 500 })],
    ["answers nonsense", () => new Response("<html>")],
  ])("still answers 200 with the codes, and keeps the page 5 minutes: it %s", async (_, answer) => {
    const t = harness({ gleif: world(answer).gleif });
    const response = await t.get(`/lei/${ERICSSON}`, undefined, env);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Telefonaktiebolaget LM Ericsson");
    expect(field(page, "legal-form")).toBe("XJHM");
    expect(field(page, "register")).toBe("556016-0680 RA000544");
    // The names may be there next time: do not keep this page for a day.
    expect(t.cache.puts[0]?.cacheControl).toBe("public, max-age=300");
    // Nor does a browser, on the first view or from the cache.
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const hit = await t.get(`/lei/${ERICSSON}`, undefined, env);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("does not wait long for a host that does not answer", async () => {
    const w = world();
    const t = harness({
      indexTimeoutMs: 30,
      gleif: {
        calls: [],
        fetch: (url, init) =>
          url.startsWith(INDEX)
            ? new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
              })
            : w.gleif.fetch(url, init),
      },
    });
    const started = Date.now();
    const response = await t.get(`/lei/${ERICSSON}`, undefined, env);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("never turns a record into an error page", async () => {
    const t = harness({ gleif: world(() => Promise.reject(new Error("x"))).gleif });
    expect((await t.get(`/lei/${ERICSSON}`, undefined, env)).status).toBe(200);
  });

  it("does not read the names for an LEI GLEIF does not have, or cannot answer for", async () => {
    const w = world();
    const t = harness({ gleif: w.gleif });
    expect((await t.get("/lei/549300ZZZZZZZZZZZZ46", undefined, env)).status).toBe(404);
    expect(w.indexCalls()).toEqual([]);

    const down = world();
    const failing = harness({
      gleif: {
        calls: [],
        fetch: (url, init) =>
          url.startsWith(INDEX) ? down.gleif.fetch(url, init) : Promise.reject(new Error("down")),
      },
    });
    expect((await failing.get(`/lei/${ERICSSON}`, undefined, env)).status).toBe(503);
    expect(down.indexCalls()).toEqual([]);
  });
});
