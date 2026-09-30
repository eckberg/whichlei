// Browser side of the search benchmark (scripts/search.ts drives it). Runs the production
// `Search` and `IndexClient` from apps/web, not a copy, over the full reference index: each
// query is typed one key at a time, and the files it fetches and the time of each pass are
// recorded. Nothing here scores or routes; that is the module under test.
import { queryTokens } from "@whichlei/core";
import { IndexClient } from "../../../apps/web/src/search/client.ts";
import { type PassStats, Search } from "../../../apps/web/src/search/search.ts";

/**
 * "every": the debounce fires on every key (fast typing against a 150 ms debounce): each key
 * is a typing pass and then a pause pass. "last": it fires only after the last key.
 */
export type Debounce = "every" | "last";

export interface SearchRun {
  query: string;
  /** Index files requested while the query was typed. */
  files: number[];
  /** Per key with tokens: milliseconds of main-thread work, all its passes together. */
  keystrokes: number[];
  /** Per key: the longest single pass, which is what blocks the next key press. */
  slowestPass: number[];
  /** Per key: the share of a key's time spent decoding and tokenising new files. */
  parse: number[];
  /** The first ten LEIs of the final answer. */
  top: string[];
}

async function runQuery(base: string, query: string, mode: Debounce): Promise<SearchRun> {
  const files = new Set<number>();
  const client = new IndexClient(base, {
    fetch: (url, init) => {
      const file = /\/(\d+)\.txt$/.exec(url)?.[1];
      if (file !== undefined) files.add(Number(file));
      return fetch(url, init);
    },
  });
  // No timer: the pause is called by hand, so the passes are the ones the mode says.
  const search = new Search(client, { debounceMs: Number.POSITIVE_INFINITY });
  await search.load();
  const run: SearchRun = { query, files: [], keystrokes: [], slowestPass: [], parse: [], top: [] };
  let seen: PassStats | null = null;
  for (let k = 1; k <= query.length; k++) {
    const typed = query.slice(0, k);
    if (queryTokens(typed).length === 0) continue;
    let ms = 0;
    let parse = 0;
    let slowest = 0;
    const take = () => {
      const stats = search.stats;
      if (!stats || stats === seen) return;
      seen = stats;
      ms += stats.ms;
      parse += stats.parseMs;
      slowest = Math.max(slowest, stats.ms);
    };
    await search.input(typed);
    take();
    if (mode === "every" || k === query.length) {
      await search.pause();
      take();
    }
    run.keystrokes.push(ms);
    run.slowestPass.push(slowest);
    run.parse.push(parse);
  }
  run.files = [...files];
  run.top = search.state.hits.slice(0, 10).map((hit) => hit.entry.lei);
  return run;
}

async function runSearch(
  encoding: string,
  queries: string[],
  mode: Debounce,
): Promise<SearchRun[]> {
  const out: SearchRun[] = [];
  for (const query of queries) {
    out.push(await runQuery(`${location.origin}/data/${encoding}`, query, mode));
  }
  return out;
}

declare global {
  interface Window {
    benchSearch: { runSearch: typeof runSearch };
  }
}
window.benchSearch = { runSearch };
