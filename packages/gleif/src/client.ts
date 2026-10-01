// A small client for the GLEIF API (https://api.gleif.org/api/v1). It uses only `fetch`, so
// it runs unchanged in browsers, Workers and Node. It sends one header, `Accept`, which
// browsers allow without a CORS preflight. No retries: a failed call throws a GleifError.

import { GleifError, parseRetryAfter } from "./errors.ts";
import { parseIsins, parseRecord, parseSummaries } from "./normalise.ts";
import type { GleifOptions, LeiRecord, LeiSummary, Page, PageOptions } from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.gleif.org/api/v1";

const DEFAULT_LOOKUP_PAGE_SIZE = 10;
const DEFAULT_ISIN_PAGE_SIZE = 100;
/** GLEIF's largest page: `fetchNames` asks about no more LEIs than this in one call. */
const MAX_NAMES = 200;

const baseUrl = (options: GleifOptions) =>
  (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

async function get(
  path: string,
  params: [string, string][],
  options: GleifOptions,
): Promise<unknown> {
  const base = baseUrl(options);
  const query = new URLSearchParams(params).toString();
  const url = `${base}${path}${query === "" ? "" : `?${query}`}`;
  // Call through a local: a browser's `fetch` throws when called as a method of another object.
  const doFetch = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { accept: "application/vnd.api+json" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // An abort is the caller's doing, not a failure. Let it through as it is.
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    throw new GleifError("failed", `Could not reach GLEIF: ${url}`, { cause: error });
  }

  // GLEIF answers 404 with an HTML page, so the status decides, not the body.
  if (response.status === 404) {
    await response.body?.cancel();
    throw new GleifError("not-found", `GLEIF has no such resource: ${url}`, { status: 404 });
  }
  if (response.status === 429) {
    await response.body?.cancel();
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    throw new GleifError("rate-limited", "GLEIF rate limit reached", { status: 429, retryAfter });
  }
  if (!response.ok) {
    throw new GleifError(
      "failed",
      `GLEIF answered ${response.status}: ${await errorTitle(response)}`,
      {
        status: response.status,
      },
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new GleifError("failed", `GLEIF sent a body that is not JSON: ${url}`, {
      status: response.status,
      cause: error,
    });
  }
}

/** The first JSON:API error title in a failed response, else the status text. */
async function errorTitle(response: Response): Promise<string> {
  try {
    const body: unknown = JSON.parse(await response.text());
    const errors = (body as { errors?: { title?: unknown }[] }).errors;
    const title = errors?.[0]?.title;
    if (typeof title === "string") return title;
  } catch {
    // Not JSON:API. Fall through.
  }
  return response.statusText || "no details";
}

function pageParams(options: PageOptions, defaultSize: number) {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? defaultSize;
  const params: [string, string][] = [
    ["page[size]", String(pageSize)],
    ["page[number]", String(page)],
  ];
  return { page, pageSize, params };
}

/**
 * One LEI record, ready to display. One request: the parents and their reporting exceptions
 * come along with `include`. The LEI is not checked here; check it first (ISO 7064).
 * Throws a `not-found` GleifError for an unknown LEI.
 */
export async function fetchRecord(lei: string, options: GleifOptions = {}): Promise<LeiRecord> {
  const document = await get(
    `/lei-records/${encodeURIComponent(lei)}`,
    [["include", "direct-parent,ultimate-parent"]],
    options,
  );
  return parseRecord(document, baseUrl(options));
}

/**
 * The ISINs GLEIF maps to an LEI, one page per call. Large issuers have tens of thousands
 * (Deutsche Bank: 22,689), so read `pageCount` and fetch only what is shown. The default
 * page size is 100.
 */
export async function fetchIsins(
  lei: string,
  options: GleifOptions & PageOptions = {},
): Promise<Page<string>> {
  const { page, pageSize, params } = pageParams(options, DEFAULT_ISIN_PAGE_SIZE);
  const document = await get(`/lei-records/${encodeURIComponent(lei)}/isins`, params, options);
  return parseIsins(document, { page, pageSize });
}

async function lookup(
  filter: string,
  value: string,
  options: GleifOptions & PageOptions,
): Promise<Page<LeiSummary>> {
  const { page, pageSize, params } = pageParams(options, DEFAULT_LOOKUP_PAGE_SIZE);
  const document = await get("/lei-records", [[`filter[${filter}]`, value], ...params], options);
  return parseSummaries(document, { page, pageSize });
}

/**
 * The legal names of up to 200 LEIs, in one request. An LEI GLEIF does not have is absent from
 * the map. No LEIs: an empty map and no request. The LEIs are not checked here.
 */
export async function fetchNames(
  leis: readonly string[],
  options: GleifOptions = {},
): Promise<Map<string, string>> {
  const wanted = new Set(leis);
  const asked = [...wanted].slice(0, MAX_NAMES);
  if (asked.length === 0) return new Map();
  const document = await get(
    "/lei-records",
    [
      ["filter[lei]", asked.join(",")],
      ["page[size]", String(asked.length)],
    ],
    options,
  );
  const page = parseSummaries(document, { page: 1, pageSize: asked.length });
  return new Map(
    page.items.filter((hit) => wanted.has(hit.lei)).map((hit) => [hit.lei, hit.legalName]),
  );
}

/** The entities that issue this ISIN. No hits is an empty page, not an error. */
export function findByIsin(
  isin: string,
  options: GleifOptions & PageOptions = {},
): Promise<Page<LeiSummary>> {
  return lookup("isin", isin.trim(), options);
}

/**
 * The entities with this BIC. GLEIF stores every BIC with its 3-character branch code
 * (`TEERSESSXXX`) and does not match 8 characters, so an 8-character BIC is looked up as its
 * primary office, `XXX`. A branch code is not dropped: DEUTGB2LCLS finds only that branch.
 */
export function findByBic(
  bic: string,
  options: GleifOptions & PageOptions = {},
): Promise<Page<LeiSummary>> {
  const code = bic.trim();
  return lookup("bic", code.length === 8 ? `${code}XXX` : code, options);
}

/**
 * The entities with this register number (`registeredAs`). GLEIF matches whole words, not the
 * whole string, so "556016" also finds "556016-8337". Matches that equal the input, ignoring
 * case, come first. Numbers repeat across registers: compare `registrationAuthorityId`.
 */
export async function findByRegisterNumber(
  registerNumber: string,
  options: GleifOptions & PageOptions = {},
): Promise<Page<LeiSummary>> {
  const wanted = registerNumber.trim();
  const result = await lookup("entity.registeredAs", wanted, options);
  const exact = (hit: LeiSummary) => hit.registerNumber?.toLowerCase() === wanted.toLowerCase();
  return {
    ...result,
    items: [...result.items.filter(exact), ...result.items.filter((hit) => !exact(hit))],
  };
}
