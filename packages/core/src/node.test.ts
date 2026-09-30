// Node runs this package's TypeScript by stripping types (the bench and the indexer run
// scripts that way). Vitest transpiles instead, so it would not notice syntax Node cannot
// strip, such as parameter properties or enums. Load the package in plain Node.
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("loads in plain Node with type stripping", () => {
  const url = new URL("./index.ts", import.meta.url).href;
  const script = `const core = await import(${JSON.stringify(url)}); console.log(Object.keys(core).length);`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(Number(out.trim())).toBeGreaterThan(0);
});
