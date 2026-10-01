// Assemble the directory the Worker serves: the new build, the live build (so a page that
// loaded the old index.json keeps working), the new index.json and the headers.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { decodeEntries, filePath, type Manifest, parseManifest } from "@whichlei/core";
import { headersFile } from "./headers.ts";
import { getRetry, type Http, liveManifest } from "./live.ts";
import type { Measured } from "./report.ts";

/** Cloudflare's limit on files per Worker version, free plan. */
export const FILE_LIMIT = 20_000;

export interface AssembleOptions {
  /** The indexer's output directory, after `index checks` passed. */
  build: string;
  /** The directory to fill, `publish`. Emptied first. */
  out: string;
  /** Origin of the live index. Without it nothing is kept: a first publish. */
  live?: string;
  http: Http;
  /** Parallel downloads. */
  concurrency?: number;
  /** Fail if the version would hold this many files or more. */
  maxFiles?: number;
  /** Download attempts per file, counting a file that fails verification. */
  attempts?: number;
}

export interface AssembleResult {
  /** Files in the directory, not counting `_headers`. */
  files: number;
  bytes: number;
  /** The builds in the directory, the new one first. */
  builds: string[];
  /** The live build that was kept, if any. */
  previous: string | undefined;
  downloaded: number;
}

/** What a downloaded file must be: a whole index file, or valid JSON. */
function verify(path: string, bytes: Buffer): void {
  const text = bytes.toString("utf8");
  if (path.endsWith(".txt")) {
    decodeEntries(text);
    return;
  }
  const json = JSON.parse(text) as unknown;
  if (typeof json !== "object" || json === null) throw new Error("not a JSON object");
}

/** Bytes of every file under `dir`. */
function directoryBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
  }
  return total;
}

/** Runs `task` over `items`, `concurrency` at a time. Stops starting new ones on the first failure. */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const item = items[next++];
      if (item === undefined) return;
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

export async function assemble(options: AssembleOptions): Promise<AssembleResult> {
  const {
    build: dir,
    out,
    live,
    http,
    concurrency = 16,
    maxFiles = FILE_LIMIT,
    attempts = 3,
  } = options;
  const { log } = http;

  const measured = JSON.parse(readFileSync(join(dir, "measured.json"), "utf8")) as Measured;
  if (!measured.passed)
    throw new Error("the checks did not pass for this build: nothing to publish");
  const manifestText = readFileSync(join(dir, "index.json"), "utf8");
  const manifest = parseManifest(JSON.parse(manifestText));
  if (measured.report.build !== manifest.build) {
    throw new Error(
      `measured.json is for ${measured.report.build}, index.json names ${manifest.build}`,
    );
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, manifest.build), { recursive: true });
  let files = 0;

  // The new build.
  const wanted = [
    ...Array.from({ length: manifest.bounds.length }, (_, n) => `${n}.txt`),
    "codes.json",
  ];
  const present = new Set(readdirSync(join(dir, manifest.build)));
  const missing = wanted.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} files of ${manifest.build} are missing, such as ${missing[0]}`,
    );
  }
  for (const name of wanted) {
    copyFileSync(join(dir, manifest.build, name), join(out, manifest.build, name));
    files++;
  }
  const report = `${JSON.stringify(measured.report, null, 2)}\n`;
  writeFileSync(join(out, manifest.build, "report.json"), report);
  files++;
  log(`new build ${manifest.build}: ${files} files copied`);

  // The live build.
  let previous: Manifest | undefined;
  let downloaded = 0;
  if (live !== undefined) {
    previous = await liveManifest(http, live);
    if (previous === undefined) log("no live index: a first publish, nothing to keep");
    else if (previous.build === manifest.build) {
      log(`the live build is this build, ${manifest.build}: nothing to keep`);
      previous = undefined;
    }
  }
  if (previous !== undefined && live !== undefined) {
    const origin = live.replace(/\/+$/, "");
    const build = previous.build;
    mkdirSync(join(out, build), { recursive: true });
    const names = [
      ...Array.from({ length: previous.bounds.length }, (_, n) =>
        filePath(previous as Manifest, n),
      ),
      `${build}/codes.json`,
      `${build}/report.json`,
    ];
    if (files + names.length + 1 >= maxFiles) {
      throw new Error(
        `the version would hold ${files + names.length + 1} files, the limit is ${maxFiles}`,
      );
    }
    log(`keeping live build ${build}: downloading ${names.length} files from ${origin}`);
    const started = Date.now();
    await pool(names, concurrency, async (path) => {
      // report.json may be absent from a build published before reports existed.
      const optional = path.endsWith("/report.json");
      let problem = "";
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = await getRetry(http, `${origin}/${path}`);
        if (response.status === 404 && optional) {
          await response.body?.cancel();
          return;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`live file ${path}: HTTP ${response.status}`);
        }
        const body = Buffer.from(await response.arrayBuffer());
        try {
          verify(path, body);
        } catch (error) {
          problem = (error as Error).message;
          await http.sleep(250 * attempt);
          continue;
        }
        const target = join(out, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
        files++;
        downloaded++;
        if (downloaded % 1000 === 0) {
          log(
            `  ${downloaded} of ${names.length} downloaded, ${((Date.now() - started) / 1000).toFixed(0)} s`,
          );
        }
        return;
      }
      throw new Error(`live file ${path} is corrupt after ${attempts} downloads: ${problem}`);
    });
    log(`downloaded ${downloaded} files in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }

  // The new manifest, last: it is the file that switches pages to the new build.
  writeFileSync(join(out, "index.json"), manifestText);
  files++;
  if (files >= maxFiles) {
    throw new Error(`the version holds ${files} files, the limit is ${maxFiles}`);
  }
  const builds = previous === undefined ? [manifest.build] : [manifest.build, previous.build];
  writeFileSync(join(out, "_headers"), headersFile(builds));

  return { files, bytes: directoryBytes(out), builds, previous: previous?.build, downloaded };
}
