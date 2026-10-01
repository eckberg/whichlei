import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { tinyFiles } from "./fixture.ts";
import { IMMUTABLE } from "./headers.ts";
import {
  type RawResponse,
  samplePaths,
  type Transport,
  verifyLive,
  verifyTable,
} from "./verify.ts";

const NEW = "20260917-aaaaaaaa";
const OLD = "20260916-3f9a1c0e";
const ORIGIN = "https://index.test";

const good = (content: string, cache: string, encoding = "gzip"): RawResponse => ({
  status: 200,
  headers: {
    "content-encoding": encoding,
    "cache-control": cache,
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  },
  body:
    encoding === "br"
      ? brotliCompressSync(content)
      : encoding === "gzip"
        ? gzipSync(content)
        : Buffer.from(content),
});

/** A live Worker serving tiny builds, with the headers the _headers file promises. */
function site(
  builds: string[],
  over: (path: string) => RawResponse | undefined = () => undefined,
): Transport {
  const [current] = builds;
  const files = new Map<string, RawResponse>();
  for (const build of builds) {
    for (const { path, content } of tinyFiles({
      build,
      asOf: `${build.slice(0, 4)}-${build.slice(4, 6)}-${build.slice(6, 8)}`,
    })) {
      if (path === "index.json") {
        if (build === current) files.set(path, good(content, "no-cache", "gzip"));
      } else files.set(path, good(content, IMMUTABLE));
    }
    files.set(`${build}/report.json`, good("{}", IMMUTABLE));
  }
  return async (url) => {
    const path = new URL(url).pathname.slice(1);
    return (
      over(path) ?? files.get(path) ?? { status: 404, headers: {}, body: Buffer.from("not found") }
    );
  };
}

const options = (transport: Transport, more: object = {}) => ({
  origin: ORIGIN,
  transport,
  sleep: async () => {},
  log: () => {},
  ...more,
});

describe("verifyLive", () => {
  test("a good publish passes: index.json names the build, files arrive compressed with the right headers", async () => {
    const result = await verifyLive(options(site([NEW, OLD]), { build: NEW, alsoBuild: OLD }));
    expect(result.ok).toBe(true);
    expect(result.build).toBe(NEW);
    expect(result.rows.map((r) => r.path)).toEqual([
      "index.json",
      `${NEW}/0.txt`,
      `${NEW}/1.txt`,
      `${NEW}/codes.json`,
      `${NEW}/report.json`,
      `${OLD}/0.txt`,
      `${OLD}/codes.json`,
    ]);
  });

  test("it counts bytes on the wire against decoded bytes", async () => {
    const result = await verifyLive(options(site([NEW]), { build: NEW }));
    const row = result.rows.find((r) => r.path === `${NEW}/0.txt`);
    expect(row?.encoding).toBe("gzip");
    expect(row?.raw).toBe(tinyFiles({ build: NEW, asOf: "2026-09-17" })[1]?.content.length);
    expect(row?.transferred).toBe(
      gzipSync(tinyFiles({ build: NEW, asOf: "2026-09-17" })[1]?.content as string).length,
    );
    expect(verifyTable(result)).toMatch(/total: [\d,]+ B sent for [\d,]+ B raw/);
  });

  test("br is as good as gzip", async () => {
    const transport: Transport = async (url) => {
      const path = new URL(url).pathname.slice(1);
      const found = tinyFiles({ build: NEW, asOf: "2026-09-17" }).find((f) => f.path === path);
      if (found === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      return good(found.content, path === "index.json" ? "no-cache" : IMMUTABLE, "br");
    };
    const result = await verifyLive(options(transport, { build: NEW }));
    expect(result.rows.filter((r) => r.path !== `${NEW}/report.json`).every((r) => r.ok)).toBe(
      true,
    );
    expect(result.rows.find((r) => r.path === `${NEW}/report.json`)?.detail).toContain("HTTP 404");
  });

  test("an uncompressed file fails", async () => {
    const result = await verifyLive(
      options(
        site([NEW], (path) =>
          path === `${NEW}/1.txt`
            ? good(
                tinyFiles({ build: NEW, asOf: "2026-09-17" })[2]?.content as string,
                IMMUTABLE,
                "identity",
              )
            : undefined,
        ),
        { build: NEW },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.rows.filter((r) => !r.ok).map((r) => [r.path, r.detail])).toEqual([
      [`${NEW}/1.txt`, "content-encoding identity, not gzip or br"],
    ]);
  });

  test("wrong Cache-Control, CORS or nosniff fail", async () => {
    const headersOf = (patch: Record<string, string>) =>
      site([NEW], (path) => {
        if (path !== `${NEW}/0.txt`) return undefined;
        const base = good(
          tinyFiles({ build: NEW, asOf: "2026-09-17" })[1]?.content as string,
          IMMUTABLE,
        );
        return { ...base, headers: { ...base.headers, ...patch } };
      });
    for (const [patch, expected] of [
      [{ "cache-control": "public, max-age=3600" }, /cache-control/],
      [{ "access-control-allow-origin": "https://other.test" }, /access-control-allow-origin/],
      [{ "x-content-type-options": "" }, /x-content-type-options/],
    ] as const) {
      const result = await verifyLive(options(headersOf(patch), { build: NEW }));
      expect(result.ok).toBe(false);
      expect(result.rows.find((r) => !r.ok)?.detail).toMatch(expected);
    }
  });

  test("index.json must be revalidated on every load", async () => {
    const transport = site([NEW], (path) =>
      path === "index.json"
        ? good(tinyFiles({ build: NEW, asOf: "2026-09-17" })[0]?.content as string, IMMUTABLE)
        : undefined,
    );
    const result = await verifyLive(options(transport, { build: NEW }));
    expect(result.rows[0]).toMatchObject({ path: "index.json", ok: false });
  });

  test("a body that does not decode fails", async () => {
    const result = await verifyLive(
      options(
        site([NEW], (path) =>
          path === `${NEW}/0.txt` ? good("not\ta\tfile\n", IMMUTABLE) : undefined,
        ),
        { build: NEW },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.rows.find((r) => !r.ok)?.detail).toMatch(/body:/);
  });

  test("the kept build must still be served", async () => {
    const result = await verifyLive(options(site([NEW]), { build: NEW, alsoBuild: OLD }));
    expect(result.ok).toBe(false);
    expect(result.rows.filter((r) => !r.ok).map((r) => r.path)).toEqual([
      `${OLD}/0.txt`,
      `${OLD}/codes.json`,
    ]);
  });

  test("it waits for index.json to name the new build, then passes", async () => {
    let clock = 0;
    let calls = 0;
    const inner = site([NEW]);
    const older = site([OLD]);
    const transport: Transport = (url) =>
      new URL(url).pathname === "/index.json" && ++calls <= 2 ? older(url) : inner(url);
    const result = await verifyLive(
      options(transport, {
        build: NEW,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(clock).toBe(10_000);
  });

  test("it gives up when index.json never names it", async () => {
    let clock = 0;
    const result = await verifyLive(
      options(site([OLD]), {
        build: NEW,
        waitSeconds: 30,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.detail).toContain(`names ${OLD}, expected ${NEW}`);
  });

  test("after a rollback, index.json must name another build", async () => {
    const rolledBack = await verifyLive(options(site([OLD, NEW]), { notBuild: NEW }));
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.build).toBe(OLD);
    let clock = 0;
    const same = await verifyLive(
      options(site([NEW]), {
        notBuild: NEW,
        waitSeconds: 10,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      }),
    );
    expect(same.ok).toBe(false);
    expect(same.rows[0]?.detail).toContain("still names");
  });

  test("a transport error is a failed check, not a crash", async () => {
    const transport = site([NEW], (path) => {
      if (path === `${NEW}/1.txt`) throw new Error("socket hang up");
      return undefined;
    });
    const result = await verifyLive(options(transport, { build: NEW }));
    expect(result.ok).toBe(false);
    expect(result.rows.find((r) => !r.ok)?.detail).toBe("socket hang up");
  });
});

describe("samplePaths", () => {
  test("both ends, the quarters, codes and report, no duplicates", () => {
    expect(samplePaths("b", 6438)).toEqual([
      "b/0.txt",
      "b/1609.txt",
      "b/3219.txt",
      "b/4828.txt",
      "b/6437.txt",
      "b/codes.json",
      "b/report.json",
    ]);
    expect(samplePaths("b", 1)).toEqual(["b/0.txt", "b/codes.json", "b/report.json"]);
  });
});
