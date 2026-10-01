import { type Entry, encodeEntries, type Manifest } from "@whichlei/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEI_NAMED_INVALID,
  LEI_NAMED_VALID,
  LEI_SHAPED_NAME,
} from "../../scripts/fixture-index.ts";
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

/** An LEI in groups of four: "5493 00W9 JLPW 15XI FM52". */
const grouped = (lei: string) => lei.match(/.{4}/g)?.join(" ") ?? lei;

describe("readInput", () => {
  it("reads every input as a name, and notes what else it is", () => {
    expect(readInput("")).toEqual({ kind: "empty" });
    expect(readInput("   ")).toEqual({ kind: "empty" });
    expect(readInput(ERICSSON)).toMatchObject({
      kind: "name",
      lei: { typed: true, entry: { lei: ERICSSON } },
      badLei: false,
      nameFirst: false,
    });
    // In groups of four, as printed; any other spacing is a name.
    expect(readInput(` ${grouped(ERICSSON.toLowerCase())} `)).toMatchObject({
      kind: "name",
      lei: { entry: { lei: ERICSSON } },
      nameFirst: true,
    });
    expect(
      readInput(` ${ERICSSON.toLowerCase().slice(0, 10)} ${ERICSSON.toLowerCase().slice(10)} `),
    ).toMatchObject({ kind: "name", lei: null, nameFirst: true });
    expect(readInput("549300W9JLPW15XIFM51")).toMatchObject({ lei: null, badLei: true });
    expect(readInput("ericsson")).toMatchObject({ kind: "name", tokens: ["ericsson"], lei: null });
  });

  it("never lets the shape of an LEI keep a name from being searched", () => {
    // 621 real legal names are twenty characters of LEI shape once their spaces are gone.
    expect(readInput(LEI_SHAPED_NAME)).toMatchObject({
      kind: "name",
      tokens: ["ast", "bond", "portfolio", "2021"],
      badLei: false,
      lei: null,
      nameFirst: true,
    });
    expect(readInput(LEI_NAMED_INVALID)).toMatchObject({
      badLei: true,
      tokens: [expect.any(String)],
    });
  });

  it("lets a BIC-shaped word be a name (decision 8)", () => {
    expect(readInput("ERICSSON")).toMatchObject({ kind: "name" });
  });

  it("says a trailing space ends the last word", () => {
    expect(readInput("volvo ")).toMatchObject({ lastIsPrefix: false });
    expect(readInput("volvo")).toMatchObject({ lastIsPrefix: true });
  });

  it("notes a partial LEI, but not an ISIN or a BIC", () => {
    expect(readInput("549300W9JLPW15")).toMatchObject({ partialLei: 14 });
    expect(readInput("ericsson")).toMatchObject({ partialLei: 0 });
    // Twelve and eight or eleven characters are ISINs and BICs: only names are searched.
    expect(readInput("US0378331005")).toMatchObject({ partialLei: 0 });
    expect(readInput("TEERSESSXXX")).toMatchObject({ partialLei: 0 });
    expect(readInput("ERICSS22")).toMatchObject({ partialLei: 0 });
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

  it("answers the same typed on as asked fresh, while reusing the merged files", async () => {
    vi.useFakeTimers();
    const typed = withServer();
    for (const text of [
      "telefonaktiebolaget lm ericsson",
      "ericsson",
      "volvo cars",
      "bank of america",
      "h&m",
    ]) {
      for (let k = 1; k <= text.length; k++) {
        const prefix = text.slice(0, k);
        await typed.search.input(prefix);
        await typed.search.pause();
        const fresh = withServer();
        await fresh.search.input(prefix);
        await fresh.search.pause();
        expect(leis(typed.search), prefix).toEqual(leis(fresh.search));
        expect(typed.search.state.phase, prefix).toBe(fresh.search.state.phase);
      }
    }
  });

  it("keeps the array the page holds when the pause pass changes nothing at the top", async () => {
    const { search } = withServer();
    await search.input("ericsson");
    const first = search.state.hits;
    await search.pause();
    expect(search.state.hits).toBe(first);
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

  it("puts the row of a valid LEI first, before any name has been found", async () => {
    const { manifest, files } = fixture();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }));
    await search.load();
    const release = server.hold(await routedPath(manifest, LEI_NAMED_VALID.toLowerCase()));
    const pending = search.input(LEI_NAMED_VALID.toLowerCase());
    await Promise.resolve();
    expect(search.state).toMatchObject({ phase: "loading", lei: "valid" });
    expect(search.state.hits).toHaveLength(1);
    expect(search.state.hits[0]).toMatchObject({ typed: true, entry: { lei: LEI_NAMED_VALID } });
    release();
    await pending;
    // Then the names that are that code, below the row.
    expect(search.state).toMatchObject({ phase: "done", lei: "valid" });
    expect(search.state.hits[0]).toMatchObject({ typed: true });
    expect(search.state.hits[1]?.entry.name).toBe(LEI_NAMED_VALID);
  });

  it("shows only the row for a valid LEI that no name matches", async () => {
    const { search } = withServer();
    for (const text of [ERICSSON, ERICSSON.toLowerCase(), ` ${grouped(ERICSSON)}`]) {
      await search.input(text);
      await search.pause();
      expect(search.state).toMatchObject({ phase: "done", lei: "valid" });
      expect(search.state.hits).toHaveLength(1);
      expect(search.state.hits[0]).toMatchObject({ typed: true, entry: { lei: ERICSSON } });
    }
  });

  it("searches names for a name that is an LEI with bad check digits", async () => {
    const { search } = withServer();
    await search.input(LEI_NAMED_INVALID);
    expect(search.state.phase).toBe("done");
    expect(search.state.lei).toBe("invalid");
    expect(search.state.hits[0]?.entry.name).toBe(LEI_NAMED_INVALID);
  });

  it("says the check digits are wrong only when no name matches", async () => {
    const { search } = withServer();
    await search.input("549300W9JLPW15XIFM51");
    await search.pause();
    expect(search.state).toMatchObject({ phase: "bad-lei", hits: [], lei: "invalid" });
  });

  it("finds a name that is an LEI's shape once its spaces are gone", async () => {
    const { search } = withServer();
    await search.input(LEI_SHAPED_NAME);
    await search.pause();
    expect(search.state).toMatchObject({ phase: "done", lei: null });
    expect(search.state.hits[0]?.entry.name).toBe(LEI_SHAPED_NAME);
    // Typed a key at a time, it is a name all the way, never a bad LEI.
    const typed = withServer();
    for (let k = 1; k <= LEI_SHAPED_NAME.length; k++) {
      await typed.search.input(LEI_SHAPED_NAME.slice(0, k));
      expect(typed.search.state.phase).not.toBe("bad-lei");
    }
    expect(typed.search.state.hits[0]?.entry.name).toBe(LEI_SHAPED_NAME);
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
    await search.input("549300W9JLPW15XIFM51");
    expect(search.state.phase).toBe("bad-lei");
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

describe("a republish while the page is open", () => {
  /**
   * The same data in a new build whose files are numbered one higher, with a routing table to
   * match (a new first file, empty): so a file number of the old table means another file here.
   */
  function shiftedBuild() {
    const { manifest, files } = fixture();
    const shifted = new Map<number, string>([[0, ""]]);
    for (const [k, v] of files) shifted.set(k + 1, v);
    const next: Manifest = {
      ...manifest,
      build: "20260917-0a0b0c0d",
      asOf: "2026-09-17",
      bounds: ["0", ...manifest.bounds],
      capped: manifest.capped.map((n) => n + 1),
    };
    return { manifest, files, next, shifted };
  }

  it("never mixes builds when the box is cleared while the manifest reloads", async () => {
    const { manifest, files, next, shifted } = shiftedBuild();
    const server = fakeServer(ORIGIN, manifest, files);
    const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }), {
      debounceMs: Number.POSITIVE_INFINITY,
    });
    await search.load();
    await search.input("volvo");
    const volvo = search.state.hits.map((h) => h.entry.name);
    expect(volvo.length).toBeGreaterThan(0);

    server.publish(next, shifted);
    // A word whose file is not held: it 404s, and the manifest reload is held up. Meanwhile the
    // box is cleared, so the pass that asked is stale when the reload ends.
    const release = server.hold("index.json");
    const asked = search.input("ericsson");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await search.input("");
    release();
    await asked;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The box is empty and the footer already shows the new build's date.
    await search.input("");
    expect(search.state.index?.asOf).toBe("2026-09-17");
    // A new search reads the new build only.
    const fresh = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }), {
      debounceMs: Number.POSITIVE_INFINITY,
    });
    await fresh.input("scania");
    await search.input("scania");
    expect(search.state.hits.map((h) => h.entry.name)).toEqual(
      fresh.state.hits.map((h) => h.entry.name),
    );
    await search.input("volvo");
    expect(search.state.hits.map((h) => h.entry.name)).toEqual(volvo);
    const builds = new Set(
      server.log
        .slice(-4)
        .filter((p) => p !== "index.json")
        .map((p) => p.split("/")[0]),
    );
    expect(builds).toEqual(new Set(["20260917-0a0b0c0d"]));
  });

  it("asks for a file of the build it routed with, and routes again when that is gone", async () => {
    const { manifest, files, next, shifted } = shiftedBuild();
    const server = fakeServer(ORIGIN, manifest, files);
    const client = new IndexClient(ORIGIN, { fetch: server.fetch });
    const search = new Search(client, { debounceMs: Number.POSITIVE_INFINITY });
    await search.load();
    server.publish(next, shifted);
    // Another reader of the client sees the republish first.
    await expect(client.file(manifest.build, 0)).rejects.toMatchObject({
      name: "IndexChangedError",
    });
    // Search still holds the old table. It must not read file numbers of it from the new build.
    await search.input("volvo");
    expect(search.state.phase).toBe("done");
    expect(search.state.index?.asOf).toBe("2026-09-17");
    const requested = server.log.filter((p) => p.endsWith(".txt") && p.startsWith(next.build));
    expect(requested.length).toBeGreaterThan(0);
    expect(server.log.filter((p) => p.startsWith(manifest.build)).length).toBe(1);
  });
});

describe("a pass that became stale while it was fetching", () => {
  it("does not draw its answer over the newer input", async () => {
    // A source that ignores abort, so only the check after the fetch can stop the stale pass.
    const { manifest, files } = fixture();
    const gates = new Map<number, ReturnType<typeof deferred<string>>>();
    const source = {
      peek: () => manifest,
      manifest: () => Promise.resolve(manifest),
      file: (_build: string, file: number) => {
        const gate = deferred<string>();
        gates.set(file, gate);
        return gate.promise;
      },
    };
    const search = new Search(source, { debounceMs: Number.POSITIVE_INFINITY });
    await search.load();
    const first = search.input("ericsson");
    await Promise.resolve();
    const ericssonFile = [...gates.keys()][0] as number;
    const second = search.input("volvo");
    await Promise.resolve();
    const volvoFile = [...gates.keys()].find((f) => f !== ericssonFile) as number;
    gates.get(volvoFile)?.resolve(files.get(volvoFile) as string);
    await second;
    const volvo = search.state.hits.map((h) => h.entry.lei);
    expect(search.state.text).toBe("volvo");
    // The first fetch ends now. Its answer is dropped.
    gates.get(ericssonFile)?.resolve(files.get(ericssonFile) as string);
    await first;
    expect(search.state.text).toBe("volvo");
    expect(search.state.hits.map((h) => h.entry.lei)).toEqual(volvo);
  });
});
