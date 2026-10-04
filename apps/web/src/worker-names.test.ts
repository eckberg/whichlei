// The names of the entities a record links to: one batched GLEIF call after the record, none
// when there is nothing to name, and a page without names (kept briefly) when it fails.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fakeGleif, harness, isNamesRequest, leiOf } from "./test-helpers.ts";

const ERICSSON = leiOf("record-ericsson");
const SUBSIDIARY = leiOf("record-subsidiary");
const LOU = "549300O897ZC5H7CY412";
const ORIGIN = "https://whichlei.test";
const INDEX = "https://index.test";
const BUILD = "20260916-3f9a1c0e";
const CODES_JSON = readFileSync(new URL("../fixtures/codes.json", import.meta.url), "utf8");
const NAME = "Telefonaktiebolaget LM Ericsson";

const field = (page: string, name: string) =>
  new RegExp(`<dd data-field="${name}">(.*?)</dd>`, "s").exec(page)?.[1];

/** The names requests among a fake GLEIF's calls. */
const nameCalls = (calls: string[]) => calls.filter((url) => isNamesRequest(url));

/** A fake GLEIF that answers a request for names as `names` says, and the rest from fixtures. */
function gleifWith(names: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const real = fakeGleif();
  return fakeGleif((url, init) => (isNamesRequest(url) ? names(url, init) : real.fetch(url, init)));
}

describe("a record that links to a parent", () => {
  it("asks GLEIF for the parent's name in one call, and shows it", async () => {
    const t = harness();
    const response = await t.get(`/lei/${SUBSIDIARY}`);
    expect(response.status).toBe(200);
    const page = await response.text();
    const link = `<a href="/lei/${ERICSSON}">${NAME}</a> <span class="none">${ERICSSON}</span>`;
    expect(field(page, "parent")).toBe(link);
    expect(field(page, "ultimate-parent")).toBe(link);
    // The record, then one call for the names: the direct and the ultimate parent are one LEI.
    expect(t.gleif.calls).toHaveLength(2);
    expect(t.gleif.calls[1]).toBe(
      `https://api.gleif.org/api/v1/lei-records?filter%5Blei%5D=${ERICSSON}&page%5Bsize%5D=1`,
    );
  });

  it("puts the name in the JSON document, the Markdown and the JSON-LD", async () => {
    const t = harness();
    const doc = JSON.parse(await (await t.get(`/lei/${SUBSIDIARY}.json`)).text());
    expect(doc.directParent).toEqual({ kind: "reported", lei: ERICSSON, name: NAME });
    expect(doc.ultimateParent).toEqual({ kind: "reported", lei: ERICSSON, name: NAME });
    const markdown = await (await t.get(`/lei/${SUBSIDIARY}.md`)).text();
    expect(markdown).toContain(`- **parent:** [${NAME}](${ORIGIN}/lei/${ERICSSON}) (${ERICSSON})`);
    const page = await (await t.get(`/lei/${SUBSIDIARY}`)).text();
    const ld = JSON.parse(
      /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "",
    );
    expect(ld.parentOrganization.name).toBe(NAME);
    // One lookup for all three: they share the cached document.
    expect(t.gleif.calls).toHaveLength(2);
  });

  it("keeps the names in the cache: a hit calls GLEIF for nothing", async () => {
    const t = harness();
    await t.get(`/lei/${SUBSIDIARY}`);
    const hit = await t.get(`/lei/${SUBSIDIARY}`);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(field(await hit.text(), "parent")).toContain(`>${NAME}</a>`);
    expect(t.gleif.calls).toHaveLength(2);
    expect(t.cache.puts).toHaveLength(1);
    expect(t.cache.puts[0]?.cacheControl).toBe("public, max-age=82800");
  });

  it("is a page like any other when GLEIF does not know the parent: the LEI, and a full day", async () => {
    const t = harness({ gleif: gleifWith(() => new Response(JSON.stringify({ data: [] }))) });
    const response = await t.get(`/lei/${SUBSIDIARY}`);
    expect(field(await response.text(), "parent")).toBe(
      `<a href="/lei/${ERICSSON}">${ERICSSON}</a>`,
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(t.cache.puts[0]?.cacheControl).toBe("public, max-age=82800");
  });

  it("ignores a name for an LEI it did not ask about", async () => {
    const t = harness({
      gleif: gleifWith(
        () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  type: "lei-records",
                  id: LOU,
                  attributes: { lei: LOU, entity: { legalName: { name: "Not asked" } } },
                },
              ],
            }),
          ),
      ),
    });
    const doc = JSON.parse(await (await t.get(`/lei/${SUBSIDIARY}.json`)).text());
    expect(doc.directParent).toEqual({ kind: "reported", lei: ERICSSON });
    expect(JSON.stringify(doc)).not.toContain("Not asked");
  });
});

describe("a record with nothing to name", () => {
  it.each(["record-ericsson", "record-branch", "record-exception", "record-retired"])(
    "makes no names call for %s",
    async (name) => {
      const t = harness();
      expect((await t.get(`/lei/${leiOf(name)}`)).status).toBe(200);
      expect(t.gleif.calls, name).toHaveLength(1);
      expect(nameCalls(t.gleif.calls), name).toEqual([]);
    },
  );

  it("does not name the record itself, whoever claims to be its parent", async () => {
    const real = fakeGleif();
    const t = harness({
      gleif: fakeGleif(async (url, init) => {
        const response = await real.fetch(url, init);
        const body = (await response.json()) as {
          data?: { relationships?: Record<string, { data: { type: string; id: string } }> };
        };
        const parent = body.data?.relationships?.["direct-parent"];
        if (parent) parent.data = { type: "lei-records", id: SUBSIDIARY };
        const ultimate = body.data?.relationships?.["ultimate-parent"];
        if (ultimate) ultimate.data = { type: "lei-records", id: SUBSIDIARY };
        return new Response(JSON.stringify(body));
      }),
    });
    expect((await t.get(`/lei/${SUBSIDIARY}`)).status).toBe(200);
    expect(nameCalls(t.gleif.calls)).toEqual([]);
  });
});

describe("successors", () => {
  /** Ericsson's fixture with successors of the given kind. */
  const withSuccessors = (successors: unknown[]) => {
    const real = fakeGleif();
    return fakeGleif(async (url, init) => {
      const response = await real.fetch(url, init);
      if (isNamesRequest(url)) return response;
      const body = (await response.json()) as {
        data: { attributes: { entity: { successorEntities?: unknown[] } } };
      };
      body.data.attributes.entity.successorEntities = successors;
      return new Response(JSON.stringify(body));
    });
  };

  it("names a successor that has an LEI and no name, and not one that has a name", async () => {
    const gleif = withSuccessors([
      { lei: SUBSIDIARY, name: null },
      { lei: LOU, name: "Given by GLEIF" },
      { lei: null, name: "No LEI" },
    ]);
    const t = harness({ gleif });
    const page = await (await t.get(`/lei/${ERICSSON}`)).text();
    expect(nameCalls(gleif.calls)).toEqual([
      `https://api.gleif.org/api/v1/lei-records?filter%5Blei%5D=${SUBSIDIARY}&page%5Bsize%5D=1`,
    ]);
    expect(field(page, "successors")).toBe(
      `<div><a href="/lei/${SUBSIDIARY}">VONAGE BUSINESS INC.</a> <span class="none">${SUBSIDIARY}</span></div>` +
        `<div><a href="/lei/${LOU}">Given by GLEIF</a> <span class="none">${LOU}</span></div>` +
        "<div>No LEI</div>",
    );
    const doc = JSON.parse(await (await t.get(`/lei/${ERICSSON}.json`)).text());
    expect(doc.successors).toEqual([
      { lei: SUBSIDIARY, name: "VONAGE BUSINESS INC." },
      { lei: LOU, name: "Given by GLEIF" },
      { lei: null, name: "No LEI" },
    ]);
  });

  it("asks about every LEI at once, each once, and at most 50", async () => {
    const leis = Array.from(
      { length: 70 },
      (_, i) => `54930000000000000${String(i).padStart(3, "0")}`,
    );
    const gleif = withSuccessors(
      leis.map((lei) => ({ lei, name: null })).concat({ lei: leis[0] ?? "", name: null }),
    );
    const t = harness({ gleif });
    expect((await t.get(`/lei/${ERICSSON}`)).status).toBe(200);
    const calls = nameCalls(gleif.calls);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("filter[lei]")?.split(",")).toEqual(leis.slice(0, 50));
    expect(url.searchParams.get("page[size]")).toBe("50");
  });
});

describe("when the names cannot be had", () => {
  it.each([
    ["is unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    ["answers 500", () => new Response("boom", { status: 500 })],
    [
      "answers 429",
      () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    ],
    ["answers 404", () => new Response("<html>Not found</html>", { status: 404 })],
    ["sends nonsense", () => new Response("<html>maintenance</html>")],
    ["sends JSON that is not a list", () => new Response('{"data":null}')],
  ])("still answers the page, with the LEI, for 5 minutes: GLEIF %s", async (_, answer) => {
    const t = harness({ gleif: gleifWith(answer) });
    const response = await t.get(`/lei/${SUBSIDIARY}`);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("VONAGE BUSINESS INC.");
    expect(field(page, "parent")).toBe(`<a href="/lei/${ERICSSON}">${ERICSSON}</a>`);
    // Neither we nor the browser keep a page that may get its names a minute later.
    expect(t.cache.puts).toEqual([
      {
        url: `${ORIGIN}/lei/${SUBSIDIARY}?doc=1`,
        status: 200,
        cacheControl: "public, max-age=300",
      },
    ]);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const hit = await t.get(`/lei/${SUBSIDIARY}`);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("also for the JSON and the Markdown, which carry no name then", async () => {
    const t = harness({ gleif: gleifWith(() => new Response("boom", { status: 500 })) });
    const json = await t.get(`/lei/${SUBSIDIARY}.json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("cache-control")).toBe("public, max-age=300");
    expect(JSON.parse(await json.text()).directParent).toEqual({ kind: "reported", lei: ERICSSON });
    const markdown = await (await t.get(`/lei/${SUBSIDIARY}.md`)).text();
    expect(markdown).toContain(`- **parent:** [${ERICSSON}](${ORIGIN}/lei/${ERICSSON})\n`);
  });

  it("does not wait long for a GLEIF that does not answer the names call", async () => {
    const t = harness({
      namesTimeoutMs: 30,
      gleif: gleifWith(
        (_, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    });
    const started = Date.now();
    const response = await t.get(`/lei/${SUBSIDIARY}`);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.cache.puts[0]?.cacheControl).toBe("public, max-age=300");
  });

  it("is not a 503: a failing names call never fails the page", async () => {
    const t = harness({ gleif: gleifWith(() => Promise.reject(new Error("x"))) });
    expect((await t.get(`/lei/${SUBSIDIARY}.json`)).status).toBe(200);
  });
});

describe("with the codes from the index host", () => {
  const env = { INDEX_ORIGIN: INDEX };

  /** One `fetch` for GLEIF and the index host, each held until `release` if `hold` says so. */
  function world(options: { hold?: boolean } = {}) {
    const gleif = fakeGleif();
    const calls: string[] = [];
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      started,
      release: () => release(),
      gleif: {
        calls,
        fetch: async (url: string, init?: RequestInit) => {
          calls.push(url);
          const isIndex = url.startsWith(INDEX);
          if (isIndex || isNamesRequest(url)) {
            started.push(isIndex ? "codes" : "names");
            if (options.hold) await gate;
          }
          if (url === `${INDEX}/index.json`) return new Response(JSON.stringify({ build: BUILD }));
          if (url === `${INDEX}/${BUILD}/codes.json`) return new Response(CODES_JSON);
          return gleif.fetch(url, init);
        },
      },
    };
  }

  it("asks for the names while it asks for the codes, not after", async () => {
    const w = world({ hold: true });
    const t = harness({ gleif: w.gleif });
    const pending = t.get(`/lei/${SUBSIDIARY}`, undefined, env);
    // Both are under way before either has answered.
    await vi.waitFor(() => expect([...w.started].sort()).toEqual(["codes", "names"]));
    w.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(field(await response.text(), "parent")).toContain(`>${NAME}</a>`);
  });

  it("names the codes in the document", async () => {
    const t = harness({ gleif: world().gleif });
    const doc = JSON.parse(await (await t.get(`/lei/${ERICSSON}.json`, undefined, env)).text());
    expect(doc.legalForm).toEqual({ code: "XJHM", other: null, name: "Aktiebolag" });
    expect(doc.registrationAuthority).toEqual({
      id: "RA000544",
      other: null,
      name: "Bolagsverket",
    });
    const markdown = await (await t.get(`/lei/${ERICSSON}.md`, undefined, env)).text();
    expect(markdown).toContain("- **legal form:** Aktiebolag (XJHM)\n");
  });

  it("keeps the full time when both came", async () => {
    const t = harness({ gleif: world().gleif });
    await t.get(`/lei/${SUBSIDIARY}`, undefined, env);
    expect(t.cache.puts.find((put) => put.url.endsWith("?doc=1"))?.cacheControl).toBe(
      "public, max-age=82800",
    );
  });

  it("is degraded when only the names failed, and when only the codes failed", async () => {
    const real = world();
    const namesDown = harness({
      gleif: {
        calls: [],
        fetch: (url, init) =>
          isNamesRequest(url)
            ? Promise.resolve(new Response("boom", { status: 500 }))
            : real.gleif.fetch(url, init),
      },
    });
    await namesDown.get(`/lei/${SUBSIDIARY}`, undefined, env);
    expect(namesDown.cache.puts.find((put) => put.url.endsWith("?doc=1"))?.cacheControl).toBe(
      "public, max-age=300",
    );

    const codesDown = harness({
      gleif: {
        calls: [],
        fetch: (url, init) =>
          url.startsWith(INDEX)
            ? Promise.resolve(new Response("boom", { status: 500 }))
            : real.gleif.fetch(url, init),
      },
    });
    const page = await (await codesDown.get(`/lei/${SUBSIDIARY}`, undefined, env)).text();
    // The names did arrive.
    expect(field(page, "parent")).toContain(`>${NAME}</a>`);
    expect(codesDown.cache.puts.find((put) => put.url.endsWith("?doc=1"))?.cacheControl).toBe(
      "public, max-age=300",
    );
  });
});
