// Assemble the directory the Worker serves, `publish`.
//
//   pnpm --filter @whichlei/index assemble --build ../indexer/dist --out publish \
//     --live https://index.whichlei.com
//
//   --build  the indexer's output directory, after `checks` passed
//   --out    the directory to fill (default publish). Emptied first.
//   --live   origin of the live index. Its build is downloaded and kept, so a page that
//            loaded the old index.json keeps working. Without it: a first publish.
//   --concurrency  parallel downloads (default 16)
import { parseArgs } from "node:util";
import { assemble } from "../src/assemble.ts";
import { realHttp } from "../src/live.ts";

const { values } = parseArgs({
  options: {
    build: { type: "string" },
    out: { type: "string", default: "publish" },
    live: { type: "string" },
    concurrency: { type: "string", default: "16" },
  },
});
if (values.build === undefined)
  throw new Error("usage: assemble --build <dir> [--out dir] [--live origin]");

const started = Date.now();
const http = realHttp((message) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`),
);
const result = await assemble({
  build: values.build,
  out: values.out as string,
  http,
  concurrency: Number(values.concurrency),
  ...(values.live === undefined ? {} : { live: values.live }),
});
console.log(
  `assembled ${values.out}: ${result.files.toLocaleString()} files, ${(result.bytes / 1e6).toFixed(1)} MB,` +
    ` builds ${result.builds.join(" + ")}, ${result.downloaded.toLocaleString()} downloaded`,
);
