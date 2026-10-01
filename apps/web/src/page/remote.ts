// A `SearchPort` that runs the search in a Web Worker (page/worker.ts), so typing never waits
// on scoring. Every input goes over with a sequence number; an answer for an older input is
// ignored. The page gets the same state objects as from `Search`, and keeps the same array
// for the same hits and words, so it redraws only what changed.
import type { ToPage, ToWorker } from "../search/host.ts";
import type { PassStats, SearchPort, SearchState } from "../search/search.ts";

/** The part of a Worker this needs, so tests can fake it. */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  addEventListener(type: "message", listener: (event: { data: ToPage }) => void): void;
  /** The worker's script could not load or threw. */
  addEventListener(type: "error", listener: () => void): void;
}

const sameWords = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((word, i) => word === b[i]);

const sameHits = (a: SearchState["hits"], b: SearchState["hits"]) =>
  a.length === b.length &&
  a.every((hit, i) => hit.entry.lei === b[i]?.entry.lei && hit.typed === b[i]?.typed);

export class RemoteSearch implements SearchPort {
  readonly #worker: WorkerLike;
  readonly #listeners = new Set<(state: SearchState) => void>();
  #state: SearchState;
  #seq = 0;
  stats: PassStats | null = null;

  constructor(worker: WorkerLike, origin: string, initial: SearchState) {
    this.#worker = worker;
    this.#state = initial;
    worker.addEventListener("message", ({ data }) => this.#receive(data));
    // Nothing will ever answer: say so, and offer the reload that may fix an old page.
    worker.addEventListener("error", () => {
      this.#publish({
        ...this.#state,
        phase: "error",
        message: "the search could not start",
        reload: true,
      });
    });
    worker.postMessage({ type: "init", origin });
  }

  get state(): SearchState {
    return this.#state;
  }

  subscribe(listener: (state: SearchState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  input(text: string): void {
    this.#worker.postMessage({ type: "input", seq: ++this.#seq, text });
  }

  load(): void {
    this.#worker.postMessage({ type: "load" });
  }

  retry(): void {
    this.#worker.postMessage({ type: "retry" });
  }

  #receive(message: ToPage) {
    // Answers to an input that is no longer the newest are dropped.
    if (message.type !== "state" || message.seq < this.#seq) return;
    const before = this.#state;
    const next = message.state;
    this.stats = message.stats;
    this.#state = {
      ...next,
      // The same entries and words as before: keep the arrays, so nothing is redrawn.
      hits: sameHits(before.hits, next.hits) ? before.hits : next.hits,
      tokens: sameWords(before.tokens, next.tokens) ? before.tokens : next.tokens,
    };
    this.#publish(this.#state);
  }

  #publish(state: SearchState) {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}
