// Where the inputs come from: GLEIF's golden copy, its ISIN and BIC mapping files, and two
// code lists. Port of research/ranking/fetch_data.py. The download is a function of a
// publish date (or "latest") and of `fetch`, which tests replace.
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { firstMember } from "./unzip.ts";

export const PUBLISHES_API = "https://goldencopy.gleif.org/api/v2/golden-copies/publishes";
export const MAPPING_API = "https://mapping.gleif.org/api/v2";
export const ELF_PAGE =
  "https://www.gleif.org/en/lei-data/code-lists/iso-20275-entity-legal-forms-code-list";
export const RA_PAGE =
  "https://www.gleif.org/en/lei-data/code-lists/gleif-registration-authorities-list";

/** The input files in a directory, under the names the research used. */
export const FILE_NAMES = {
  lei2: "lei2.csv.zip",
  rr: "rr.csv.zip",
  isin: "isin-lei.zip",
  bic: "bic-lei.zip",
  elf: "elf-raw.csv",
  ra: "ra-list.csv",
} as const;

export interface Inputs {
  lei2: string;
  rr: string;
  isin: string;
  bic: string;
  elf: string;
  /** The registration authorities list. A directory the research filled has none. */
  ra: string | undefined;
  /** Publish date of the golden copy, YYYY-MM-DD. */
  asOf: string;
  /** Records the publishes API announced for the level 1 file, when it was downloaded. */
  records: number | undefined;
}

type Fetch = typeof fetch;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A directory that already holds the inputs, as the research's `research/data` does. */
export async function localInputs(dir: string, publishDate?: string): Promise<Inputs> {
  const look = async (name: string): Promise<string | undefined> => {
    for (const path of [join(dir, name), join(dir, "signals", name)]) {
      try {
        if ((await stat(path)).isFile()) return path;
      } catch {}
    }
    return undefined;
  };
  const found = async (name: string): Promise<string> => {
    const path = await look(name);
    if (path === undefined) {
      throw new Error(
        `${name} is not in ${dir} (or ${join(dir, "signals")}); it has ${await list(dir)}`,
      );
    }
    return path;
  };
  const lei2 = await found(FILE_NAMES.lei2);
  const asOf =
    publishDate !== undefined && publishDate !== "latest" ? publishDate : dateOfMember(lei2);
  if (!DATE.test(asOf)) throw new Error(`publish date ${asOf} is not YYYY-MM-DD`);
  return {
    lei2,
    rr: await found(FILE_NAMES.rr),
    isin: await found(FILE_NAMES.isin),
    bic: await found(FILE_NAMES.bic),
    elf: await found(FILE_NAMES.elf),
    ra: await look(FILE_NAMES.ra),
    asOf,
    records: undefined,
  };
}

async function list(dir: string): Promise<string> {
  try {
    return (await readdir(dir)).join(", ") || "nothing";
  } catch {
    return "no such directory";
  }
}

/** The golden copy's date from its member name, "20260916-0800-gleif-goldencopy-lei2-...". */
function dateOfMember(zipPath: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-/.exec(firstMember(zipPath));
  if (!match) throw new Error(`cannot read the publish date from ${zipPath}; pass --publish-date`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// ---- Talking to GLEIF ---------------------------------------------------------------

/** How the downloader reaches the network. Tests replace all of it. */
export interface Http {
  fetch?: Fetch;
  /** Wait between attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** An attempt that gets no byte for this long is abandoned and retried. */
  idleMs?: number;
  /** Attempts per request or download. */
  tries?: number;
  /** Base of the wait between attempts: it grows with each one. */
  backoffMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A failure that another attempt will not fix, such as a 404. */
class Permanent extends Error {}

/** An abort signal that fires when nothing has happened for `ms`; `touch` resets it. */
function idleSignal(ms: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`no data for ${ms / 1000} s`)), ms);
  };
  touch();
  return { signal: controller.signal, touch, stop: () => clearTimeout(timer) };
}

/**
 * Run `attempt` until it succeeds, up to `tries` times with a growing wait between. An
 * attempt is a whole request: connect, headers and body, so a connection that resets half
 * way through a body is tried again from the start. `attempt` gets a signal that fires
 * when the connection stalls, and a `touch` to call whenever data arrives.
 */
async function withRetries<T>(
  what: string,
  http: Http,
  attempt: (idle: ReturnType<typeof idleSignal>) => Promise<T>,
): Promise<T> {
  const { tries = 3, idleMs = 60_000, backoffMs = 2000, sleep = wait } = http;
  let failure: unknown;
  for (let i = 1; i <= tries; i++) {
    const idle = idleSignal(idleMs);
    try {
      return await attempt(idle);
    } catch (error) {
      failure = error;
      if (error instanceof Permanent) break;
    } finally {
      idle.stop();
    }
    if (i < tries) await sleep(backoffMs * i);
  }
  const reason = failure instanceof Error ? (failure.cause ?? failure) : failure;
  throw new Error(`${what}: ${String(reason instanceof Error ? reason.message : reason)}`, {
    cause: failure,
  });
}

/** A response that is not OK: permanent unless the server is at fault or busy. */
function statusError(response: Response): Error {
  const message = `${response.status} ${response.statusText} from ${response.url}`;
  const retry = response.status >= 500 || response.status === 429;
  return retry ? new Error(message) : new Permanent(message);
}

async function request(
  url: string,
  http: Http,
  idle: ReturnType<typeof idleSignal>,
  accept?: string,
): Promise<Response> {
  const doFetch = http.fetch ?? fetch;
  const response = await doFetch(url, {
    signal: idle.signal,
    ...(accept === undefined ? {} : { headers: { Accept: accept } }),
  });
  if (!response.ok) throw statusError(response);
  return response;
}

export async function getJson(url: string, http: Http = {}): Promise<unknown> {
  return withRetries(`GET ${url}`, http, async (idle) => {
    // GLEIF's APIs speak JSON:API; the mapping API answers 406 to plain application/json.
    const response = await request(url, http, idle, "application/vnd.api+json, application/json");
    return response.json();
  });
}

async function getText(url: string, http: Http): Promise<string> {
  return withRetries(`GET ${url}`, http, async (idle) => (await request(url, http, idle)).text());
}

/** A file to download, and its size if the API says. */
export interface Remote {
  url: string;
  size?: number;
}

interface Csv {
  url: string;
  size?: number;
  record_count?: number;
}
interface Publish {
  publish_date: string;
  lei2: { full_file: { csv: Csv } };
  rr: { full_file: { csv: Csv } };
}

export interface Resolved {
  /** `YYYY-MM-DD`. */
  asOf: string;
  /** When the golden copy was published, ISO 8601, UTC. */
  publishedAt: string;
  lei2: Remote;
  rr: Remote;
  records: number | undefined;
}

/** `2026-09-16 08:00:00` as `2026-09-16T08:00:00Z`. */
const isoOf = (publishDate: string) => `${publishDate.replace(" ", "T")}Z`;

const remote = ({ url, size }: Csv): Remote => (size === undefined ? { url } : { url, size });

/**
 * The golden copy published on `date`, or the latest. GLEIF publishes three times a day;
 * a date takes the 08:00 one, as the research did, else the newest of that day.
 */
export async function resolvePublish(date: string, http: Http = {}): Promise<Resolved> {
  const page = async (n: number) =>
    ((await getJson(`${PUBLISHES_API}?page=${n}`, http)) as { data: Publish[] }).data;
  const pick = (row: Publish): Resolved => ({
    asOf: row.publish_date.slice(0, 10),
    publishedAt: isoOf(row.publish_date),
    lei2: remote(row.lei2.full_file.csv),
    rr: remote(row.rr.full_file.csv),
    records: row.lei2.full_file.csv.record_count,
  });
  if (date === "latest") {
    const [newest] = await page(1);
    if (newest === undefined) throw new Error("the publishes API returned no golden copy");
    return pick(newest);
  }
  if (!DATE.test(date)) throw new Error(`publish date ${date} is not YYYY-MM-DD or "latest"`);
  // Newest first, and a day can run over a page boundary, so collect the whole day: stop at
  // the first page that reaches back before it.
  const day: Publish[] = [];
  for (let n = 1; ; n++) {
    const rows = await page(n);
    if (rows.length === 0) break;
    day.push(...rows.filter((row) => row.publish_date.startsWith(date)));
    if ((rows.at(-1)?.publish_date ?? "") < date) break;
  }
  const chosen = day.find((row) => row.publish_date === `${date} 08:00:00`) ?? day[0];
  if (chosen === undefined) throw new Error(`no golden copy was published on ${date}`);
  return pick(chosen);
}

/** One upload in GLEIF's mapping API, as it lists them. */
export interface MappingUpload {
  attributes: { fileName: string; uploadedAt: string; downloadLink: string } & {
    valid?: boolean;
    processed?: boolean;
  };
}

/**
 * The newest upload that was already there when the golden copy came out: uploaded at or
 * before `publishedAt`, and both `valid` and `processed` (GLEIF's own checks). Uploads of
 * any order. `undefined` if there is none.
 */
export function pickMapping(
  uploads: readonly MappingUpload[],
  publishedAt: string,
): MappingUpload | undefined {
  const limit = Date.parse(publishedAt);
  let best: MappingUpload | undefined;
  for (const upload of uploads) {
    const { uploadedAt, valid, processed } = upload.attributes;
    const at = Date.parse(uploadedAt);
    if (valid !== true || processed !== true || Number.isNaN(at) || at > limit) continue;
    if (best === undefined || at > Date.parse(best.attributes.uploadedAt)) best = upload;
  }
  return best;
}

/**
 * The mapping file that matches a golden copy: the newest upload from before it. The API
 * lists uploads newest first, 100 to a page, so this reads pages until one reaches back
 * past the golden copy's time.
 */
export async function findMapping(
  kind: "isin-lei" | "bic-lei",
  publishedAt: string,
  http: Http = {},
): Promise<string> {
  let url: string | undefined = `${MAPPING_API}/${kind}?page%5Bsize%5D=100`;
  for (let pages = 0; url !== undefined && pages < 100; pages++) {
    const body = (await getJson(url, http)) as {
      data: MappingUpload[];
      links?: { next?: string | null };
    };
    const found = pickMapping(body.data, publishedAt);
    // Newest first: pages before this one had no valid upload from before the golden copy,
    // so the best one is on this page, if there is one.
    if (found !== undefined) return found.attributes.downloadLink;
    url = body.links?.next ?? undefined;
  }
  throw new Error(`the mapping API has no valid ${kind} upload from before ${publishedAt}`);
}

/** The CSV a code list page links to. */
export async function codeListLink(
  page: string,
  pattern: RegExp,
  http: Http = {},
): Promise<string> {
  const html = await getText(page, http);
  const links = [...html.matchAll(/href="(https:\/\/www\.gleif\.org\/[^"]*\.csv)"/g)].map(
    (m) => m[1] as string,
  );
  const link = links.find((l) => pattern.test(l));
  if (link === undefined) throw new Error(`no CSV link matching ${pattern} on ${page}`);
  return link;
}

// ---- Downloading ------------------------------------------------------------------

/**
 * Download `remote` to `destination`, through a `.part` file. An attempt that resets, stalls,
 * delivers a different number of bytes than the API (or Content-Length) announced, or is a
 * zip that does not test clean, is deleted and tried again from the start.
 */
export async function download(
  remote: Remote,
  destination: string,
  http: Http = {},
): Promise<void> {
  const part = `${destination}.part`;
  try {
    await withRetries(`download ${remote.url}`, http, async (idle) => {
      const response = await request(remote.url, http, idle);
      if (response.body === null) throw new Error("no body");
      let bytes = 0;
      const count = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          idle.touch();
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as never), count, createWriteStream(part), {
        signal: idle.signal,
      });
      const announced = remote.size ?? Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(announced) && bytes !== announced) {
        throw new Error(`got ${bytes} bytes, expected ${announced}`);
      }
      if (destination.endsWith(".zip")) {
        try {
          execFileSync("unzip", ["-tqq", part], { stdio: "pipe" });
        } catch (error) {
          throw new Error(`the zip does not test clean: ${(error as Error).message}`);
        }
      }
    });
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  await rename(part, destination);
}

/** Download the inputs for a publish date, or "latest", into `dir`. */
export async function downloadInputs(
  dir: string,
  publishDate: string,
  http: Http = {},
  log: (message: string) => void = () => {},
): Promise<Inputs> {
  await mkdir(dir, { recursive: true });
  const publish = await resolvePublish(publishDate, http);
  const plan: [keyof typeof FILE_NAMES, Remote][] = [
    ["lei2", publish.lei2],
    ["rr", publish.rr],
    ["isin", { url: await findMapping("isin-lei", publish.publishedAt, http) }],
    ["bic", { url: await findMapping("bic-lei", publish.publishedAt, http) }],
    ["elf", { url: await codeListLink(ELF_PAGE, /elf-code-list/i, http) }],
    ["ra", { url: await codeListLink(RA_PAGE, /ra-list/i, http) }],
  ];
  const paths = {} as Record<keyof typeof FILE_NAMES, string>;
  for (const [key, file] of plan) {
    const path = join(dir, FILE_NAMES[key]);
    const started = Date.now();
    await download(file, path, http);
    paths[key] = path;
    log(`${FILE_NAMES[key]}: ${file.url} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
  return { ...paths, asOf: publish.asOf, records: publish.records };
}
