import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexClient } from "./client.ts";
import { SearchHost, type ToPage } from "./host.ts";
import { initialState, Search, type SearchState } from "./search.ts";
import { ERICSSON, fakeServer, fixture } from "./test-helpers.ts";

const ORIGIN = "https://index.test";

afterEach(() => {
  vi.useRealTimers();
});

/** A host over the prototype's records, with a `defer` the test runs by hand. */
function setup() {
  const { manifest, files } = fixture();
  const server = fakeServer(ORIGIN, manifest, files);
  const search = new Search(new IndexClient(ORIGIN, { fetch: server.fetch }), {
    debounceMs: Number.POSITIVE_INFINITY,
  });
  const posted: ToPage[] = [];
  const deferred: (() => void)[] = [];
  const host = new SearchHost(
    search,
    (message) => posted.push(message),
    (run) => void deferred.push(run),
  );
  const runDeferred = () => {
    for (const run of deferred.splice(0)) run();
  };
  return { host, server, posted, runDeferred, manifest };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SearchHost", () => {
  it("works on the newest input only, when several arrive before it runs", async () => {
    const { host, server, posted, runDeferred } = setup();
    for (const [seq, text] of ["e", "er", "eri", "eric", "ericsson"].entries()) {
      host.handle({ type: "input", seq: seq + 1, text });
    }
    expect(posted).toEqual([]);
    runDeferred();
    await settle();
    expect(posted.length).toBeGreaterThan(0);
    expect(new Set(posted.map((m) => m.seq))).toEqual(new Set([5]));
    expect(posted.every((m) => m.state.text === "ericsson")).toBe(true);
    expect(posted.at(-1)?.state.hits[0]?.entry.lei).toBe(ERICSSON);
    // Only the newest word was asked of the index.
    expect(server.log.filter((p) => p !== "index.json")).toHaveLength(1);
  });

  it("posts nothing for an input that a newer one has replaced while it was loading", async () => {
    const { host, server, posted, runDeferred, manifest } = setup();
    host.handle({ type: "load" });
    await settle();
    const volvoFile = server.log.length;
    expect(volvoFile).toBe(1);
    // Hold every index file, so the first input waits for the network.
    for (let n = 0; n < manifest.bounds.length; n++) {
      server.hold(`${manifest.build}/${n}.txt`);
    }
    host.handle({ type: "input", seq: 1, text: "ericsson" });
    runDeferred();
    await settle();
    posted.length = 0;
    host.handle({ type: "input", seq: 2, text: "volvo" });
    // The newer input is waiting: nothing about the first one is posted any more.
    const waiting = posted.length;
    expect(waiting).toBe(0);
    runDeferred();
    await settle();
    expect(posted.every((m) => m.seq === 2)).toBe(true);
  });

  it("answers a load with the index it found, before any input", async () => {
    const { host, posted } = setup();
    host.handle({ type: "load" });
    await settle();
    expect(posted.at(-1)).toMatchObject({ seq: 0, state: { index: { asOf: "2026-09-16" } } });
  });

  it("answers an input that follows a quiet moment on its own", async () => {
    const { host, posted, runDeferred } = setup();
    host.handle({ type: "input", seq: 1, text: "ericsson" });
    runDeferred();
    await settle();
    posted.length = 0;
    host.handle({ type: "input", seq: 2, text: "volvo" });
    runDeferred();
    await settle();
    expect(posted.at(-1)).toMatchObject({ seq: 2, state: { phase: "done", text: "volvo" } });
  });

  it("answers a valid LEI with its row at once, and a bad one with the names it finds", async () => {
    const { host, posted, runDeferred } = setup();
    host.handle({ type: "input", seq: 1, text: "HWUPKR0MPOU8FGXBT395" });
    runDeferred();
    await settle();
    expect(posted.at(-1)?.state).toMatchObject({ phase: "done", lei: "invalid" });
    host.handle({ type: "input", seq: 2, text: "HWUPKR0MPOU8FGXBT394" });
    runDeferred();
    await settle();
    expect(posted.at(-1)?.state.hits[0]).toMatchObject({ typed: true });
    expect(posted.at(-1)?.state.lei).toBe("valid");
  });
});

describe("SearchHost, with a search that answers when told", () => {
  /** A `Search` that does nothing by itself: the test calls its listener. */
  function stub() {
    let listener: ((state: SearchState) => void) | null = null;
    const search = {
      subscribe: (l: (state: SearchState) => void) => {
        listener = l;
        return () => {};
      },
      input: () => Promise.resolve(),
      load: () => Promise.resolve(),
      retry: () => Promise.resolve(),
      stats: null,
    } as unknown as Search;
    const posted: ToPage[] = [];
    const deferred: (() => void)[] = [];
    const host = new SearchHost(
      search,
      (m) => posted.push(m),
      (run) => void deferred.push(run),
    );
    const answer = (text: string) => listener?.({ ...initialState(true), text, phase: "done" });
    return {
      host,
      posted,
      answer,
      runDeferred: () => {
        for (const run of deferred.splice(0)) run();
      },
    };
  }

  it("drops an answer while a newer input waits, and posts the newest one's", () => {
    const { host, posted, answer, runDeferred } = stub();
    host.handle({ type: "input", seq: 1, text: "a" });
    runDeferred();
    answer("a");
    expect(posted.map((m) => m.seq)).toEqual([1]);
    // Input 2 has arrived but is not being worked on yet: an answer now is for input 1.
    host.handle({ type: "input", seq: 2, text: "ab" });
    answer("a");
    expect(posted.map((m) => m.seq)).toEqual([1]);
    runDeferred();
    answer("ab");
    expect(posted.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("works on the newest of several inputs, and none of the ones before it", () => {
    const calls: string[] = [];
    let listener: ((state: SearchState) => void) | null = null;
    const search = {
      subscribe: (l: (state: SearchState) => void) => {
        listener = l;
        return () => {};
      },
      input: (text: string) => {
        calls.push(text);
        return Promise.resolve();
      },
      load: () => Promise.resolve(),
      retry: () => Promise.resolve(),
      stats: null,
    } as unknown as Search;
    const queued: (() => void)[] = [];
    const host = new SearchHost(
      search,
      () => {},
      (run) => void queued.push(run),
    );
    void listener;
    for (const [seq, text] of ["e", "er", "eri"].entries())
      host.handle({ type: "input", seq: seq + 1, text });
    expect(queued).toHaveLength(1);
    queued[0]?.();
    expect(calls).toEqual(["eri"]);
  });
});
