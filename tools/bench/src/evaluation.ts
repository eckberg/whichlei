// The evaluation set and its objective, shared by the bench scripts and the indexer's check.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export interface EvalQuery {
  query: string;
  split: "train" | "test";
  stratum: string;
  /** The target LEI and every alternative LEI that counts as correct. */
  targets: Set<string>;
}

function readSet(file: string, stratumOf: (file: string, qtype: string) => string): EvalQuery[] {
  const out: EvalQuery[] = [];
  const [header, ...rows] = readFileSync(join(REPO, `research/ranking/eval/${file}.tsv`), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const columns = (header ?? "").split("\t");
  for (const row of rows) {
    const d = Object.fromEntries(row.split("\t").map((v, i) => [columns[i], v]));
    out.push({
      query: d.query ?? "",
      split: d.split === "test" ? "test" : "train",
      stratum: stratumOf(file, d.qtype ?? ""),
      targets: new Set([d.target_lei ?? "", ...(d.alt_leis ?? "").split("|").filter(Boolean)]),
    });
  }
  return out;
}

/** The evaluation set, one row per query and stratum, as evaluate.load_eval reads it. */
export function loadEval(): EvalQuery[] {
  return ["head", "torso", "tail", "typo"].flatMap((file) =>
    readSet(file, (f, qtype) =>
      f === "head" ? `head_${qtype}` : f === "typo" ? (qtype.split(":")[0] ?? "") : f,
    ),
  );
}

/**
 * Well-known acronyms and short names with verified targets (research/ranking/
 * build_acronyms.py), stratum "acronym". Not part of the objective.
 */
export function loadAcronyms(): EvalQuery[] {
  return readSet("acronyms", () => "acronym");
}

/** Median, 90th percentile (numpy's linear interpolation) and maximum. */
export function summary(values: number[]): { median: number; p90: number; max: number } {
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const x = (v.length - 1) * q;
    const lo = Math.floor(x);
    const hi = Math.ceil(x);
    return (v[lo] ?? 0) + ((v[hi] ?? 0) - (v[lo] ?? 0)) * (x - lo);
  };
  return { median: at(0.5), p90: at(0.9), max: v[v.length - 1] ?? 0 };
}

export const STRATA = ["head_label", "head_alias", "torso", "tail", "typo_first3", "typo_later"];

/**
 * Mean over the six strata of MRR@10, as evaluate.objective. `top` maps a query to the LEIs
 * of its top 10, best first.
 */
export function objective(queries: EvalQuery[], top: Map<string, string[]>): number {
  const mrr = STRATA.map((stratum) => {
    const rs = queries.filter((r) => r.stratum === stratum);
    const sum = rs.reduce((a, r) => {
      const rank = (top.get(r.query) ?? []).findIndex((lei) => r.targets.has(lei));
      return a + (rank < 0 ? 0 : 1 / (rank + 1));
    }, 0);
    return sum / rs.length;
  });
  return mrr.reduce((a, b) => a + b, 0) / mrr.length;
}
