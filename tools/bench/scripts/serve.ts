// The static server the browser harnesses use: the repository (TypeScript stripped of types)
// and $DATA_DIR/format under /data/. With `site`, also a built site (apps/web/dist) at /, and
// one encoding of the index at the root (/index.json, /<build>/<n>.txt), so the production
// page reads the full index from its own origin.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { REPO } from "../src/evaluation.ts";
import { OUT_DIR } from "./data.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServeOptions {
  site?: { dist: string; encoding: string };
  port?: number;
}

const isFile = (file: string) => existsSync(file) && statSync(file).isFile();

export async function serve({ site, port = 0 }: ServeOptions = {}) {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    let file: string;
    if (site && (path === "/index.json" || /^\/[\w-]+\/\d+\.txt$/.test(path))) {
      file = join(OUT_DIR, site.encoding, path);
    } else if (site) {
      file = join(site.dist, path === "/" ? "index.html" : path);
    } else {
      file = path.startsWith("/data/") ? join(OUT_DIR, path.slice(6)) : join(REPO, path);
    }
    if (!isFile(file)) {
      res.writeHead(404).end();
      return;
    }
    const ext = extname(file);
    let body: Buffer | string = readFileSync(file);
    if (ext === ".ts") body = stripTypeScriptTypes(body.toString("utf8"));
    res
      .writeHead(200, {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "access-control-allow-origin": "*",
      })
      .end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => server.close() };
}
