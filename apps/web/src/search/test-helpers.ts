// Fakes for the search tests: an index in memory, and a `fetch` that serves it.
import type { Manifest } from "@whichlei/core";
import { buildFixture, type Fixture, loadPrototype } from "../../scripts/fixture-index.ts";
import type { IndexSource } from "./client.ts";

export const ERICSSON = "549300W9JLPW15XIFM52";

let cached: Fixture | undefined;
/** The prototype's records as an index, built once per test file. */
export function fixture(): Fixture {
  cached ??= buildFixture(loadPrototype());
  return cached;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An `IndexSource` over files in memory. `requests` lists the files asked for, in order. */
export function memorySource(manifest: Manifest, files: Map<number, string>) {
  const requests: { file: number; signal: AbortSignal | undefined }[] = [];
  let manifests = 0;
  const source: IndexSource = {
    manifest: () => {
      manifests++;
      return Promise.resolve(manifest);
    },
    file: (file, signal) => {
      requests.push({ file, signal });
      const text = files.get(file);
      return text === undefined
        ? Promise.reject(new Error(`no file ${file}`))
        : Promise.resolve(text);
    },
  };
  return { source, requests, manifestCalls: () => manifests };
}

export interface FakeServer {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Paths requested, in order, without the origin. */
  log: string[];
  /** Paths whose request was aborted. */
  aborted: string[];
  /** Make the next requests for a path wait until `release` is called. */
  hold(path: string): () => void;
  /** Replace what is served: a new build. Files of the old build then answer 404. */
  publish(manifest: Manifest, files: Map<number, string>): void;
  /** Fail requests for this path with a network error. */
  fail(path: string | null): void;
}

/** A `fetch` that serves an index like the Worker will: the manifest, then `<build>/<n>.txt`. */
export function fakeServer(origin: string, manifest: Manifest, files: Map<number, string>) {
  let current = manifest;
  let served = files;
  const held = new Map<string, Deferred<void>>();
  let failing: string | null = null;
  const server: FakeServer = {
    log: [],
    aborted: [],
    hold(path) {
      const gate = deferred<void>();
      held.set(path, gate);
      return () => gate.resolve();
    },
    publish(next, nextFiles) {
      current = next;
      served = nextFiles;
    },
    fail(path) {
      failing = path;
    },
    async fetch(input, init) {
      const path = input.slice(origin.length + 1);
      server.log.push(path);
      const gate = held.get(path);
      if (gate) {
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            server.aborted.push(path);
            reject(new DOMException("aborted", "AbortError"));
          });
          gate.promise.then(resolve);
        });
      }
      if (failing === path) throw new TypeError("network down");
      if (path === "index.json") return Response.json(current);
      const [build, name] = path.split("/");
      const n = Number(name?.replace(".txt", ""));
      const text = build === current.build ? served.get(n) : undefined;
      if (text === undefined) return new Response("not found", { status: 404 });
      return new Response(text);
    },
  };
  return server;
}
