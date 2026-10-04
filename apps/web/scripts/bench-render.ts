// CPU time of a record page: renders every recorded fixture 1,000 times and reports the
// median and the 99th percentile per render. The free plan allows 10 ms of CPU per request.
//
//   pnpm --filter @whichlei/web bench
//
// "render" is renderRecordPage on a parsed record: it builds the record document and renders
// the page. "md" and "json" render the Markdown and the JSON from the document. "hit" is a cache
// hit: reading the stored document back and rendering the page. "parse + render" is a cache
// miss on our side: reading GLEIF's JSON document into a record, building the document,
// storing it and rendering the page. It leaves out the wait for GLEIF, which is not CPU time.
// Node on a server CPU, not the Workers runtime.
import { readdirSync, readFileSync } from "node:fs";
import { fetchRecord } from "@whichlei/gleif";
import { renderMarkdown } from "../src/markdown.ts";
import { renderDocumentPage, renderRecordPage } from "../src/record.ts";
import { buildDocument, parseDocument } from "../src/record-document.ts";

const RUNS = 1000;
const WARMUP = 200;
const dir = new URL("../../../packages/gleif/fixtures/", import.meta.url);
const context = { canonicalOrigin: "https://whichlei.com" };

interface Fixture {
  url: string;
  status: number;
  body: unknown;
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

function measure(run: () => unknown): { p50: number; p99: number; max: number } {
  for (let i = 0; i < WARMUP; i++) run();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 50), p99: percentile(times, 99), max: times.at(-1) ?? 0 };
}

async function measureAsync(run: () => Promise<unknown>) {
  for (let i = 0; i < WARMUP; i++) await run();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 50), p99: percentile(times, 99), max: times.at(-1) ?? 0 };
}

const ms = (value: number) => value.toFixed(3).padStart(7);
const rows: string[] = [];
let worst = 0;

for (const file of readdirSync(dir).filter((f) => f.startsWith("record-"))) {
  const fixture = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Fixture;
  if (fixture.status !== 200) continue;
  const lei = /lei-records\/([0-9A-Z]{20})/.exec(fixture.url)?.[1] ?? "";
  const text = JSON.stringify(fixture.body);
  const parse = () =>
    fetchRecord(lei, {
      fetch: async () => new Response(text, { headers: { "content-type": "application/json" } }),
    });
  const record = await parse();
  const page = renderRecordPage(record, context);
  const doc = buildDocument(record, context);
  const stored = JSON.stringify(doc);

  const render = measure(() => renderRecordPage(record, context));
  const markdown = measure(() => renderMarkdown(doc, context.canonicalOrigin));
  const json = measure(() => JSON.stringify(doc, null, 2));
  const hit = measure(() => {
    const read = parseDocument(stored);
    return read && renderDocumentPage(read, context.canonicalOrigin);
  });
  const both = await measureAsync(async () => {
    const built = buildDocument(await parse(), context);
    JSON.stringify(built);
    return renderDocumentPage(built, context.canonicalOrigin);
  });
  worst = Math.max(worst, both.p99, markdown.p99, json.p99, hit.p99);
  rows.push(
    `${file.slice("record-".length, -".json".length).padEnd(14)} ${String(page.length).padStart(6)} B  ` +
      `render p50 ${ms(render.p50)} p99 ${ms(render.p99)}  md p99 ${ms(markdown.p99)}  ` +
      `json p99 ${ms(json.p99)}  hit p99 ${ms(hit.p99)}  ` +
      `parse+render p50 ${ms(both.p50)} p99 ${ms(both.p99)} ms`,
  );
}

console.log(`${RUNS} runs per fixture, after ${WARMUP} warm-up runs. Page size is the HTML.`);
console.log(rows.join("\n"));
console.log(`Worst p99 of any path: ${worst.toFixed(3)} ms (free plan limit: 10 ms CPU)`);
