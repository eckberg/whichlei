// After a deploy (or a rollback): does the live index serve what it should, the way it
// should? Reads files as a browser would, with compression, and counts the bytes on the wire.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { decodeEntries, filePath, type Manifest, parseManifest } from "@whichlei/core";
import { IMMUTABLE, REVALIDATE } from "./headers.ts";

/** A response with its body as it came over the wire, still compressed. */
export interface RawResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export type Transport = (url: string) => Promise<RawResponse>;

/** HTTPS GET (HTTP for a local test server) asking for br or gzip, no decoding. */
export const httpsTransport: Transport = (url) =>
  new Promise((resolve, reject) => {
    const request = url.startsWith("http:") ? httpRequest : httpsRequest;
    const req = request(url, { headers: { "accept-encoding": "br, gzip" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`${url}: timed out`)));
    req.end();
  });

function decode(response: RawResponse): Buffer {
  const encoding = response.headers["content-encoding"];
  const body = Buffer.from(response.body);
  if (encoding === "gzip") return gunzipSync(body);
  if (encoding === "br") return brotliDecompressSync(body);
  if (encoding === undefined || encoding === "identity") return body;
  throw new Error(`content-encoding ${encoding}`);
}

export interface VerifyRow {
  path: string;
  ok: boolean;
  /** What is wrong, or what was seen. */
  detail: string;
  encoding: string;
  /** Bytes on the wire, and after decoding. */
  transferred: number;
  raw: number;
}

export interface VerifyOptions {
  origin: string;
  /** The live index.json must name this build. */
  build?: string;
  /** The live index.json must name a build other than this. */
  notBuild?: string;
  /** Also fetch a few files of this build, which must still be there. */
  alsoBuild?: string;
  /** Seconds to wait for index.json to name the right build. */
  waitSeconds?: number;
  transport: Transport;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** Time in ms, replaced in tests. */
  now?: () => number;
}

export interface VerifyResult {
  /** The build index.json names. */
  build: string | undefined;
  rows: VerifyRow[];
  ok: boolean;
}

/** The paths to fetch for a build: both ends, the middle, the code names and the report. */
export function samplePaths(build: string, files: number): string[] {
  const picks = new Set([
    0,
    Math.floor(files / 4),
    Math.floor(files / 2),
    Math.floor((3 * files) / 4),
    files - 1,
  ]);
  return [
    ...[...picks]
      .filter((n) => n >= 0 && n < files)
      .sort((a, b) => a - b)
      .map((n) => filePath({ build }, n)),
    `${build}/codes.json`,
    `${build}/report.json`,
  ];
}

function check(
  path: string,
  response: RawResponse,
  wantCache: string,
  mustCompress: boolean,
): VerifyRow {
  const encoding = response.headers["content-encoding"] ?? "none";
  const problems: string[] = [];
  let raw = 0;
  if (response.status !== 200) problems.push(`HTTP ${response.status}`);
  else {
    if (mustCompress && encoding !== "gzip" && encoding !== "br") {
      problems.push(`content-encoding ${encoding}, not gzip or br`);
    }
    if (response.headers["cache-control"] !== wantCache) {
      problems.push(`cache-control "${response.headers["cache-control"]}", not "${wantCache}"`);
    }
    if (response.headers["access-control-allow-origin"] !== "*") {
      problems.push(
        `access-control-allow-origin "${response.headers["access-control-allow-origin"]}"`,
      );
    }
    if (response.headers["x-content-type-options"] !== "nosniff") {
      problems.push(`x-content-type-options "${response.headers["x-content-type-options"]}"`);
    }
    try {
      const text = decode(response);
      raw = text.length;
      if (path.endsWith(".txt")) decodeEntries(text.toString("utf8"));
      else JSON.parse(text.toString("utf8"));
    } catch (error) {
      problems.push(`body: ${(error as Error).message}`);
    }
  }
  return {
    path,
    ok: problems.length === 0,
    detail: problems.length === 0 ? "ok" : problems.join("; "),
    encoding,
    transferred: response.body.length,
    raw,
  };
}

/** Fetches what the live Worker serves and checks it. Does not throw on a failed check. */
export async function verifyLive(options: VerifyOptions): Promise<VerifyResult> {
  const { origin, transport, sleep, log, waitSeconds = 120, now = Date.now } = options;
  const base = origin.replace(/\/+$/, "");
  const rows: VerifyRow[] = [];

  // index.json, until it names the right build: a deploy takes a moment to reach every edge.
  const deadline = now() + waitSeconds * 1000;
  let manifest: Manifest | undefined;
  for (;;) {
    let problem = "";
    let response: RawResponse | undefined;
    try {
      response = await transport(`${base}/index.json?v=${now()}`);
      manifest = parseManifest(JSON.parse(decode(response).toString("utf8")));
      if (options.build !== undefined && manifest.build !== options.build) {
        problem = `index.json names ${manifest.build}, expected ${options.build}`;
      } else if (options.notBuild !== undefined && manifest.build === options.notBuild) {
        problem = `index.json still names ${manifest.build}`;
      }
    } catch (error) {
      manifest = undefined;
      problem = (error as Error).message;
    }
    if (problem === "" && manifest !== undefined && response !== undefined) {
      rows.push(check("index.json", response, REVALIDATE, false));
      break;
    }
    if (now() >= deadline) {
      rows.push({
        path: "index.json",
        ok: false,
        detail: problem,
        encoding: "none",
        transferred: 0,
        raw: 0,
      });
      return { build: manifest?.build, rows, ok: false };
    }
    log(`waiting: ${problem}`);
    await sleep(5000);
  }

  const builds = [manifest.build];
  if (options.alsoBuild !== undefined && options.alsoBuild !== manifest.build)
    builds.push(options.alsoBuild);
  for (const build of builds) {
    // The other build's file count is not known here: its first file and its code names.
    const paths =
      build === manifest.build
        ? samplePaths(build, manifest.bounds.length)
        : [filePath({ build }, 0), `${build}/codes.json`];
    for (const path of paths) {
      let response: RawResponse;
      try {
        response = await transport(`${base}/${path}`);
      } catch (error) {
        rows.push({
          path,
          ok: false,
          detail: (error as Error).message,
          encoding: "none",
          transferred: 0,
          raw: 0,
        });
        continue;
      }
      rows.push(check(path, response, IMMUTABLE, true));
    }
  }
  return { build: manifest.build, rows, ok: rows.every((r) => r.ok) };
}

export function verifyTable(result: VerifyResult): string {
  const cells = result.rows.map((r) => [
    r.ok ? "ok" : "FAIL",
    r.path,
    r.encoding,
    `${r.transferred.toLocaleString("en-US")} B sent`,
    `${r.raw.toLocaleString("en-US")} B raw`,
    r.ok ? "" : r.detail,
  ]);
  const widths = [0, 1, 2, 3, 4].map((i) =>
    Math.max(...cells.map((row) => (row[i] as string).length)),
  );
  const lines = cells.map((row) =>
    row
      .map((cell, i) => (i < 5 ? cell.padEnd(widths[i] as number) : cell))
      .join("  ")
      .trimEnd(),
  );
  const sent = result.rows.reduce((sum, r) => sum + r.transferred, 0);
  const raw = result.rows.reduce((sum, r) => sum + r.raw, 0);
  lines.push(
    `total: ${sent.toLocaleString("en-US")} B sent for ${raw.toLocaleString("en-US")} B raw` +
      (raw > 0 ? ` (${((100 * sent) / raw).toFixed(0)}%)` : ""),
  );
  return lines.join("\n");
}
