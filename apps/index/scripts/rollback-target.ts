// Which Worker version a rollback goes to, as JSON: {"id": "<version id>", "build": "<build>"}.
//
//   wrangler versions list --json > versions.json
//   node scripts/rollback-target.ts --versions versions.json --live <live build> [--version-id <id>]
//
// Without --version-id: the newest build older than the live one. Exits 1 with the reason
// if there is none. See src/rollback.ts.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pickRollbackTarget, type WorkerVersion } from "../src/rollback.ts";

const { values } = parseArgs({
  options: {
    versions: { type: "string" },
    live: { type: "string" },
    "version-id": { type: "string" },
  },
});
if (values.versions === undefined || values.live === undefined) {
  throw new Error("usage: rollback-target --versions <file> --live <build> [--version-id <id>]");
}
const versions = JSON.parse(readFileSync(values.versions, "utf8")) as WorkerVersion[];
const id = values["version-id"];
const target = pickRollbackTarget(versions, values.live, id === "" ? undefined : id);
if ("error" in target) {
  console.error(`::error::no rollback target: ${target.error}`);
  process.exit(1);
}
console.log(JSON.stringify(target));
