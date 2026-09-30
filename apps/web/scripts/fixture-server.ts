// Serve the fixture index on a local port, with CORS, the way the index Worker will: the page
// is on another origin. Builds the fixture first (scripts/fixture-index.ts).
//
//   node scripts/fixture-server.ts [port]        default 8788
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { buildFixture, FIXTURE_DIR, loadPrototype, writeFixture } from "./fixture-index.ts";

const port = Number(process.argv[2] ?? process.env.FIXTURE_PORT ?? 8788);
const fixture = buildFixture(loadPrototype());
writeFixture(FIXTURE_DIR, fixture);
const root = fileURLToPath(FIXTURE_DIR);

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://x").pathname;
  const cors = { "access-control-allow-origin": "*" };
  if (request.method === "OPTIONS") {
    response.writeHead(204, { ...cors, "access-control-allow-headers": "*" }).end();
    return;
  }
  // Only what the fixture holds: index.json and <build>/<n>.txt.
  if (!/^\/(index\.json|[\w-]+\/\d+\.txt)$/.test(path)) {
    response.writeHead(404, cors).end("not found");
    return;
  }
  try {
    const file = `${root}${path.slice(1)}`;
    statSync(file);
    const manifest = path === "/index.json";
    response
      .writeHead(200, {
        ...cors,
        "content-type": manifest ? "application/json" : "text/plain; charset=utf-8",
        "cache-control": manifest ? "no-cache" : "public, max-age=31536000, immutable",
      })
      .end(readFileSync(file));
  } catch {
    response.writeHead(404, cors).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `fixture index: ${fixture.manifest.entities} entities in ${fixture.files.size} files on http://127.0.0.1:${port}`,
  );
});
