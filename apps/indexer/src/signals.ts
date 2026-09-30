// What the relationship file and the ISIN and BIC mappings say about each LEI. Ports of
// research/ranking/signals/build_relationships.py and build_mappings.py, which the
// research wrote to TSV files; here they stay in memory, keyed by LEI.
import { columnsOf, parseCsvStream } from "./csv.ts";
import { unzipStream } from "./unzip.ts";

const DIRECT = "IS_DIRECTLY_CONSOLIDATED_BY";
const ULTIMATE = "IS_ULTIMATELY_CONSOLIDATED_BY";
const BRANCH = "IS_INTERNATIONAL_BRANCH_OF";

/** ACTIVE relationships in which an LEI is the parent (the end node). */
export interface ParentCounts {
  direct: number;
  ultimate: number;
  branch: number;
}

export interface Relationships {
  /** Per parent LEI. Fund-management, sub-fund and feeder links are not counted. */
  parents: Map<string, ParentCounts>;
  /** LEIs that report a direct or an ultimate accounting parent. */
  hasParent: Set<string>;
  /** ACTIVE rows read, of every type. */
  active: number;
  rows: number;
}

export async function readRelationships(zipPath: string): Promise<Relationships> {
  const parents = new Map<string, ParentCounts>();
  const hasParent = new Set<string>();
  let rows = 0;
  let active = 0;
  let c = { child: 0, parent: 0, type: 0, status: 0 };
  await parseCsvStream(
    unzipStream(zipPath),
    (row) => {
      rows++;
      if (row[c.status] !== "ACTIVE") return;
      active++;
      const type = row[c.type];
      if (type !== DIRECT && type !== ULTIMATE && type !== BRANCH) return;
      const parent = row[c.parent] as string;
      let counts = parents.get(parent);
      if (counts === undefined) {
        counts = { direct: 0, ultimate: 0, branch: 0 };
        parents.set(parent, counts);
      }
      if (type === DIRECT) counts.direct++;
      else if (type === ULTIMATE) counts.ultimate++;
      else counts.branch++;
      if (type !== BRANCH) hasParent.add(row[c.child] as string);
    },
    {
      onHeader: (header) => {
        const k = columnsOf(header, [
          "Relationship.StartNode.NodeID",
          "Relationship.EndNode.NodeID",
          "Relationship.RelationshipType",
          "Relationship.RelationshipStatus",
        ]);
        c = {
          child: k["Relationship.StartNode.NodeID"],
          parent: k["Relationship.EndNode.NodeID"],
          type: k["Relationship.RelationshipType"],
          status: k["Relationship.RelationshipStatus"],
        };
        return Object.values(c);
      },
    },
  );
  return { parents, hasParent, active, rows };
}

/** Number of ISIN rows per LEI. */
export async function readIsins(zipPath: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let lei = 0;
  await parseCsvStream(
    unzipStream(zipPath),
    (row) => {
      const key = row[lei] as string;
      if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    {
      onHeader: (header) => {
        const k = columnsOf(header, ["LEI", "ISIN"]);
        lei = k.LEI;
        return [k.LEI];
      },
    },
  );
  return counts;
}

/** LEIs that have a BIC. */
export async function readBics(zipPath: string): Promise<Set<string>> {
  const leis = new Set<string>();
  let lei = 0;
  await parseCsvStream(
    unzipStream(zipPath),
    (row) => {
      const key = row[lei] as string;
      if (key !== "") leis.add(key);
    },
    {
      onHeader: (header) => {
        const k = columnsOf(header, ["LEI", "BIC"]);
        lei = k.LEI;
        return [k.LEI];
      },
    },
  );
  return leis;
}
