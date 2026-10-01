// Fetching the index: the manifest once, then index files by number. No DOM and no
// framework, so the page, the tests and tools/bench share it.
//
// A build's files never change (docs/index-format.md), so a fetched file is kept for the life
// of the page. A request nobody waits for any more is aborted. A 404 for a file means the
// index was republished and the old build is gone: reload the manifest once, and tell the
// caller to route again if the build changed.
import { filePath, type Manifest, parseManifest, UnsupportedFormatError } from "@whichlei/core";

/** Where the search reads the index from. `IndexClient` is the real one. */
export interface IndexSource {
  /** The manifest the source holds now, without waiting. Null until one has loaded. */
  peek(): Manifest | null;
  /** The manifest. Loaded once; after an `IndexChangedError` it is the new one. */
  manifest(): Promise<Manifest>;
  /**
   * The text of index file `file` of build `build`, the one the caller routed with. If the
   * index has been republished since, the file numbers mean something else: it rejects with
   * `IndexChangedError`, and the caller routes again.
   */
  file(build: string, file: number, signal?: AbortSignal): Promise<string>;
}

/**
 * network: retry. http: an unexpected status. format: the index breaks the format, nothing
 * to do. unsupported: the index has another format version, so this page is old (or new):
 * reload it once, then show an error (docs/index-format.md, reader rules).
 */
export type IndexErrorKind = "network" | "http" | "format" | "unsupported";

/** The index could not be read. */
export class IndexError extends Error {
  readonly kind: IndexErrorKind;
  constructor(kind: IndexErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexError";
    this.kind = kind;
  }
}

/** The index was republished while the page was open: route again with the new manifest. */
export class IndexChangedError extends Error {
  constructor() {
    super("the index was republished");
    this.name = "IndexChangedError";
  }
}

export const isAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const abortError = () => new DOMException("aborted", "AbortError");

/** One request in flight, shared by everyone who wants the same file. */
interface Flight {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface IndexClientOptions {
  fetch?: FetchLike;
  /** Files kept in memory (about 150 KB of text each). */
  maxFiles?: number;
}

export class IndexClient implements IndexSource {
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #maxFiles: number;
  /** Text of fetched files by path, oldest first. */
  readonly #texts = new Map<string, string>();
  readonly #flights = new Map<string, Flight>();
  #current: Manifest | null = null;
  #loading: Promise<Manifest> | null = null;
  #reloading: { from: string; promise: Promise<Manifest> } | null = null;

  /** `origin` is where `index.json` lives, such as `https://index.whichlei.com`. */
  constructor(origin: string, { fetch: fetchFn, maxFiles = 64 }: IndexClientOptions = {}) {
    this.#base = origin.replace(/\/+$/, "");
    // No cookies to or from the index host (spec 11).
    this.#fetch = fetchFn ?? ((input, init) => fetch(input, { ...init, credentials: "omit" }));
    this.#maxFiles = maxFiles;
  }

  peek(): Manifest | null {
    return this.#current;
  }

  manifest(): Promise<Manifest> {
    if (this.#current) return Promise.resolve(this.#current);
    this.#loading ??= this.#loadManifest().then(
      (manifest) => {
        this.#current = manifest;
        this.#loading = null;
        return manifest;
      },
      (error: unknown) => {
        this.#loading = null;
        throw error;
      },
    );
    return this.#loading;
  }

  file(build: string, file: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(abortError());
    const manifest = this.#current;
    if (!manifest) return this.manifest().then(() => this.file(build, file, signal));
    // Routed with another build's table: the same number is another file here.
    if (manifest.build !== build) return Promise.reject(new IndexChangedError());
    const path = filePath(manifest, file);
    const cached = this.#texts.get(path);
    if (cached !== undefined) {
      // Most recently used last.
      this.#texts.delete(path);
      this.#texts.set(path, cached);
      return Promise.resolve(cached);
    }
    let flight = this.#flights.get(path);
    if (!flight) {
      flight = this.#start(path, manifest.build);
      this.#flights.set(path, flight);
    }
    return this.#join(path, flight, signal);
  }

  async #loadManifest(): Promise<Manifest> {
    let response: Response;
    try {
      // Revalidate on every load: the manifest is the one file that changes in place.
      response = await this.#fetch(`${this.#base}/index.json`, { cache: "no-cache" });
    } catch (error) {
      throw new IndexError("network", "could not reach the index", { cause: error });
    }
    if (!response.ok) throw new IndexError("http", `index.json: ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new IndexError("format", "index.json is not JSON", { cause: error });
    }
    try {
      return parseManifest(body);
    } catch (error) {
      const unsupported = error instanceof UnsupportedFormatError;
      throw new IndexError(unsupported ? "unsupported" : "format", "index.json cannot be read", {
        cause: error,
      });
    }
  }

  #start(path: string, build: string): Flight {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      waiters: 0,
      promise: this.#fetchFile(path, build, controller.signal).finally(() => {
        if (this.#flights.get(path) === flight) this.#flights.delete(path);
      }),
    };
    // Every waiter handles the rejection; this keeps an abandoned flight from reporting one.
    flight.promise.catch(() => {});
    return flight;
  }

  async #fetchFile(path: string, build: string, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/${path}`, { signal });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new IndexError("network", "could not reach the index", { cause: error });
    }
    if (response.status === 404) return this.#gone(build);
    if (!response.ok) throw new IndexError("http", `${path}: ${response.status}`);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new IndexError("network", "the index download broke off", { cause: error });
    }
    this.#texts.set(path, text);
    while (this.#texts.size > this.#maxFiles) {
      const oldest = this.#texts.keys().next().value;
      if (oldest === undefined) break;
      this.#texts.delete(oldest);
    }
    return text;
  }

  /** A file of `build` is gone. Reload the manifest once; a new build means route again. */
  async #gone(build: string): Promise<never> {
    const now = this.#current;
    if (now && now.build !== build) throw new IndexChangedError();
    // One reload serves every file that 404s at the same time.
    let reload = this.#reloading;
    if (reload?.from !== build) {
      reload = { from: build, promise: this.#loadManifest() };
      this.#reloading = reload;
    }
    let fresh: Manifest;
    try {
      fresh = await reload.promise;
    } finally {
      if (this.#reloading === reload) this.#reloading = null;
    }
    if (fresh.build === build) {
      throw new IndexError("http", `the index lost a file of build ${build}`);
    }
    this.#current = fresh;
    this.#texts.clear();
    throw new IndexChangedError();
  }

  #join(path: string, flight: Flight, signal?: AbortSignal): Promise<string> {
    flight.waiters++;
    return new Promise<string>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        signal?.removeEventListener("abort", onAbort);
        flight.waiters--;
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        // Nobody wants the file any more: stop downloading it.
        if (flight.waiters === 0 && this.#flights.get(path) === flight) {
          this.#flights.delete(path);
          flight.controller.abort();
        }
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (text) => {
          if (leave()) resolve(text);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        },
      );
    });
  }
}
