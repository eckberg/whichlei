// Inputs and outputs of the index-format measurements. Nothing here is committed:
// the reference index comes from research/ranking/port/dump_index.py.
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Entry, Status } from "@whichlei/core";
import { REPO } from "../src/evaluation.ts";

export const DATA_DIR = process.env.DATA_DIR ?? join(REPO, "research/data");
/** The reference index, from dump_index.py. */
export const DUMP_DIR = join(DATA_DIR, "index");
/** Built encodings and measurement results. */
export const OUT_DIR = join(DATA_DIR, "format");

/** An entity of the reference index, with its full-precision prominence. */
export interface RefEntity {
  id: number;
  entry: Entry;
  /** Prominence at full precision, as the reference computed it. */
  p: number;
  /** Years since LEI registration. */
  age: number;
}

export interface RefFile {
  bound: string;
  capped: boolean;
  /** Entity ids in file order: prominence descending, id ascending. */
  ids: number[];
}

async function* lines(path: string): AsyncGenerator<string> {
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    if (line !== "") yield line;
  }
}

export async function loadEntities(): Promise<Map<number, RefEntity>> {
  const out = new Map<number, RefEntity>();
  for await (const line of lines(join(DUMP_DIR, "entities.tsv"))) {
    const [id, lei, country, status, p, age, name, ...otherNames] = line.split("\t");
    if (name === undefined) throw new Error(`bad entity line ${line}`);
    const prominence = Number(p);
    out.set(Number(id), {
      id: Number(id),
      p: prominence,
      age: Number(age),
      entry: {
        lei: lei ?? "",
        name,
        otherNames,
        country: country ?? "",
        status: status as Status,
        prominence,
      },
    });
  }
  return out;
}

export function loadFiles(): RefFile[] {
  return readFileSync(join(DUMP_DIR, "files.tsv"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [bound = "", capped, ids = ""] = line.split("\t");
      return { bound, capped: capped === "1", ids: ids === "" ? [] : ids.split(" ").map(Number) };
    });
}
