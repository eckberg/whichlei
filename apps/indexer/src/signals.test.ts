import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { csvLine, type Relation, rrCsv, zipOf } from "./fixture.ts";
import { readBics, readIsins, readRelationships } from "./signals.ts";

const dir = mkdtempSync(join(tmpdir(), "whichlei-signals-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const P = "PARENT00000000000001";
const Q = "PARENT00000000000002";
const child = (n: number) => `CHILD${String(n).padStart(15, "0")}`;

describe("relationships", () => {
  const relations: Relation[] = [
    [child(1), P, "IS_DIRECTLY_CONSOLIDATED_BY"],
    [child(2), P, "IS_DIRECTLY_CONSOLIDATED_BY"],
    [child(3), P, "IS_ULTIMATELY_CONSOLIDATED_BY"],
    // Not ACTIVE: counts for nothing.
    [child(4), P, "IS_DIRECTLY_CONSOLIDATED_BY", "INACTIVE"],
    [child(5), P, "IS_ULTIMATELY_CONSOLIDATED_BY", "INACTIVE"],
    // A branch counts as a branch of the parent; the branch has no parent in this sense.
    [child(6), P, "IS_INTERNATIONAL_BRANCH_OF"],
    [child(7), P, "IS_INTERNATIONAL_BRANCH_OF"],
    // Fund management, sub-funds and feeders are not consolidation.
    [child(8), P, "IS_FUND-MANAGED_BY"],
    [child(9), P, "IS_SUBFUND_OF"],
    [child(10), P, "IS_FEEDER_TO"],
    [child(11), Q, "IS_ULTIMATELY_CONSOLIDATED_BY"],
  ];
  const path = join(dir, "rr.zip");
  writeFileSync(path, zipOf("rr.csv", rrCsv(relations)));

  test("counts ACTIVE consolidation and branch links per parent", async () => {
    const { parents, active, rows } = await readRelationships(path);
    expect(parents.get(P)).toEqual({ direct: 2, ultimate: 1, branch: 2 });
    expect(parents.get(Q)).toEqual({ direct: 0, ultimate: 1, branch: 0 });
    // Only the parents of counted links are listed.
    expect([...parents.keys()].sort()).toEqual([P, Q]);
    expect(rows).toBe(11);
    expect(active).toBe(9);
  });

  test("a child has a parent if a direct or ultimate link is ACTIVE", async () => {
    const { hasParent } = await readRelationships(path);
    expect([...hasParent].sort()).toEqual([child(1), child(2), child(3), child(11)].sort());
    for (const n of [4, 5, 6, 7, 8, 9, 10]) expect(hasParent.has(child(n))).toBe(false);
  });
});

describe("mapping files", () => {
  test("ISINs are counted per LEI, not flagged", async () => {
    const path = join(dir, "isin.zip");
    const rows = [P, P, P, Q].map((lei, i) => csvLine([lei, `XS${i}`])).join("");
    writeFileSync(path, zipOf("isin.csv", csvLine(["LEI", "ISIN"]) + rows + csvLine(["", "XS9"])));
    const counts = await readIsins(path);
    expect(counts.get(P)).toBe(3);
    expect(counts.get(Q)).toBe(1);
    expect(counts.size).toBe(2);
  });

  test("a BIC is a flag: an LEI with two is in the set once", async () => {
    const path = join(dir, "bic.zip");
    const rows = [P, P, Q].map((lei) => csvLine([lei, "ABCDSESSXXX"])).join("");
    writeFileSync(path, zipOf("bic.csv", csvLine(["LEI", "BIC"]) + rows));
    expect([...(await readBics(path))].sort()).toEqual([P, Q]);
  });

  test("a changed header is an error", async () => {
    const path = join(dir, "other.zip");
    writeFileSync(path, zipOf("x.csv", csvLine(["Lei", "Isin"]) + csvLine([P, "XS1"])));
    await expect(readIsins(path)).rejects.toThrow(/column "LEI" is missing/);
  });
});
