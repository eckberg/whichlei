// Print the build the live index.json names, or nothing if there is no live index.
//
//   pnpm --silent --filter @whichlei/index live-build --origin https://whichlei-index.lumenspring.workers.dev
//
// A network fault exits 1: it is never taken for "no live index".
import { parseArgs } from "node:util";
import { liveManifest, realHttp } from "../src/live.ts";

const { values } = parseArgs({ options: { origin: { type: "string" } } });
if (values.origin === undefined) throw new Error("usage: live-build --origin <url>");
const manifest = await liveManifest(realHttp(console.error), values.origin);
if (manifest !== undefined) console.log(manifest.build);
