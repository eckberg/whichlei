import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODES_RETRY_MS,
  CODES_TTL_MS,
  type CodesDeps,
  createCodesReader,
  parseCodes,
} from "./codes.ts";
import { fakeCache } from "./test-helpers.ts";

const ORIGIN = "https://index.test";
const BUILD = "20260916-3f9a1c0e";
const CODES_JSON = readFileSync(new URL("../fixtures/codes.json", import.meta.url), "utf8");

/** The index host: answers the manifest and the codes of a build, and records what was asked. */
function indexHost(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: string[] = [];
  const answers: Record<string, () => Response | Promise<Response>> = {
    [`${ORIGIN}/index.json`]: () => new Response(JSON.stringify({ format: 1, build: BUILD })),
    [`${ORIGIN}/${BUILD}/codes.json`]: () => new Response(CODES_JSON),
    ...overrides,
  };
  const fetch: CodesDeps["fetch"] = async (url) => {
    calls.push(url);
    return answers[url]?.() ?? new Response("not found", { status: 404 });
  };
  return { fetch, calls, answers };
}

function reader(host: { fetch: CodesDeps["fetch"] }, extra: Partial<CodesDeps> = {}) {
  let now = 1_000_000;
  const clock = {
    advance(ms: number) {
      now += ms;
    },
  };
  const codes = createCodesReader({
    fetch: host.fetch,
    cache: () => null,
    now: () => now,
    timeoutMs: 2000,
    ...extra,
  });
  return { codes, clock };
}

describe("parseCodes", () => {
  it("reads the fixture, with the names of both sections", () => {
    const codes = parseCodes(JSON.parse(CODES_JSON));
    expect(codes?.elf.XJHM).toBe("Aktiebolag");
    expect(codes?.ra.RA000544).toBe("Bolagsverket");
  });

  it("takes a file without registration authorities, as a build without that list gives", () => {
    expect(parseCodes({ elf: { XJHM: "Aktiebolag" } })).toEqual({
      elf: { XJHM: "Aktiebolag" },
      ra: {},
    });
  });

  it("keeps only names that are text", () => {
    const codes = parseCodes({ elf: { A: "a", B: 2, C: "", D: null }, ra: [1] });
    expect({ ...codes?.elf }).toEqual({ A: "a" });
    expect({ ...codes?.ra }).toEqual({});
  });

  it.each([null, "x", 3, [], {}, { ra: {} }, { elf: "x" }])("refuses %j", (value) => {
    expect(parseCodes(value)).toBeNull();
  });

  it("holds no prototype names", () => {
    const codes = parseCodes({ elf: { __proto__: "x", constructor: "y" }, ra: {} });
    expect(codes?.elf.toString).toBeUndefined();
    expect(Object.keys(codes?.elf ?? {})).toEqual(["constructor"]);
  });
});

describe("the codes reader", () => {
  it("reads index.json for the build, then that build's codes.json", async () => {
    const host = indexHost();
    const { codes } = reader(host);
    const names = await codes(ORIGIN);
    expect(host.calls).toEqual([`${ORIGIN}/index.json`, `${ORIGIN}/${BUILD}/codes.json`]);
    expect(names?.elf.XJHM).toBe("Aktiebolag");
  });

  it("takes an origin with a trailing slash", async () => {
    const host = indexHost();
    const { codes } = reader(host);
    expect(await codes(`${ORIGIN}/`)).not.toBeNull();
    expect(host.calls[0]).toBe(`${ORIGIN}/index.json`);
  });

  it("asks nothing when there is no origin", async () => {
    const host = indexHost();
    const { codes } = reader(host);
    for (const none of [undefined, "", "  "]) expect(await codes(none)).toBeNull();
    expect(host.calls).toEqual([]);
  });

  it("looks at index.json again after a few minutes, but parses a build only once", async () => {
    const host = indexHost();
    const { codes, clock } = reader(host);
    const first = await codes(ORIGIN);
    clock.advance(CODES_TTL_MS - 1);
    await codes(ORIGIN);
    expect(host.calls).toHaveLength(2);
    clock.advance(2);
    const again = await codes(ORIGIN);
    // index.json only: the build is the same, so its file is neither fetched nor parsed again.
    expect(host.calls).toHaveLength(3);
    expect(host.calls[2]).toBe(`${ORIGIN}/index.json`);
    expect(again).toBe(first);
  });

  it("gives both requests one deadline", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const host = indexHost();
    const { codes } = reader({
      fetch: (url, init) => {
        signals.push(init?.signal);
        return host.fetch(url, init);
      },
    });
    await codes(ORIGIN);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBe(signals[0]);
  });

  it("shares one read between requests that come together", async () => {
    const host = indexHost();
    const { codes } = reader(host);
    const all = await Promise.all([codes(ORIGIN), codes(ORIGIN), codes(ORIGIN)]);
    expect(host.calls).toHaveLength(2);
    expect(all[0]).toBe(all[2]);
  });

  it.each([
    ["an unreachable host", () => Promise.reject(new TypeError("fetch failed"))],
    ["a server error", () => new Response("", { status: 500 })],
    ["a file that is not JSON", () => new Response("<html>")],
    ["a file that is not codes", () => new Response(JSON.stringify([1, 2]))],
    ["a file without legal forms", () => new Response(JSON.stringify({ ra: {} }))],
  ])("gives null for %s in codes.json, and does not throw", async (_, answer) => {
    const host = indexHost({ [`${ORIGIN}/${BUILD}/codes.json`]: answer });
    const { codes } = reader(host);
    expect(await codes(ORIGIN)).toBeNull();
  });

  it.each([
    ["no build", { format: 1 }],
    ["a build that is not a build name", { build: "../../etc" }],
    ["a build with a slash", { build: "20260916-3f9a1c0e/x" }],
    ["a build that is a number", { build: 20260916 }],
  ])("gives null for an index.json with %s, and asks for no file", async (_, manifest) => {
    const host = indexHost({
      [`${ORIGIN}/index.json`]: () => new Response(JSON.stringify(manifest)),
    });
    const { codes } = reader(host);
    expect(await codes(ORIGIN)).toBeNull();
    expect(host.calls).toEqual([`${ORIGIN}/index.json`]);
  });

  it("gives null for an origin that is not a URL", async () => {
    const { codes } = reader({
      fetch: () => Promise.reject(new TypeError("Invalid URL")),
    });
    expect(await codes("not a url")).toBeNull();
  });

  it("does not wait longer than the timeout for a host that does not answer", async () => {
    const hung = indexHost();
    const fetch: CodesDeps["fetch"] = (url, init) =>
      new Promise((_resolve, reject) => {
        hung.calls.push(url);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { codes } = reader({ fetch }, { timeoutMs: 20 });
    const started = Date.now();
    expect(await codes(ORIGIN)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("waits half a minute after a failure before asking again", async () => {
    let up = false;
    const host = indexHost({
      [`${ORIGIN}/index.json`]: () =>
        up ? new Response(JSON.stringify({ build: BUILD })) : new Response("", { status: 503 }),
    });
    const { codes, clock } = reader(host);
    expect(await codes(ORIGIN)).toBeNull();
    up = true;
    clock.advance(CODES_RETRY_MS - 1);
    expect(await codes(ORIGIN)).toBeNull();
    expect(host.calls).toHaveLength(1);
    clock.advance(2);
    expect((await codes(ORIGIN))?.elf.XJHM).toBe("Aktiebolag");
  });

  it("keeps the names it has when a later read fails", async () => {
    let up = true;
    const host = indexHost({
      [`${ORIGIN}/index.json`]: () =>
        up ? new Response(JSON.stringify({ build: BUILD })) : new Response("", { status: 503 }),
    });
    const { codes, clock } = reader(host);
    await codes(ORIGIN);
    up = false;
    clock.advance(CODES_TTL_MS + 1);
    expect((await codes(ORIGIN))?.elf.XJHM).toBe("Aktiebolag");
  });

  it("follows a new build", async () => {
    let build = BUILD;
    const other = "20260917-aaaaaaaa";
    const host = indexHost({
      [`${ORIGIN}/index.json`]: () => new Response(JSON.stringify({ build })),
      [`${ORIGIN}/${other}/codes.json`]: () =>
        new Response(JSON.stringify({ elf: { XJHM: "Aktiebolag (new)" } })),
    });
    const { codes, clock } = reader(host);
    expect((await codes(ORIGIN))?.elf.XJHM).toBe("Aktiebolag");
    build = other;
    clock.advance(CODES_TTL_MS + 1);
    expect((await codes(ORIGIN))?.elf.XJHM).toBe("Aktiebolag (new)");
  });
});

describe("the Cache API", () => {
  it("is filled by the first read and answers the next Worker without a request", async () => {
    const cache = fakeCache();
    const host = indexHost();
    await reader(host, { cache: () => cache }).codes(ORIGIN);
    await Promise.resolve();
    expect(cache.puts.map((put) => [put.url, put.cacheControl])).toEqual([
      [`${ORIGIN}/index.json`, "public, max-age=300"],
      [`${ORIGIN}/${BUILD}/codes.json`, "public, max-age=31536000"],
    ]);

    // Another Worker instance has no memory of its own, only the cache.
    const next = indexHost();
    const names = await reader(next, { cache: () => cache }).codes(ORIGIN);
    expect(next.calls).toEqual([]);
    expect(names?.ra.RA000544).toBe("Bolagsverket");
  });

  it("is only a help: a broken cache is a miss", async () => {
    const cache = fakeCache();
    cache.fail = true;
    const host = indexHost();
    expect((await reader(host, { cache: () => cache }).codes(ORIGIN))?.elf.XJHM).toBe("Aktiebolag");
    expect(host.calls).toHaveLength(2);
  });
});
