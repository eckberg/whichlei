// The worker side of a remote search: runs a `Search` for messages from the page. No DOM and
// no Worker globals, so it is tested with a fake `post`; page/worker.ts wires it to the real one.
//
// The page sends every input with a sequence number. The host works on the newest only: inputs
// that arrive while it is busy replace each other, and an answer is posted only while its input
// is still the newest. (A pass of scoring cannot be interrupted, so the newest input waits for
// the pass in progress, and the ones in between are dropped.)
import type { PassStats, Search, SearchState } from "./search.ts";

export type ToWorker =
  | { type: "init"; origin: string }
  | { type: "input"; seq: number; text: string }
  | { type: "load" }
  | { type: "retry" };

export type ToPage = {
  type: "state";
  /** The input this state answers. Zero before the first input. */
  seq: number;
  state: SearchState;
  /** What the pass behind it cost in the worker. tools/bench reads it. */
  stats: PassStats | null;
};

export class SearchHost {
  readonly #search: Search;
  readonly #defer: (run: () => void) => void;
  #newest: { seq: number; text: string } | null = null;
  #working = 0;
  #scheduled = false;

  /** `defer` runs a function in a later task, so inputs already queued are seen first. */
  constructor(
    search: Search,
    post: (message: ToPage) => void,
    defer: (run: () => void) => void = (run) => void setTimeout(run, 0),
  ) {
    this.#search = search;
    this.#defer = defer;
    search.subscribe((state) => {
      // A newer input is waiting: this answer is already stale.
      if (this.#newest !== null && this.#newest.seq > this.#working) return;
      post({ type: "state", seq: this.#working, state, stats: search.stats });
    });
  }

  handle(message: ToWorker): void {
    if (message.type === "input") {
      this.#newest = { seq: message.seq, text: message.text };
      if (!this.#scheduled) {
        this.#scheduled = true;
        this.#defer(() => this.#work());
      }
    } else if (message.type === "load") {
      void this.#search.load();
    } else if (message.type === "retry") {
      void this.#search.retry();
    }
  }

  #work() {
    this.#scheduled = false;
    const input = this.#newest;
    if (input === null) return;
    this.#newest = null;
    this.#working = input.seq;
    void this.#search.input(input.text);
  }
}
