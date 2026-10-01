// After a deploy or a rollback: does the live index serve what it should?
//
//   pnpm --filter @whichlei/index verify-live --origin https://whichlei-index.lumenspring.workers.dev \
//     --build 20260916-3f9a1c0e [--also-build <previous>]
//   pnpm --filter @whichlei/index verify-live --origin … --not-build <build before the rollback>
//
//   --build       index.json must name this build (waits for it, see --wait)
//   --not-build   index.json must name another build
//   --also-build  a few files of this build must still be served: the one kept for open pages
//   --wait        seconds to wait for index.json to name the right build (default 120)
//   --markdown    append the table to this file (the job summary)
//
// Fetches index.json and a sample of files with compression on, and checks status, encoding,
// Cache-Control, CORS and nosniff. Prints bytes sent against raw bytes. Exits 1 on any failure.
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { httpsTransport, verifyLive, verifyTable } from "../src/verify.ts";

const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    build: { type: "string" },
    "not-build": { type: "string" },
    "also-build": { type: "string" },
    wait: { type: "string", default: "120" },
    markdown: { type: "string" },
  },
});
if (values.origin === undefined)
  throw new Error("usage: verify-live --origin <url> [--build id | --not-build id]");

const result = await verifyLive({
  origin: values.origin,
  transport: httpsTransport,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: console.log,
  waitSeconds: Number(values.wait),
  ...(values.build === undefined ? {} : { build: values.build }),
  ...(values["not-build"] === undefined ? {} : { notBuild: values["not-build"] }),
  ...(values["also-build"] === undefined ? {} : { alsoBuild: values["also-build"] }),
});
const table = verifyTable(result);
console.log(`live build: ${result.build ?? "unknown"}`);
console.log(table);
if (values.markdown !== undefined) {
  appendFileSync(
    values.markdown,
    `### Live index\n\nBuild \`${result.build ?? "unknown"}\`\n\n\`\`\`\n${table}\n\`\`\`\n\n`,
  );
}
if (!result.ok) {
  console.error("VERIFY FAILED");
  process.exit(1);
}
console.log("live index verified");
