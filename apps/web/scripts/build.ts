// Build the site into dist/. The home page is the design prototype (design/prototype), which
// searches a fixed sample of 2,924 records in the browser. Slice 7 replaces it. The record
// pages (src/worker.ts) link two static files built here: styles/record.css and
// scripts/copy.js.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const prototype = new URL("../../../design/prototype/", import.meta.url);
const statics = new URL("../static/", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, prototype), "utf8");

// Same assembly as design/prototype/build.py, plus doctype, charset, language and viewport.
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whichlei</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Mono:wght@400;500;700&display=swap">
<style>
${read("shared.css")}
${read("page.css")}
</style>
</head>
<body>
${read("body.html")}
<script>
${read("data.js")}
</script>
<script>
${read("scorer.js")}
</script>
<script>
${read("app.js")}
</script>
</body>
</html>
`;

const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: interest-cohort=()
`;

const notFound = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>not found · whichlei</title>
<p>Not found. <a href="/">Search</a></p>
</html>
`;

// The record pages share the prototype's theme and record view (shared.css), so the look
// stays one thing. Fonts are linked from the page, as in the prototype.
const recordCss = `${read("shared.css")}\n${readFileSync(new URL("record.css", statics), "utf8")}`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(new URL("styles/", dist), { recursive: true });
mkdirSync(new URL("scripts/", dist), { recursive: true });
writeFileSync(new URL("styles/record.css", dist), recordCss);
writeFileSync(new URL("scripts/copy.js", dist), readFileSync(new URL("copy.js", statics), "utf8"));
writeFileSync(new URL("index.html", dist), page);
writeFileSync(new URL("404.html", dist), notFound);
writeFileSync(new URL("_headers", dist), headers);
console.log(`dist/index.html ${Buffer.byteLength(page).toLocaleString("en-US")} bytes`);
