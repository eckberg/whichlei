// Build every candidate encoding of the reference index and measure it.
//
//   pnpm --filter @whichlei/bench build-index
//
// Reads $DATA_DIR/index (research/ranking/port/dump_index.py). Writes $DATA_DIR/format:
//   <encoding>/index.json, <encoding>/<build>/<n>.txt   the timed encodings, as served
//   sizes.json                                          per-file sizes and the numbers below
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
  decodeEntries,
  encodeEntries,
  filePath,
  parseManifest,
  roundProminence,
} from "@whichlei/core";
import { ENCODINGS } from "../src/encodings.ts";
import { DUMP_DIR, loadEntities, loadFiles, OUT_DIR, type RefEntity, summary } from "./data.ts";

// Build id: golden-copy date and a content hash. The reference dump fixes the contents, so
// its hash stands in for one over the built files.
const ASOF = "2026-09-16";
const hash = createHash("sha256");
for (const f of ["files.tsv", "entities.tsv"]) hash.update(readFileSync(join(DUMP_DIR, f)));
const BUILD = `${ASOF.replaceAll("-", "")}-${hash.digest("hex").slice(0, 16)}`;
/** Cloudflare compresses on the fly; gzip level 6 and brotli quality 4 stand in for it. */
const gzipSize = (text: string) => gzipSync(text, { level: 6 }).length;
const brotliSize = (text: string) =>
  brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }).length;
const KB = 1024;
const MB = 1e6;

const log = (...args: unknown[]) =>
  console.log(`[${process.uptime().toFixed(0).padStart(4)}s]`, ...args);

const entities = await loadEntities();
const files = loadFiles();
log(`reference index: ${files.length} files, ${entities.size} entities`);
const entriesOf = (ids: number[]) => ids.map((id) => (entities.get(id) as RefEntity).entry);

mkdirSync(OUT_DIR, { recursive: true });
const manifest = parseManifest({
  format: 1,
  build: BUILD,
  asOf: ASOF,
  entities: entities.size,
  bounds: files.map((f) => f.bound),
  capped: files.flatMap((f, i) => (f.capped ? [i] : [])),
});
log(`build ${BUILD}`);

const sizes: Record<string, { raw: number[]; gzip: number[]; brotli: number[] }> = {};
for (const enc of ENCODINGS) {
  const dir = join(OUT_DIR, enc.name);
  if (enc.timed) {
    // Earlier builds stay, like a publish that keeps the previous build.
    mkdirSync(join(dir, BUILD), { recursive: true });
    writeFileSync(join(dir, "index.json"), JSON.stringify(manifest));
  }
  const s = { raw: [] as number[], gzip: [] as number[], brotli: [] as number[] };
  files.forEach((file, i) => {
    const text = enc.encode(entriesOf(file.ids));
    s.raw.push(Buffer.byteLength(text));
    s.gzip.push(gzipSize(text));
    s.brotli.push(brotliSize(text));
    if (enc.timed) writeFileSync(join(dir, filePath(manifest, i)), text);
  });
  sizes[enc.name] = s;
  const total = (v: number[]) => (v.reduce((a, b) => a + b, 0) / MB).toFixed(1);
  const kb = summary(s.gzip.map((b) => b / KB));
  log(
    `${enc.name.padEnd(14)} raw ${total(s.raw)} MB, gzip ${total(s.gzip)} MB, brotli ${total(s.brotli)} MB;` +
      ` file gzip KB median ${kb.median.toFixed(1)} p90 ${kb.p90.toFixed(1)} max ${kb.max.toFixed(1)}`,
  );
}

// The core format must give back exactly what was encoded, prominence rounded.
let roundTripErrors = 0;
for (const file of files) {
  const entries = entriesOf(file.ids);
  const expected = entries.map((e) => ({ ...e, prominence: roundProminence(e.prominence) }));
  if (JSON.stringify(decodeEntries(encodeEntries(entries))) !== JSON.stringify(expected)) {
    roundTripErrors++;
  }
}
log(`lines round trip: ${files.length - roundTripErrors}/${files.length} files identical`);

// Routing table: in the manifest as JSON, against plain and front-coded lines.
const bounds = manifest.bounds;
const frontCoded = bounds
  .map((b, i) => {
    const prev = bounds[i - 1] ?? "";
    let n = 0;
    while (n < b.length && b[n] === prev[n]) n++;
    return `${n} ${b.slice(n)}`;
  })
  .join("\n");
const routing = {
  manifestJson: {
    raw: JSON.stringify(manifest).length,
    gzip: gzipSize(JSON.stringify(manifest)),
  },
  plainLines: { gzip: gzipSize(bounds.join("\n")) },
  frontCoded: { gzip: gzipSize(frontCoded) },
  cappedList: { gzip: gzipSize(JSON.stringify(manifest.capped)) },
};
log(
  `routing table gzip: manifest JSON ${(routing.manifestJson.gzip / KB).toFixed(1)} KB` +
    ` (raw ${(routing.manifestJson.raw / KB).toFixed(1)} KB), bounds as lines ${(routing.plainLines.gzip / KB).toFixed(1)} KB,` +
    ` front-coded ${(routing.frontCoded.gzip / KB).toFixed(1)} KB, capped list ${(routing.cappedList.gzip / KB).toFixed(1)} KB`,
);

// Churn: files whose stored content changes overnight from registration age alone
// (p_age = 2.46 x min(age, 15) / 10). New, renewed and lapsed LEIs add to it.
const P_AGE = 2.46;
const DAY = 1 / 365.25;
const churn: Record<string, number> = {};
for (const step of [10, 100]) {
  let changed = 0;
  for (const file of files) {
    const moved = file.ids.some((id) => {
      const e = entities.get(id) as RefEntity;
      const next = e.p + (P_AGE * (Math.min(e.age + DAY, 15) - Math.min(e.age, 15))) / 10;
      return Math.round(e.p * step) !== Math.round(next * step);
    });
    if (moved) changed++;
  }
  churn[`1/${step}`] = changed / files.length;
  log(`churn after one day, prominence in 1/${step}: ${changed}/${files.length} files change`);
}

const reachable = entities.size;
writeFileSync(
  join(OUT_DIR, "sizes.json"),
  JSON.stringify({ files: files.length, reachable, sizes, routing, churn, roundTripErrors }),
);
log("wrote sizes.json");
