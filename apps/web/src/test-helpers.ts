// Fakes for the tests: GLEIF answering from the recorded fixtures, a Cache API that keeps
// what it is given, and a Worker call that waits for `waitUntil` work. No test touches the
// network.

import { readdirSync, readFileSync } from "node:fs";
import type { Fetch, LeiRecord } from "@whichlei/gleif";
import { fetchRecord } from "@whichlei/gleif";
import { type CacheLike, createWorker, type Deps, type Env } from "./worker.ts";

const fixtureDir = new URL("../../../packages/gleif/fixtures/", import.meta.url);

interface Fixture {
  url: string;
  status: number;
  contentType: string | null;
  body: unknown;
}

export const loadFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`${name}.json`, fixtureDir), "utf8")) as Fixture;

/** Names of the recorded record fixtures that GLEIF answered with a record. */
export const recordFixtures = readdirSync(fixtureDir)
  .filter((file) => file.startsWith("record-") && file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .filter((name) => loadFixture(name).status === 200);

export const leiOf = (fixture: string): string =>
  /lei-records\/([0-9A-Z]{20})/.exec(loadFixture(fixture).url)?.[1] ?? "";

/** A record, parsed by the real client from a fixture. */
export function parsedRecord(
  fixture: string,
  edit?: (body: unknown) => unknown,
): Promise<LeiRecord> {
  const { body } = loadFixture(fixture);
  const edited = edit ? edit(structuredClone(body)) : body;
  return fetchRecord(leiOf(fixture), {
    fetch: async () =>
      new Response(JSON.stringify(edited), { headers: { "content-type": "application/json" } }),
  });
}

export interface FakeGleif {
  fetch: Fetch;
  /** Every URL requested. */
  calls: string[];
}

/**
 * GLEIF, answering each LEI from its fixture. `override` answers instead, for failures and
 * edited bodies.
 */
export function fakeGleif(override?: (url: string) => Response | Promise<Response>): FakeGleif {
  const byLei = new Map<string, Fixture>();
  for (const file of readdirSync(fixtureDir)) {
    if (!file.startsWith("record-")) continue;
    const fixture = loadFixture(file.slice(0, -".json".length));
    const lei = /lei-records\/([0-9A-Z]{20})/.exec(fixture.url)?.[1];
    if (lei) byLei.set(lei, fixture);
  }
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      if (override) return override(url);
      const lei = /lei-records\/([0-9A-Z]{20})/.exec(url)?.[1] ?? "";
      const fixture = byLei.get(lei);
      if (!fixture) return new Response("<html>Not found</html>", { status: 404 });
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: { "content-type": fixture.contentType ?? "application/json" },
      });
    },
  };
}

export interface FakeCache extends CacheLike {
  /** `Cache-Control` of each `put`, by URL. */
  puts: { url: string; status: number; cacheControl: string | null }[];
  fail: boolean;
}

export function fakeCache(): FakeCache {
  const entries = new Map<string, { status: number; body: string; headers: Headers }>();
  const cache: FakeCache = {
    puts: [],
    fail: false,
    async match(request) {
      if (cache.fail) throw new Error("cache is down");
      const entry = entries.get(request.url);
      return entry
        ? new Response(entry.body, { status: entry.status, headers: entry.headers })
        : undefined;
    },
    async put(request, response) {
      if (cache.fail) throw new Error("cache is down");
      cache.puts.push({
        url: request.url,
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
      });
      entries.set(request.url, {
        status: response.status,
        body: await response.text(),
        headers: new Headers(response.headers),
      });
    },
  };
  return cache;
}

export interface Harness {
  gleif: FakeGleif;
  cache: FakeCache;
  assetRequests: string[];
  /** Call the Worker's `fetch` and wait for background work (cache writes). */
  get(path: string, init?: RequestInit, env?: Partial<Env>): Promise<Response>;
  setNow(iso: string): void;
}

export function harness(options: { gleif?: FakeGleif; origin?: string } = {}): Harness {
  const gleif = options.gleif ?? fakeGleif();
  const cache = fakeCache();
  const assetRequests: string[] = [];
  let now = new Date("2026-09-30T10:00:00Z");
  const deps: Deps = { cache: () => cache, fetch: gleif.fetch, now: () => now };
  const worker = createWorker(deps);
  const origin = options.origin ?? "https://whichlei.test";
  return {
    gleif,
    cache,
    assetRequests,
    setNow(iso) {
      now = new Date(iso);
    },
    async get(path, init, env = {}) {
      const pending: Promise<unknown>[] = [];
      const fullEnv: Env = {
        ASSETS: {
          fetch: async (request) => {
            assetRequests.push(new URL(request.url).pathname);
            return new Response("static", { status: 200 });
          },
        },
        ...env,
      };
      const response = await worker.fetch(
        new Request(`${origin}${path}`, { redirect: "manual", ...init }),
        fullEnv,
        {
          waitUntil: (promise) => {
            pending.push(promise);
          },
        },
      );
      await Promise.all(pending);
      return response;
    },
  };
}
