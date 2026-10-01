import { describe, expect, it } from "vitest";
import { IndexClient } from "../search/client.ts";
import { SearchHost, type ToPage, type ToWorker } from "../search/host.ts";
import { initialState, Search, type SearchState } from "../search/search.ts";
import { ERICSSON, fakeServer, fixture } from "../search/test-helpers.ts";
import { RemoteSearch, type WorkerLike } from "./remote.ts";

const ORIGIN = "https://index.test";

/** A worker that is a `SearchHost` in this thread, with messages delivered in later tasks. */
function fakeWorker() {
  const { manifest, files } = fixture();
  const server = fakeServer(ORIGIN, manifest, files);
  const listeners = {
    message: [] as ((e: { data: ToPage }) => void)[],
    error: [] as (() => void)[],
  };
  let host: SearchHost | null = null;
  const worker: WorkerLike = {
    postMessage(message: ToWorker) {
      setTimeout(() => {
        if (message.type === "init") {
          const search = new Search(new IndexClient(message.origin, { fetch: server.fetch }));
          host = new SearchHost(search, (reply) =>
            setTimeout(() => {
              for (const l of listeners.message) l({ data: reply });
            }, 0),
          );
        } else host?.handle(message);
      }, 0);
    },
    addEventListener(type: "message" | "error", listener: never) {
      if (type === "message") listeners.message.push(listener);
      else listeners.error.push(listener);
    },
  };
  return { worker, listeners, server };
}

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RemoteSearch", () => {
  it("finds Ericsson through the worker", async () => {
    const { worker } = fakeWorker();
    const search = new RemoteSearch(worker, ORIGIN, initialState(true));
    search.input("ericsson");
    await settle();
    expect(search.state.phase).toBe("done");
    expect(search.state.hits[0]?.entry.lei).toBe(ERICSSON);
  });

  it("ends on the right top result after fast typing, with no older answer after it", async () => {
    const { worker } = fakeWorker();
    const search = new RemoteSearch(worker, ORIGIN, initialState(true));
    const seen: SearchState[] = [];
    search.subscribe((state) => seen.push(state));
    const text = "telefonaktiebolaget";
    for (let k = 1; k <= text.length; k++) {
      search.input(text.slice(0, k));
      await settle(2);
    }
    await settle(200);
    const last = seen.at(-1) as SearchState;
    expect(last.text).toBe(text);
    expect(last.phase).toBe("done");
    expect(last.hits[0]?.entry.lei).toBe(ERICSSON);
    // Once an answer for the final text has come, no answer for an earlier text follows it.
    const firstFinal = seen.findIndex((s) => s.text === text);
    expect(firstFinal).toBeGreaterThanOrEqual(0);
    expect(seen.slice(firstFinal).every((s) => s.text === text)).toBe(true);
  });

  it("ignores an answer to an input that is no longer the newest", async () => {
    const { worker, listeners } = fakeWorker();
    const search = new RemoteSearch(worker, ORIGIN, initialState(true));
    search.input("a");
    search.input("ericsson");
    const stale: ToPage = {
      type: "state",
      seq: 1,
      stats: null,
      state: { ...initialState(true), text: "a", phase: "no-match" },
    };
    for (const l of listeners.message) l({ data: stale });
    expect(search.state.text).toBe("");
  });

  it("keeps the hits and words arrays when an answer repeats them", async () => {
    const { worker } = fakeWorker();
    const search = new RemoteSearch(worker, ORIGIN, initialState(true));
    search.input("ericsson");
    await settle();
    const { hits, tokens } = search.state;
    // The pause pass answers again with the same entries.
    await settle(250);
    expect(search.state.hits).toBe(hits);
    expect(search.state.tokens).toBe(tokens);
  });

  it("says so when the worker cannot start, and offers a reload", () => {
    const { worker, listeners } = fakeWorker();
    const search = new RemoteSearch(worker, ORIGIN, initialState(true));
    for (const l of listeners.error) l();
    expect(search.state).toMatchObject({ phase: "error", reload: true });
  });
});
