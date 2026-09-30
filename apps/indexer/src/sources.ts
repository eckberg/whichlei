// Where the inputs come from: GLEIF's golden copy, its ISIN and BIC mapping files, and two
// code lists. Port of research/ranking/fetch_data.py. The download is a function of a
// publish date (or "latest") and of `fetch`, which tests replace.
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
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
  ra: string;
  /** Publish date of the golden copy, YYYY-MM-DD. */
  asOf: string;
  /** Records the publishes API announced for the level 1 file, when it was downloaded. */
  records: number | undefined;
}

type Fetch = typeof fetch;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A directory that already holds the inputs, as the research's `research/data` does. */
export async function localInputs(dir: string, publishDate?: string): Promise<Inputs> {
  const found = async (name: string): Promise<string> => {
    for (const path of [join(dir, name), join(dir, "signals", name)]) {
      try {
        if ((await stat(path)).isFile()) return path;
      } catch {}
    }
    throw new Error(
      `${name} is not in ${dir} (or ${join(dir, "signals")}); it has ${await list(dir)}`,
    );
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
    ra: await found(FILE_NAMES.ra),
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

// ---- The publishes API ------------------------------------------------------------

interface Publish {
  publish_date: string;
  lei2: { full_file: { csv: { url: string; record_count?: number } } };
  rr: { full_file: { csv: { url: string } } };
}

export async function getJson(url: string, doFetch: Fetch = fetch): Promise<unknown> {
  const response = await withRetries(() =>
    doFetch(url, { headers: { Accept: "application/json" } }),
  );
  return response.json();
}

async function withRetries(attempt: () => Promise<Response>, tries = 3): Promise<Response> {
  let failure: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      const response = await attempt();
      if (response.ok) return response;
      failure = new Error(`${response.status} ${response.statusText} from ${response.url}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      failure = error;
    }
    if (i < tries) await new Promise((resolve) => setTimeout(resolve, 2000 * i));
  }
  throw failure;
}

/**
 * The golden copy published on `date`, or the latest. GLEIF publishes several times a day;
 * a date takes the 08:00 one, as the research did, else the newest of that day.
 */
export async function resolvePublish(
  date: string,
  doFetch: Fetch = fetch,
): Promise<{ asOf: string; lei2: string; rr: string; records: number | undefined }> {
  const page = async (n: number) =>
    ((await getJson(`${PUBLISHES_API}?page=${n}`, doFetch)) as { data: Publish[] }).data;
  const pick = (row: Publish) => ({
    asOf: row.publish_date.slice(0, 10),
    lei2: row.lei2.full_file.csv.url,
    rr: row.rr.full_file.csv.url,
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

/** The newest upload of a mapping file. GLEIF keeps no history by date. */
export async function latestMapping(
  kind: "isin-lei" | "bic-lei",
  doFetch: Fetch = fetch,
): Promise<string> {
  const { data } = (await getJson(`${MAPPING_API}/${kind}`, doFetch)) as {
    data: { attributes: { downloadLink: string } }[];
  };
  const link = data[0]?.attributes.downloadLink;
  if (link === undefined) throw new Error(`the mapping API lists no ${kind} file`);
  return link;
}

/** The CSV a code list page links to. */
export async function codeListLink(
  page: string,
  pattern: RegExp,
  doFetch: Fetch = fetch,
): Promise<string> {
  const html = await (await withRetries(() => doFetch(page))).text();
  const links = [...html.matchAll(/href="(https:\/\/www\.gleif\.org\/[^"]*\.csv)"/g)].map(
    (m) => m[1] as string,
  );
  const link = links.find((l) => pattern.test(l));
  if (link === undefined) throw new Error(`no CSV link matching ${pattern} on ${page}`);
  return link;
}

// ---- Downloading ------------------------------------------------------------------

/** Download `url` to `destination`, through a `.part` file, with retries. */
export async function download(
  url: string,
  destination: string,
  doFetch: Fetch = fetch,
): Promise<void> {
  const part = `${destination}.part`;
  const response = await withRetries(() => doFetch(url));
  if (response.body === null) throw new Error(`${url} returned no body`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(part));
  await rename(part, destination);
}

/** Download the inputs for a publish date, or "latest", into `dir`. */
export async function downloadInputs(
  dir: string,
  publishDate: string,
  doFetch: Fetch = fetch,
  log: (message: string) => void = () => {},
): Promise<Inputs> {
  await mkdir(dir, { recursive: true });
  const publish = await resolvePublish(publishDate, doFetch);
  const plan: [keyof typeof FILE_NAMES, string][] = [
    ["lei2", publish.lei2],
    ["rr", publish.rr],
    ["isin", await latestMapping("isin-lei", doFetch)],
    ["bic", await latestMapping("bic-lei", doFetch)],
    ["elf", await codeListLink(ELF_PAGE, /elf-code-list/i, doFetch)],
    ["ra", await codeListLink(RA_PAGE, /ra-list/i, doFetch)],
  ];
  const paths = {} as Record<keyof typeof FILE_NAMES, string>;
  for (const [key, url] of plan) {
    const path = join(dir, FILE_NAMES[key]);
    const started = Date.now();
    await download(url, path, doFetch);
    paths[key] = path;
    log(`${FILE_NAMES[key]}: ${url} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
  return { ...paths, asOf: publish.asOf, records: publish.records };
}
