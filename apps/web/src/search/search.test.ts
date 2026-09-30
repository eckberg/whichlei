import { type Entry, encodeEntries, type Manifest } from "@whichlei/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexClient } from "./client.ts";
import { readInput, Search, type SearchState } from "./search.ts";
import { deferred, ERICSSON, fakeServer, fixture, memorySource } from "./test-helpers.ts";

const ORIGIN = "https://index.test";

afterEach(() => {
  vi.useRealTimers();
});

/** A search over the prototype's records, read through a real client and a fake network. */
function withServer() {
  const { manifest, files } = fixture();
  const server = fakeServer(ORIGIN, manifest, files);
  const client = new IndexClient(ORIGIN, { fetch: server.fetch });
  const search = new Search(client, { debounceMs: 150 });
  const states: SearchState[] = [];
  search.subscribe((state) => states.push(state));
  return { manifest, files, server, search, states };
}

const leis = (search: Search) => search.state.hits.map((h) => h.entry.lei);
const fileRequests = (server: { log: string[] }) => server.log.filter((p) => p !== "index.json");

function entry(lei: string, name: string, prominence = 0): Entry {
  return { lei, name, otherNames: [], country: "SE", status: "I", prominence };
}

/** Two files that both hold entity X, and one that holds only Y. */
function tinyIndex() {
  const x = entry("AAAAAAAAAAAAAAAAAA01", "Alpha Zulu");
  const y = entry("BBBBBBBBBBBBBBBBBB01", "Alpha Bravo");
  const files = new Map([
    [0, encodeEntries([x, y])],
    [1, encodeEntries([x])],
  ]);
  const manifest: Manifest = {
    format: 1,
    build: "b1",
    asOf: "2026-09-16",
    entities: 2,
    bounds: ["alp", "zul"],
    capped: [],
  };
  return { manifest, files, x, y };
}

describe("readInput", () => {
  it("tells names, valid LEIs and LEIs with bad check digits apart", () => {
    expect(readInput("")).toEqual({ kind: "empty" });
    expect(readInput("   ")).toEqual({ kind: "empty" });
    expect(readInput(ERICSSON)).toEqual({ kind: "lei", lei: ERICSSON });
    expect(
      readInput(` ${ERICSSON.toLowerCase().slice(0, 10)} ${ERICSSON.toLowerCase().slice(10)} `),
    ).toEqual({
      kind: "lei",
      lei: ERICSSON,
    });
    expect(readInput("549300W9JLPW15XIFM51")).toEqual({ kind: "bad-lei" });
    expect(readInput("ericsson")).toMatchObject({ kind: "name", tokens: ["ericsson"] });
  });

  it("lets a BIC-shaped word be a name (decision 8)", () => {
    expect(readInput("ERICSSON")).toMatchObject({ kind: "name" });
  });

  it("says a trailing space ends the last word", () => {
    expect(readInput("volvo ")).toMatchObject({ lastIsPrefix: false });
    expect(readInput("volvo")).toMatchObject({ lastIsPrefix: true });
  });

  it("notes a partial LEI", () => {
    expect(readInput("549300W9JLPW15")).toMatchObject({ partialLei: 14 });
    expect(readInput("ericsson")).toMatchObject({ partialLei: 0 });
  });
});

describe("Search", () => {
  it("finds Ericsson by name, through the routed file", async () => {
    const { search, server, manifest } = withServer();
    await search.load();
    expect(search.state.index).toEqual({ asOf: manifest.asOf, entities: manifest.entities });
    await search.input("ericsson");
    expect(search.state.phase).toBe("done");
    expect(search.state.tokens).toEqual(["ericsson"]);
    expect(leis(search)[0]).toBe(ERICSSON);
    expect(fileRequests(server)).toHaveLength(1);
    expect(search.state.hits[0]?.entry.name).toBe("Telefonaktiebolaget LM Ericsson");
  });

  it("keeps at most 50 results", async () => {
    const { search } = withServer();
    await search.input("bank");
    await search.pause();
    expect(search.state.hits.length).toBeLessThanOrEqual(50);
    expect(search.state.hits.length).toBeGreaterThan(10);
  });

  it("reads a word that never narrows only after a pause", async () => {
    vi.useFakeTimers();
    const tiny = tinyIndex();
    const manifest: Manifest = {
      ...tiny.manifest,
      bounds: ["00", "international", "internationalb"],
    };
    const { source, requests } = memorySource(
      manifest,
      new Map([[1, tiny.files.get(0) as string]]),
    );
    const search = new Search(source, { debounceMs: 150 });
    await search.input("international");
    expect(requests).toHaveLength(0);
    expect(search.state.phase).toBe("loading");
    await vi.advanceTimersByTimeAsync(150);
    expect(requests.map((r) => r.file)).toEqual([1]);
    expect(search.stats?.paused).toBe(true);
    expect(search.state.phase).toBe("no-match");
  });

  it("does not fetch for a few letters, and says so once typing pauses", async () => {
    const { search, server } = withServer();
    await search.load();
    await search.input("e");
    expect(search.state.phase).toBe("loading");
    await search.pause();
    expect(search.state.phase).toBe("short");
    expect(search.state.hits).toEqual([]);
    expect(fileRequests(server)).toEqual([]);
  });

  it("fetches one file for a two-letter word after a pause", async () => {
    const { search, server } = withServer();
    await search.input("bp");
    expect(fileRequests(server)).toHaveLength(0);
    await search.pause();
    expect(fileRequests(server)).toHaveLength(1);
  });

  it("merges an entity held by two files into one result", async () => {
    const { manifest, files, x, y } = tinyIndex();
    const { source, requests } = memorySource(manifest, files);
    const search = new Search(source);
    await search.input("alpha zulu");
    expect(requests.map((r) => r.file).sort()).toEqual([0, 1]);
    // X is in both files and appears once; Y matches "alpha" only.
    expect(leis(search)).toEqual([x.lei, y.lei]);
    expect(search.stats?.candidates).toBe(2);
  });

  it("decodes a file once and scores from memory afterwards", async () => {
    const { search, server } = withServer();
    await search.input("eric");
    const first = search.stats;
    expect(first?.parsed).toBe(1);
    await search.input("erics");
    expect(search.stats?.parsed).toBe(0);
    await search.input("ericsson");
    expect(search.stats?.parsed).toBe(0);
    expect(fileRequests(server)).toHaveLength(1);
    expect(leis(search)[0]).toBe(ERICSSON);
  });

  it("skips the pause pass when it would read the same files for the same words", async () => {
    vi.useFakeTimers();
    const { search, server } = withServer();
    await search.input("ericsson");
    const before = search.state.hits;
    await vi.advanceTimersByTimeAsync(150);
    expect(search.stats).toMatchObject({ paused: true, skipped: true });
    expect(search.state.hits).toBe(before);
    expect(fileRequests(server)).toHaveLength(1);
  });

  it("holds results while loading, then replaces them", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.input("ericsson");
    const ericsson = search.state.hits;
    const volvoPath = await routedPath(manifest, "volvo");
    const release = server.hold(volvoPath);
    const pending = search.input("volvo");
    await Promise.resolve();
    expect(search.state.phase).toBe("loading");
    expect(search.state.hits).toBe(ericsson);
    release();
    await pending;
    expect(search.state.phase).toBe("done");
    expect(search.state.hits).not.toBe(ericsson);
    expect(search.state.hits[0]?.entry.name.toLowerCase()).toContain("volvo");
  });

  it("aborts the fetch of a stale input and drops its answer", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.load();
    const ericssonPath = await routedPath(manifest, "ericsson");
    server.hold(ericssonPath);
    const stale = search.input("ericsson");
    await Promise.resolve();
    await search.input("volvo");
    await stale;
    expect(server.aborted).toEqual([ericssonPath]);
    expect(search.state.tokens).toEqual(["volvo"]);
    expect(search.state.hits[0]?.entry.name.toLowerCase()).toContain("volvo");
  });

  it("does not abort a file the newer input needs too", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.load();
    const path = await routedPath(manifest, "ericsson");
    const release = server.hold(path);
    const first = search.input("ericsson");
    await Promise.resolve();
    const second = search.input("ericssons");
    release();
    await Promise.all([first, second]);
    expect(server.aborted).toEqual([]);
    expect(fileRequests(server)).toHaveLength(1);
    expect(search.state.tokens).toEqual(["ericssons"]);
  });

  it("ignores an answer that arrives after a newer input cleared the box", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.load();
    server.hold(await routedPath(manifest, "ericsson"));
    const stale = search.input("ericsson");
    await Promise.resolve();
    await search.input("");
    await stale;
    expect(search.state.phase).toBe("empty");
    expect(search.state.hits).toEqual([]);
  });

  it("reloads the manifest when a 404 says the index was republished, and routes again", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.load();
    server.publish({ ...manifest, build: "20260917-0a0b0c0d", asOf: "2026-09-17" }, files);
    await search.input("ericsson");
    expect(search.state.phase).toBe("done");
    expect(leis(search)[0]).toBe(ERICSSON);
    expect(search.state.index?.asOf).toBe("2026-09-17");
    expect(server.log.filter((p) => p === "index.json")).toHaveLength(2);
    expect(server.log.at(-1)).toMatch(/^20260917-0a0b0c0d\//);
  });

  it("shows one row that opens the record for a valid LEI, without reading the index", async () => {
    const { search, server } = withServer();
    for (const text of [
      ERICSSON,
      ERICSSON.toLowerCase(),
      ` ${ERICSSON.slice(0, 8)} ${ERICSSON.slice(8)}`,
    ]) {
      await search.input(text);
      expect(search.state.phase).toBe("done");
      expect(search.state.hits).toHaveLength(1);
      expect(search.state.hits[0]).toMatchObject({ typed: true, entry: { lei: ERICSSON } });
    }
    expect(server.log).toEqual([]);
  });

  it("says the check digits are wrong and makes no request", async () => {
    const { search, server } = withServer();
    await search.input("549300W9JLPW15XIFM51");
    expect(search.state.phase).toBe("bad-lei");
    expect(search.state.hits).toEqual([]);
    await search.pause();
    expect(server.log).toEqual([]);
  });

  it("clears on empty input", async () => {
    const { search } = withServer();
    await search.input("ericsson");
    await search.input("");
    expect(search.state).toMatchObject({ phase: "empty", hits: [], text: "" });
  });

  it("says no index is configured, but still opens a valid LEI", async () => {
    const search = new Search(null);
    expect(search.state.phase).toBe("unconfigured");
    await search.input("ericsson");
    expect(search.state.phase).toBe("unconfigured");
    await search.input(ERICSSON);
    expect(search.state.hits[0]?.entry.lei).toBe(ERICSSON);
    await search.input("");
    expect(search.state.phase).toBe("unconfigured");
    await search.load();
  });

  it("reports no match, and a partial LEI", async () => {
    const { search } = withServer();
    await search.input("zzzqqq");
    expect(search.state.phase).toBe("no-match");
    expect(search.state.message).toBe("");
    await search.input("549300W9JLPW15");
    expect(search.state.phase).toBe("no-match");
    expect(search.state.message).toBe("looks like an lei: 14/20 characters");
  });

  it("reports a network error, and tries again on the next input", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.load();
    const path = await routedPath(manifest, "ericsson");
    server.fail(path);
    await search.input("ericsson");
    expect(search.state).toMatchObject({ phase: "error", hits: [] });
    expect(search.state.message).toContain("could not reach the index");
    server.fail(null);
    await search.retry();
    expect(search.state.phase).toBe("done");
    expect(leis(search)[0]).toBe(ERICSSON);
  });

  it("reports a manifest it cannot load, and loads it on the first keystroke", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    server.fail("index.json");
    await search.load();
    expect(search.state.phase).toBe("error");
    server.fail(null);
    await search.input("ericsson");
    expect(search.state.phase).toBe("done");
  });

  it("retries the manifest with an empty box, and leaves the error state", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    server.fail("index.json");
    await search.load();
    expect(search.state.phase).toBe("error");
    server.fail(null);
    await search.retry();
    expect(search.state.phase).toBe("empty");
    expect(search.state.index?.asOf).toBe(manifest.asOf);
  });

  it("pauses only when told to, when the debounce is infinite", async () => {
    vi.useFakeTimers();
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }), {
      debounceMs: Number.POSITIVE_INFINITY,
    });
    await search.input("ericsson");
    const passes = fileRequests(server).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(search.stats?.paused).toBe(false);
    await search.pause();
    expect(search.stats?.paused).toBe(true);
    expect(fileRequests(server).length).toBeGreaterThanOrEqual(passes);
  });

  it("says to reload the page when the manifest has a format it cannot read", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, { ...manifest, format: 2 as never }, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.input("ericsson");
    expect(search.state).toMatchObject({ phase: "error", reload: true });
    // A damaged manifest is not that: a reload does not help.
    const damaged = fakeServer(ORIGIN, { ...manifest, bounds: [] }, files);
    const third = new Search(new IndexClient(ORIGIN, { fetch: damaged.fetch }));
    await third.input("ericsson");
    expect(third.state).toMatchObject({ phase: "error", reload: false });
    expect(third.state.message).toContain("damaged");
    // A broken network is not that either.
    const down = fakeServer(ORIGIN, manifest, files);
    down.fail("index.json");
    const other = new Search(new IndexClient(ORIGIN, { fetch: down.fetch }));
    await other.input("ericsson");
    expect(other.state).toMatchObject({ phase: "error", reload: false });
  });

  it("reports a file it cannot decode", async () => {
    const { manifest } = tinyIndex();
    const { source } = memorySource(
      manifest,
      new Map([
        [0, "not an entry\n"],
        [1, ""],
      ]),
    );
    const search = new Search(source);
    await search.input("alpha");
    expect(search.state.phase).toBe("error");
  });

  it("times a pass without the time spent waiting", async () => {
    let clock = 0;
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }), {
      now: () => (clock += 1),
    });
    await search.input("ericsson");
    expect(search.stats).toMatchObject({ paused: false, parsed: 1, skipped: false });
    expect(search.stats?.ms).toBeGreaterThan(0);
    expect(search.stats?.parseMs).toBeGreaterThan(0);
    expect(search.stats?.files).toHaveLength(1);
  });

  it("stops notifying after unsubscribe", async () => {
    const { search } = withServer();
    const seen: string[] = [];
    const stop = search.subscribe((s) => seen.push(s.phase));
    await search.input("ericsson");
    stop();
    const count = seen.length;
    await search.input("volvo");
    expect(seen).toHaveLength(count);
  });

  it("waits for the manifest on the first input", async () => {
    const { manifest, files } = fixture();
    const gate = deferred<Manifest>();
    const { source } = memorySource(manifest, files);
    const search = new Search({ ...source, manifest: () => gate.promise });
    const pending = search.input("ericsson");
    expect(search.state.phase).toBe("loading");
    gate.resolve(manifest);
    await pending;
    expect(leis(search)[0]).toBe(ERICSSON);
  });
});

/** The path of the file a query routes to, found by asking the real routing. */
async function routedPath(manifest: Manifest, word: string): Promise<string> {
  const { route, routingTable, queryTokens } = await import("@whichlei/core");
  const [file] = route(queryTokens(word), routingTable(manifest), { paused: true });
  if (file === undefined) throw new Error(`${word} routes nowhere`);
  return `${manifest.build}/${file}.txt`;
}
