import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEntries,
  type Entry,
  filePath,
  type Manifest,
  queryTokens,
  route,
  routingTable,
  toCandidate,
  topK,
} from "@whichlei/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildIndex } from "./build.ts";
import { checkIndex, compareReference, IndexDir, replayEvaluation } from "./check.ts";
import { INITIALS_MIN_PROMINENCE, readEntities } from "./entities.ts";
import { FILLERS, fillerLei, fixtureGolden, LEI, writeInputs } from "./fixture.ts";
import { CAP } from "./pack.ts";
import { readRelationships } from "./signals.ts";

const records = 9 + FILLERS;
let root: string;
let out: string;
let manifest: Manifest;
let report: Awaited<ReturnType<typeof buildIndex>>;

/** Every entry of every file, by LEI, and the files each LEI is in. */
function readAll(dir: string): { entries: Map<string, Entry>; inFiles: Map<string, number[]> } {
  const entries = new Map<string, Entry>();
  const inFiles = new Map<string, number[]>();
  manifest.bounds.forEach((_, n) => {
    const text = readFileSync(join(dir, filePath(manifest, n)), "utf8");
    for (const e of decodeEntries(text)) {
      entries.set(e.lei, e);
      inFiles.set(e.lei, [...(inFiles.get(e.lei) ?? []), n]);
    }
  });
  return { entries, inFiles };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "whichlei-indexer-"));
  const inputs = writeInputs(join(root, "in"), fixtureGolden());
  out = join(root, "out");
  report = await buildIndex({ inputs, out, nowYear: 2026.74, dumpProminence: true });
  manifest = JSON.parse(readFileSync(join(out, "index.json"), "utf8")) as Manifest;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("build, end to end on a tiny golden copy", () => {
  test("writes the manifest, the files, the codes and the report", () => {
    expect(readdirSync(out).sort()).toEqual(
      [manifest.build, "build.json", "index.json", "prominence.tsv"].sort(),
    );
    expect(manifest.format).toBe(1);
    expect(manifest.asOf).toBe("2026-09-16");
    expect(manifest.build).toMatch(/^20260916-[0-9a-f]{8}$/);
    const files = readdirSync(join(out, manifest.build)).filter((n) => n.endsWith(".txt"));
    expect(files).toHaveLength(manifest.bounds.length);
    expect(readdirSync(join(out, manifest.build))).toContain("codes.json");
    expect(report.records).toBe(records);
    expect(report.files).toBe(manifest.bounds.length);
    expect(JSON.parse(readFileSync(join(out, "build.json"), "utf8")).build).toBe(manifest.build);
  });

  test("the three shared words make capped files of exactly the cap", () => {
    expect(manifest.capped).toHaveLength(3);
    for (const n of manifest.capped) {
      const text = readFileSync(join(out, filePath(manifest, n)), "utf8");
      expect(decodeEntries(text)).toHaveLength(CAP);
      expect(manifest.bounds[n]).toMatch(/^(acme|holdings|limited)$/);
    }
  });

  test("every entity with an index term is reachable, the others are not", () => {
    const { entries } = readAll(out);
    expect(manifest.entities).toBe(entries.size);
    expect(entries.has(LEI.noTerm)).toBe(false);
    expect(report.stats.noTerms).toBe(1);
    for (const lei of [
      LEI.maersk,
      LEI.ericsson,
      LEI.gazprom,
      LEI.quoted,
      fillerLei(1),
      fillerLei(FILLERS),
    ]) {
      expect(entries.has(lei), lei).toBe(true);
    }
    expect(entries.size).toBe(records - 1);
    expect(report.stats.skipped).toEqual({});
  });

  test("an entity is in the file of each of its terms, found by routing", () => {
    const { inFiles } = readAll(out);
    const table = routingTable(manifest);
    for (const [query, lei] of [
      ["maersk", LEI.maersk],
      ["moeller", LEI.maersk],
      ["ericsson", LEI.ericsson],
      ["gazprom", LEI.gazprom],
      ["газпром", LEI.gazprom],
    ] as const) {
      const files = route(queryTokens(query), table);
      const has = files.some((f) => inFiles.get(lei)?.includes(f));
      // "газпром" has no Latin letters, so no term: only its other names find it.
      expect(has, query).toBe(query !== "газпром");
    }
  });

  test("entries are fields of the format, names as GLEIF has them", () => {
    const { entries } = readAll(out);
    expect(entries.get(LEI.maersk)).toMatchObject({
      name: "A.P. Møller - Mærsk A/S",
      otherNames: ["Maersk", "AP Moeller Maersk"],
      country: "DK",
      status: "I",
    });
    // Tabs, line breaks and quotes: the name comes out on one line, separators as spaces.
    expect(entries.get(LEI.quoted)?.name).toBe('Quote "Q", Inc. Division North');
    expect(entries.get(LEI.ericssonSweden)?.status).toBe("L");
    expect(entries.get(LEI.fund)?.status).toBe("R");
    // Lower case marks an inactive entity.
    expect(entries.get(LEI.inactive)?.status).toBe("i");
  });

  test("other names: trading, alternative-language and transliterated; not previous names", () => {
    const { entries } = readAll(out);
    expect(entries.get(LEI.gazprom)?.otherNames).toEqual(["Gazprom Export", "Gazprom"]);
    // The previous name is not listed; a name equal to the legal name is dropped.
    expect(entries.get(LEI.previous)?.otherNames).toEqual(["Newname Trading"]);
  });

  test("index terms: the names of types 0 to 3, previous names not", async () => {
    const inputs = writeInputs(join(root, "in"), fixtureGolden());
    const { postings, entities } = await readEntities(inputs.lei2, {
      relationships: await readRelationships(inputs.rr),
      isins: new Map(),
      bics: new Set(),
      nowYear: 2026.74,
    });
    const { words, start, entities: ids } = postings.finish();
    const holders = (term: string) => {
      const i = words.indexOf(term);
      return i < 0 ? [] : [...ids.slice(start[i], start[i + 1])].map((id) => entities.lei[id]);
    };
    expect(holders("newname")).toEqual([LEI.previous]);
    expect(holders("trading")).toEqual([LEI.previous]);
    expect(holders("oldname")).toEqual([]);
    // "Møller - Mærsk" folds to "moller" and "maersk"; the trading name adds "moeller".
    expect(holders("moller")).toEqual([LEI.maersk]);
    expect(holders("moeller")).toEqual([LEI.maersk]);
    expect(holders("maersk")).toEqual([LEI.maersk]);
    expect(holders("gazprom")).toEqual([LEI.gazprom]);
    expect(holders("ericsson")).toHaveLength(4);
    // Single characters are not terms.
    expect(words.filter((w) => w.length < 2)).toEqual([]);
  });

  test("prominent entities index the initials of their names", async () => {
    const inputs = writeInputs(join(root, "in"), fixtureGolden());
    const read = async (initialsMinProminence?: number) => {
      const { postings, entities, stats } = await readEntities(inputs.lei2, {
        relationships: await readRelationships(inputs.rr),
        isins: new Map(),
        bics: new Set(),
        nowYear: 2026.74,
        ...(initialsMinProminence === undefined ? {} : { initialsMinProminence }),
      });
      const { words, start, entities: ids } = postings.finish();
      const holders = (term: string) => {
        const i = words.indexOf(term);
        return i < 0 ? [] : [...ids.slice(start[i], start[i + 1])].map((id) => entities.lei[id]);
      };
      return { holders, stats, entities };
    };
    const { holders, stats, entities } = await read();
    // "Telefonaktiebolaget LM Ericsson" -> "tle"; "A.P. Møller - Mærsk A/S" -> "amm".
    expect(holders("tle")).toEqual([LEI.ericsson]);
    expect(holders("amm")).toEqual([LEI.maersk]);
    // "Acme Holdings 7 Limited" has a word that starts with a digit: no initials.
    expect(holders("ah")).toEqual([]);
    const prominent = [...entities.prominence.subarray(0, entities.count)].filter(
      (p) => p >= INITIALS_MIN_PROMINENCE,
    );
    expect(stats.initials).toBeGreaterThan(0);
    expect(stats.initials).toBeLessThanOrEqual(prominent.length);
    // Below the threshold, none; the research's index had none.
    const none = await read(Number.POSITIVE_INFINITY);
    expect(none.holders("tle")).toEqual([]);
    expect(none.stats.initials).toBe(0);
  });

  test("files order entries by prominence, then LEI", () => {
    const { entries } = readAll(out);
    const [file] = route(queryTokens("ericsson"), routingTable(manifest));
    const text = readFileSync(join(out, filePath(manifest, file as number)), "utf8");
    const ericssons = decodeEntries(text).filter((e) => e.name.includes("Ericsson"));
    expect(ericssons.map((e) => e.lei)).toEqual([
      LEI.ericsson,
      LEI.ericssonSweden,
      LEI.inactive,
      LEI.fund,
    ]);
    // The group with children, ISINs and a BIC is the most prominent; a retired fund the least.
    const p = (lei: string) => entries.get(lei)?.prominence as number;
    expect(p(LEI.maersk)).toBeGreaterThan(p(LEI.ericssonSweden));
    expect(p(LEI.fund)).toBeLessThan(p(LEI.inactive));
  });

  test("a search finds what it should", () => {
    const table = routingTable(manifest);
    const top = (query: string) => {
      const tokens = queryTokens(query);
      const pool = new Map<string, ReturnType<typeof toCandidate>>();
      for (const n of route(tokens, table)) {
        const text = readFileSync(join(out, filePath(manifest, n)), "utf8");
        for (const e of decodeEntries(text)) pool.set(e.lei, toCandidate(e));
      }
      return topK(tokens, pool.values()).map((c) => c.id);
    };
    expect(top("ericsson")[0]).toBe(LEI.ericsson);
    expect(top("maersk")[0]).toBe(LEI.maersk);
    expect(top("gazprom")[0]).toBe(LEI.gazprom);
    expect(top("acme holdings 7 limited")[0]).toBe(fillerLei(7));
  });

  test("a name that holds ' | ' stays whole, unless the research's split is asked for", async () => {
    const golden = {
      specs: [
        {
          lei: "PIPE0000000000000001",
          name: "Pipe Holding",
          others: [
            ["Alpha | Beta", "TRADING_OR_OPERATING_NAME"],
            ["Gamma", "ALTERNATIVE_LANGUAGE_LEGAL_NAME"],
          ] as [string, string][],
        },
      ],
      relations: [],
      isins: {},
      bics: [],
    };
    const inputs = writeInputs(join(root, "pipe"), golden);
    const read = async (researchSplit: boolean) => {
      const result = await readEntities(inputs.lei2, {
        relationships: await readRelationships(inputs.rr),
        isins: new Map(),
        bics: new Set(),
        nowYear: 2026.74,
        researchSplit,
      });
      return { names: result.entities.otherNames[0], stats: result.stats };
    };
    const whole = await read(false);
    expect(whole.names).toEqual(["Alpha | Beta", "Gamma"]);
    expect(whole.stats.pipeNames).toBe(1);
    // The research split it in two, paired the pieces with the two types by position and
    // so dropped "Gamma".
    expect((await read(true)).names).toEqual(["Alpha", "Beta"]);
  });

  test("codes.json names legal forms and registration authorities", () => {
    const text = readFileSync(join(out, manifest.build, "codes.json"), "utf8");
    expect(JSON.parse(text)).toEqual({
      elf: { ABCD: "Obshchestvo", XJHM: "Aktiebolag" },
      ra: { RA000421: "United State Register", RA000544: "Bolagsverket" },
    });
    expect(text).not.toContain("\n");
  });

  describe("bad records", () => {
    const bad = {
      specs: [
        { lei: "GOOD0000000000000001", name: "Good Company" },
        { lei: "BLANK000000000000002", name: "  \t " },
        { lei: "NOCOUNTRY0000000003X", name: "No Country Ltd", country: " " },
        { lei: "lower000000000000004", name: "Lower Case Ltd" },
        { lei: "SHORT", name: "Short Id Ltd" },
        { lei: "NEWSTATUS00000000005", name: "New Status Ltd", registration: "SOMETHING_NEW" },
        {
          lei: "OTHERS0000000000006X",
          name: "Names Ltd",
          others: [
            ["", "TRADING_OR_OPERATING_NAME"],
            ["  ", "TRADING_OR_OPERATING_NAME"],
            ["Names Trading", "TRADING_OR_OPERATING_NAME"],
            ["Names\tTrading", "TRADING_OR_OPERATING_NAME"],
            ["Names Ltd", "ALTERNATIVE_LANGUAGE_LEGAL_NAME"],
          ] as [string, string][],
        },
      ],
      relations: [],
      isins: {},
      bics: [],
    };

    test("are skipped and counted by reason, with examples; the rest is built", async () => {
      const inputs = writeInputs(join(root, "bad"), bad);
      const dir = join(root, "bad-out");
      const logs: string[] = [];
      const built = await buildIndex({
        inputs,
        out: dir,
        skipLimit: { count: 10, share: 1 },
        log: (m) => logs.push(m),
      });
      expect(built.records).toBe(7);
      expect(built.stats.skipped).toEqual({
        "empty legal name": 1,
        "bad country": 1,
        "bad LEI": 2,
        "unknown registration status": 1,
      });
      expect(built.stats.examples.map((e) => [e.row, e.reason, e.lei])).toEqual([
        [2, "empty legal name", "BLANK000000000000002"],
        [3, "bad country", "NOCOUNTRY0000000003X"],
        [4, "bad LEI", "lower000000000000004"],
        [5, "bad LEI", "SHORT"],
        [6, "unknown registration status", "NEWSTATUS00000000005"],
      ]);
      expect(logs.join("\n")).toMatch(/WARNING: 5 of 7 rows skipped/);
      const report = JSON.parse(readFileSync(join(dir, "build.json"), "utf8"));
      expect(report.stats.skipped["bad LEI"]).toBe(2);
      // The good rows are in, with their other names cleaned: no empty or repeated names,
      // none equal to the legal name.
      const index = new IndexDir(dir);
      const all = index.manifest.bounds.flatMap((_, n) => index.entries(n));
      expect(new Set(all.map((e) => e.lei))).toEqual(
        new Set(["GOOD0000000000000001", "OTHERS0000000000006X"]),
      );
      expect(all.find((e) => e.lei.startsWith("OTHERS"))?.otherNames).toEqual(["Names Trading"]);
    });

    test("too many fail the build, naming reasons and examples, and write nothing", async () => {
      const inputs = writeInputs(join(root, "bad"), bad);
      const dir = join(root, "bad-fail");
      await expect(buildIndex({ inputs, out: dir })).rejects.toThrow(
        /5 of 7 rows skipped: .*bad LEI.*; e\.g\. row 2 BLANK000000000000002 \(empty legal name\).*more than 1000 or 0\.1% of the rows/,
      );
      expect(() => readFileSync(join(dir, "index.json"))).toThrow();
    });
  });

  test("without a registration authorities list the build goes on, and codes.json has no ra", async () => {
    const dir = join(root, "no-ra");
    const inputs = { ...writeInputs(join(root, "in"), fixtureGolden()), ra: undefined };
    const logs: string[] = [];
    const built = await buildIndex({ inputs, out: dir, log: (m) => logs.push(m) });
    expect(JSON.parse(readFileSync(join(dir, built.build, "codes.json"), "utf8"))).toEqual({
      elf: { ABCD: "Obshchestvo", XJHM: "Aktiebolag" },
    });
    expect(logs.join("\n")).toMatch(/WARNING: no registration authorities list/);
  });

  test("prominence.tsv holds every entity at full precision", () => {
    const rows = readFileSync(join(out, "prominence.tsv"), "utf8").trimEnd().split("\n");
    expect(rows).toHaveLength(records);
    const [lei, p] = (rows[0] as string).split("\t");
    expect(lei).toBe(LEI.maersk);
    expect(Math.fround(Number(p))).toBe(Number(p));
  });

  test("the same input gives the same build, other input another", async () => {
    const again = join(root, "again");
    const inputs = writeInputs(join(root, "in"), fixtureGolden());
    const second = await buildIndex({ inputs, out: again, nowYear: 2026.74 });
    expect(second.build).toBe(manifest.build);
    expect(readFileSync(join(again, "index.json"), "utf8")).toBe(
      readFileSync(join(out, "index.json"), "utf8"),
    );
    const moved = await buildIndex({ inputs, out: again, nowYear: 2026.9 });
    expect(moved.build).not.toBe(manifest.build);
  });

  test("an output directory that holds something else is left alone", async () => {
    const stray = join(root, "stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "notes.txt"), "keep me");
    const inputs = writeInputs(join(root, "in"), fixtureGolden());
    await expect(buildIndex({ inputs, out: stray })).rejects.toThrow(/refusing to overwrite/);
    expect(readFileSync(join(stray, "notes.txt"), "utf8")).toBe("keep me");
  });
});

describe("check", () => {
  test("passes the built index, with sizes and reachability", () => {
    const logs: string[] = [];
    const problems: string[] = [];
    checkIndex(new IndexDir(out), records, { problems, log: (m) => logs.push(m) });
    expect(problems).toEqual([]);
    expect(logs.join("\n")).toMatch(/files: \d+ \(3 capped\)/);
    expect(logs.join("\n")).toMatch(/reachability: 1,608 of 1,609 records, 99\.94%/);
  });

  test("finds a missing file, an edited file and a wrong count", () => {
    const copy = join(root, "broken");
    const inputs = writeInputs(join(root, "in"), fixtureGolden());
    return buildIndex({ inputs, out: copy }).then((r) => {
      rmSync(join(copy, r.build, "0.txt"));
      const index = new IndexDir(copy);
      const problems: string[] = [];
      checkIndex(index, records, { problems, log: () => {} });
      expect(problems.some((p) => /file 0 is missing/.test(p))).toBe(true);
      expect(problems.some((p) => /manifest says/.test(p))).toBe(true);
    });
  });

  test("replays queries and scores the objective", () => {
    const logs: string[] = [];
    const row = (query: string, split: "test" | "train", stratum: string, target: string) => ({
      query,
      split,
      stratum,
      targets: new Set([target]),
    });
    const queries = [
      row("ericsson", "test", "head_label", LEI.ericsson),
      row("maersk", "test", "head_alias", LEI.maersk),
      row("gazprom", "test", "torso", LEI.gazprom),
      row("acme holdings 9 limited", "test", "tail", fillerLei(9)),
      row("ericcson", "test", "typo_first3", LEI.ericsson),
      row("maerks", "test", "typo_later", LEI.maersk),
      // Found nowhere: the tail stratum scores (1 + 0) / 2 over all queries.
      row("nonsense", "train", "tail", LEI.fund),
    ];
    const result = replayEvaluation(new IndexDir(out), (m) => logs.push(m), queries);
    expect(result.test).toBe(1);
    expect(result.all).toBeCloseTo((5 + 0.5) / 6, 12);
    expect(logs[0]).toMatch(
      /7 queries, objective 1\.0000 on the test half \(6 rows\), 0\.9167 on all/,
    );
  });
});

describe("check against a reference index", () => {
  /** What research/ranking/port/dump_index.py writes, made from a built index. */
  function dump(dir: string, reference: string, edit?: (e: string[]) => void): void {
    mkdirSync(reference, { recursive: true });
    const index = new IndexDir(dir);
    const lines: string[] = [];
    const files: string[] = [];
    let id = 0;
    const ids = new Map<string, number>();
    const prominence = new Map(
      readFileSync(join(dir, "prominence.tsv"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => [l.split("\t")[0] as string, l.split("\t")] as const),
    );
    manifest.bounds.forEach((bound, n) => {
      const list = index.entries(n);
      for (const e of list) {
        if (!ids.has(e.lei)) {
          ids.set(e.lei, id++);
          const [, p = "0", age = "0"] = prominence.get(e.lei) ?? [];
          const fields = [
            String(ids.get(e.lei)),
            e.lei,
            e.country,
            e.status,
            p,
            age,
            e.name,
            ...e.otherNames,
          ];
          edit?.(fields);
          lines.push(fields.join("\t"));
        }
      }
      files.push(
        `${bound}\t${manifest.capped.includes(n) ? 1 : 0}\t${list.map((e) => ids.get(e.lei)).join(" ")}`,
      );
    });
    writeFileSync(join(reference, "entities.tsv"), `${lines.join("\n")}\n`);
    writeFileSync(join(reference, "files.tsv"), `${files.join("\n")}\n`);
  }

  test("finds no difference from a copy of itself", async () => {
    const reference = join(root, "ref-same");
    dump(out, reference);
    const problems: string[] = [];
    const logs: string[] = [];
    await compareReference(new IndexDir(out), reference, { problems, log: (m) => logs.push(m) });
    expect(problems).toEqual([]);
    expect(logs.join("\n")).toMatch(/0 differ in which entities/);
    expect(logs.join("\n")).toMatch(/0 differ by more than 1e-6/);
  });

  test("entities swapped within float32 noise are expected; swapped further apart are not", async () => {
    const swap = async (gap: number) => {
      const reference = join(root, `ref-swap-${gap}`);
      dump(out, reference);
      // The first file with two entities: swap them, and give the second a prominence `gap`
      // away from the first's in the reference (ours is unchanged).
      const files = readFileSync(join(reference, "files.tsv"), "utf8").trimEnd().split("\n");
      const at = files.findIndex((l) => (l.split("\t")[2] ?? "").split(" ").length >= 2);
      const [bound, capped, ids] = (files[at] as string).split("\t") as [string, string, string];
      const [first = "", second = "", ...rest] = ids.split(" ");
      files[at] = [bound, capped, [second, first, ...rest].join(" ")].join("\t");
      writeFileSync(join(reference, "files.tsv"), `${files.join("\n")}\n`);
      const rows = readFileSync(join(reference, "entities.tsv"), "utf8").trimEnd().split("\n");
      const f = rows.map((r) => r.split("\t"));
      const one = f.find((r) => r[0] === first) as string[];
      const two = f.find((r) => r[0] === second) as string[];
      one[4] = String(Number(two[4]) - gap);
      writeFileSync(join(reference, "entities.tsv"), `${f.map((r) => r.join("\t")).join("\n")}\n`);
      const problems: string[] = [];
      const logs: string[] = [];
      await compareReference(new IndexDir(out), reference, { problems, log: (m) => logs.push(m) });
      return { problems, logs: logs.join("\n") };
    };
    // Noise: the reference's two prominences differ by 5e-7 and ours (unchanged) by about the
    // same; "first" moved by 5e-7 in the reference, within the limit.
    const noise = await swap(5e-7);
    expect(noise.logs).toMatch(
      /1 differ only by order within 0\.000001 of prominence \(2 positions\)/,
    );
    expect(noise.logs).toMatch(/files: 0 differ in which entities/);
    expect(noise.problems.filter((p) => /files differ/.test(p))).toEqual([]);
    const real = await swap(0.5);
    expect(real.problems.some((p) => /1 files differ from the reference/.test(p))).toBe(true);
  });

  test("finds a changed name and a changed prominence", async () => {
    const reference = join(root, "ref-edited");
    dump(out, reference, (fields) => {
      if (fields[1] === LEI.ericsson) {
        fields[4] = String(Number(fields[4]) + 0.01);
        fields[6] = "Ericsson Telefon";
      }
    });
    const problems: string[] = [];
    await compareReference(new IndexDir(out), reference, { problems, log: () => {} });
    expect(problems.some((p) => /entries differ/.test(p))).toBe(true);
    expect(problems.some((p) => /prominence by more than 1e-6/.test(p))).toBe(true);
  });
});
