// Compare this package with the Python reference at full scale. Run by hand, not in CI:
// it needs GLEIF's files and the reference outputs from research/ranking/port/dump_parity.py.
//
//   DATA_DIR=research/data pnpm --filter @whichlei/core parity
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type Candidate,
  isValidBic,
  isValidIsin,
  type NameTokens,
  nameTokens,
  queryTokens,
  topK,
} from "../src/index.ts";

const DATA_DIR = process.env.DATA_DIR ?? "research/data";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function report(
  label: string,
  total: number,
  differences: string[],
  outcome = "identical",
): boolean {
  console.log(`${label}: ${total - differences.length}/${total} ${outcome}`);
  for (const line of differences.slice(0, 10)) console.log(`  ${line}`);
  return differences.length === 0;
}

async function checkNames(): Promise<boolean> {
  const lines = createInterface({ input: createReadStream(join(DATA_DIR, "parity/names.jsonl")) });
  let total = 0;
  const differences: string[] = [];
  for await (const line of lines) {
    const [name, seq, extras] = JSON.parse(line) as [string, string[], string[]];
    const tokens = nameTokens(name);
    total++;
    if (!same(tokens.seq, seq) || !same(tokens.extras, extras)) {
      differences.push(
        `${JSON.stringify(name)}: ${JSON.stringify(tokens)} vs ${JSON.stringify({ seq, extras })}`,
      );
    }
  }
  return report("name tokens", total, differences);
}

interface Cases {
  ents: Record<string, [string[], number]>;
  queries: { q: string; cand: number[]; top: number[] }[];
}

function checkTopTen(): boolean {
  const cases = JSON.parse(readFileSync(join(DATA_DIR, "parity/cases_all.json"), "utf8")) as Cases;
  const tokenised = new Map<number, Candidate<number>>();
  const candidate = (id: number): Candidate<number> => {
    let c = tokenised.get(id);
    if (!c) {
      const [names, prominence] = cases.ents[id] ?? [[], 0];
      c = { id, prominence, names: names.map(nameTokens) satisfies NameTokens[] };
      tokenised.set(id, c);
    }
    return c;
  };
  const differences: string[] = [];
  for (const { q, cand, top } of cases.queries) {
    const ids = topK(queryTokens(q), cand.map(candidate)).map((c) => c.id);
    if (!same(ids, top))
      differences.push(`${JSON.stringify(q)}: ${ids.slice(0, 3)} vs ${top.slice(0, 3)}`);
  }
  return report("top 10", cases.queries.length, differences);
}

function checkCodes(zip: string, check: (code: string) => boolean, label: string): boolean {
  const csv = execFileSync("unzip", ["-p", join(DATA_DIR, "signals", zip)], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  const codes = csv
    .split("\n")
    .slice(1)
    .map((row) => row.trim().split(",")[1])
    .filter((code): code is string => !!code);
  const differences = codes.filter((code) => !check(code)).map((code) => `rejected ${code}`);
  return report(label, codes.length, differences, "pass");
}

const results = [
  await checkNames(),
  checkTopTen(),
  checkCodes("isin-lei.zip", isValidIsin, "ISINs"),
  checkCodes("bic-lei.zip", isValidBic, "BICs"),
];
process.exit(results.every(Boolean) ? 0 : 1);
