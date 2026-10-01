// A search that survives its worker. If the worker never answers (its script is missing,
// does not parse, or the CSP refuses it), the same `Search` runs on the page instead. If a
// worker that had been answering throws, it is started once more and sent the newest input;
// if that one fails too, the error is shown. Same `SearchPort` as the others.
import type { SearchPort, SearchState } from "../search/search.ts";
import { RemoteSearch, type WorkerLike } from "./remote.ts";

export class ResilientSearch implements SearchPort {
  readonly #spawn: () => WorkerLike;
  readonly #local: () => SearchPort;
  readonly #origin: string;
  readonly #initial: SearchState;
  readonly #listeners = new Set<(state: SearchState) => void>();
  #port: SearchPort;
  #stop: () => void = () => {};
  #restarts = 0;
  #text = "";
  #loaded = false;

  /** `spawn` starts a worker, `local` makes the search that runs on the page instead. */
  constructor(
    spawn: () => WorkerLike,
    local: () => SearchPort,
    origin: string,
    initial: SearchState,
  ) {
    this.#spawn = spawn;
    this.#local = local;
    this.#origin = origin;
    this.#initial = initial;
    this.#port = this.#remote();
  }

  get state(): SearchState {
    return this.#port.state;
  }

  subscribe(listener: (state: SearchState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  input(text: string): void {
    this.#text = text;
    this.#port.input(text);
  }

  load(): void {
    this.#loaded = true;
    this.#port.load();
  }

  retry(): void {
    this.#port.retry();
  }

  #remote(): RemoteSearch {
    const remote = new RemoteSearch(this.#spawn(), this.#origin, this.#initial, (answered) =>
      this.#failed(remote, answered),
    );
    this.#adopt(remote);
    return remote;
  }

  /** Make `port` the one answering, and say what it knows. */
  #adopt(port: SearchPort) {
    this.#stop();
    this.#stop = port.subscribe((state) => {
      for (const listener of this.#listeners) listener(state);
    });
    this.#port = port;
  }

  #failed(remote: RemoteSearch, answered: boolean) {
    if (this.#port !== remote) return;
    if (this.#restarts === 0 && !answered) {
      // It never worked: run the same code here.
      this.#restarts = 1;
      this.#resume(this.#local());
    } else if (this.#restarts === 0) {
      this.#restarts = 1;
      try {
        this.#resume(this.#remote());
      } catch {
        remote.fail();
      }
    } else {
      remote.fail();
    }
  }

  /** Carry on with `port`: what the page last asked of the old one, asked again. */
  #resume(port: SearchPort) {
    this.#adopt(port);
    if (this.#loaded) port.load();
    if (this.#text !== "") port.input(this.#text);
  }
}
