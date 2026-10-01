import { describe, expect, it } from "vitest";
import type { ToPage, ToWorker } from "../search/host.ts";
import { initialState, type SearchPort, type SearchState } from "../search/search.ts";
import type { WorkerLike } from "./remote.ts";
import { ResilientSearch } from "./resilient.ts";

/** A worker the test drives: what it was sent, and what it says and does. */
function scriptedWorker() {
  const sent: ToWorker[] = [];
  const messages: ((e: { data: ToPage }) => void)[] = [];
  const errors: (() => void)[] = [];
  const worker: WorkerLike = {
    postMessage: (m) => void sent.push(m),
    addEventListener(type: "message" | "error", listener: never) {
      (type === "message" ? messages : errors).push(listener);
    },
  };
  return {
    worker,
    sent,
    say: (state: Partial<SearchState>, seq = 0) => {
      for (const l of messages) {
        l({
          data: { type: "state", seq, stats: null, state: { ...initialState(true), ...state } },
        });
      }
    },
    fail: () => {
      for (const l of errors) l();
    },
  };
}

/** A search standing in for the one that runs on the page. */
function fakeLocal() {
  const calls: string[] = [];
  let listener: ((s: SearchState) => void) | null = null;
  let state = initialState(true);
  const port: SearchPort = {
    get state() {
      return state;
    },
    subscribe(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    input: (text) => void calls.push(`input ${text}`),
    load: () => void calls.push("load"),
    retry: () => void calls.push("retry"),
  };
  return {
    port,
    calls,
    say(next: Partial<SearchState>) {
      state = { ...state, ...next };
      listener?.(state);
    },
  };
}

function setup() {
  const workers: ReturnType<typeof scriptedWorker>[] = [];
  const local = fakeLocal();
  let localMade = 0;
  const search = new ResilientSearch(
    () => {
      const w = scriptedWorker();
      workers.push(w);
      return w.worker;
    },
    () => {
      localMade++;
      return local.port;
    },
    "https://index.test",
    initialState(true),
  );
  const seen: SearchState[] = [];
  search.subscribe((s) => seen.push(s));
  return { search, workers, local, seen, localMade: () => localMade };
}

describe("ResilientSearch", () => {
  it("runs on the page when the worker fails before it ever answered, and asks again", () => {
    const { search, workers, local, localMade } = setup();
    search.load();
    search.input("eric");
    search.input("ericsson");
    workers[0]?.fail();
    expect(localMade()).toBe(1);
    expect(local.calls).toEqual(["load", "input ericsson"]);
    // The page's own search answers from here on.
    local.say({ phase: "done", text: "ericsson" });
    expect(search.state.phase).toBe("done");
    expect(workers).toHaveLength(1);
  });

  it("does not ask again for an empty box", () => {
    const { search, workers, local } = setup();
    workers[0]?.fail();
    expect(local.calls).toEqual([]);
    expect(search.state.phase).toBe("empty");
  });

  it("starts the worker once more when one that had been answering throws, with the newest input", () => {
    const { search, workers, localMade, seen } = setup();
    search.load();
    search.input("volvo");
    workers[0]?.say({ phase: "done", text: "volvo" }, 1);
    search.input("volvo cars");
    workers[0]?.fail();
    expect(workers).toHaveLength(2);
    expect(localMade()).toBe(0);
    expect(workers[1]?.sent).toEqual([
      { type: "init", origin: "https://index.test" },
      { type: "load" },
      { type: "input", seq: 1, text: "volvo cars" },
    ]);
    // The new worker answers; the old one is no longer heard.
    workers[0]?.say({ phase: "no-match", text: "old" }, 9);
    workers[1]?.say({ phase: "done", text: "volvo cars" }, 1);
    expect(seen.at(-1)).toMatchObject({ phase: "done", text: "volvo cars" });
  });

  it("shows an error when the restarted worker fails too", () => {
    const { search, workers, localMade } = setup();
    search.input("volvo");
    workers[0]?.say({ phase: "done", text: "volvo" }, 1);
    workers[0]?.fail();
    workers[1]?.fail();
    expect(search.state).toMatchObject({ phase: "error", reload: true });
    expect(localMade()).toBe(0);
    expect(workers).toHaveLength(2);
  });
});
