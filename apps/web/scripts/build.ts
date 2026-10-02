// Build the site into dist/: the search page, the styles and script it and the record pages
// (src/worker.ts) link, the fonts, and the headers for static files.
//
//   INDEX_ORIGIN=https://index.example pnpm build        [DIST_DIR=/elsewhere]
//
// INDEX_ORIGIN is where the published index is served from (slice 6 sets the real one). Empty:
// the page says so and searches nothing. It goes into the bundle and into the CSP.
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { canonicalOrigin, indexOrigin, pageCsp, searchPage } from "./site.ts";

const statics = new URL("../static/", import.meta.url);
// DIST_DIR builds somewhere else, as tools/bench does for its copy of the site.
const dist = process.env.DIST_DIR
  ? pathToFileURL(`${resolve(process.env.DIST_DIR)}/`)
  : new URL("../dist/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, statics), "utf8");
const write = (name: string, content: string) => writeFileSync(new URL(name, dist), content);

const origin = indexOrigin(process.env.INDEX_ORIGIN);
// The site's own origin, from the one place that sets it.
const canonical = canonicalOrigin(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);

rmSync(dist, { recursive: true, force: true });
mkdirSync(new URL("styles/", dist), { recursive: true });
mkdirSync(new URL("scripts/", dist), { recursive: true });
cpSync(new URL("fonts/", statics), new URL("fonts/", dist), { recursive: true });

// The page and the search worker, each one file with a source map. No inline script or style
// anywhere: the CSP forbids both. The worker is a module worker (`worker-src 'self'`).
const common = {
  bundle: true,
  target: "es2024",
  minify: true,
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "warning",
} as const;
await build({
  ...common,
  entryPoints: [new URL("../src/page/index.ts", import.meta.url).pathname],
  outfile: new URL("app.js", dist).pathname,
  format: "iife",
  define: { __INDEX_ORIGIN__: JSON.stringify(origin) },
});
await build({
  ...common,
  entryPoints: [new URL("../src/page/worker.ts", import.meta.url).pathname],
  outfile: new URL("search-worker.js", dist).pathname,
  format: "esm",
});

// The analytics loader (/scripts/stats.js), a file of its own: no inline script. It does
// nothing unless the page is on the canonical origin.
await build({
  ...common,
  entryPoints: [new URL("../src/page/stats-entry.ts", import.meta.url).pathname],
  outfile: new URL("scripts/stats.js", dist).pathname,
  format: "iife",
  define: { __CANONICAL_ORIGIN__: JSON.stringify(canonical) },
});

// The search page and the record pages share the fonts and the theme; each adds its own.
const base = `${read("fonts.css")}\n${read("shared.css")}`;
write("styles/app.css", `${base}\n${read("search.css")}`);
write("styles/record.css", `${base}\n${read("record.css")}`);
copyFileSync(new URL("copy.js", statics), new URL("scripts/copy.js", dist));
write("index.html", searchPage(read("index.html"), canonical));
write(
  "404.html",
  `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>not found · whichlei</title>
<p>Not found. <a href="/">Search</a></p>
</html>
`,
);
write(
  "_headers",
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: interest-cohort=()
  Content-Security-Policy: ${pageCsp(origin)}
`,
);

const size = (name: string) => readFileSync(new URL(name, dist)).length.toLocaleString("en-US");
console.log(
  `dist: app.js ${size("app.js")} bytes, search-worker.js ${size("search-worker.js")} bytes, app.css ${size("styles/app.css")} bytes; index ${origin || "not configured"}; canonical ${canonical || "not set"}`,
);
