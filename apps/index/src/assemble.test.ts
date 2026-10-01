import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assemble } from "./assemble.ts";
import { FILES, tinyFiles, writeTinyBuild } from "./fixture.ts";
import type { Fetch, Http } from "./live.ts";
import type { Measured } from "./report.ts";

const NEW = "20260917-aaaaaaaa";
const OLD = "20260916-3f9a1c0e";
const ORIGIN = "https://index.test";

let root: string;
let built: string;
let out: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "index-assemble-"));
  built = join(root, "indexer");
  out = join(root, "publish");
  writeTinyBuild(built, { build: NEW, asOf: "2026-09-17" });
  writeMeasured(true);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeMeasured(passed: boolean, build = NEW) {
  const measured: Measured = passed
    ? ({
        passed,
        report: { build, asOf: "2026-09-17", entities: 3, files: 2 },
      } as unknown as Measured)
    : ({ passed } as Measured);
  writeFileSync(join(built, "measured.json"), JSON.stringify(measured));
}

/** What the live Worker serves: path to body or status. */
type Site = Map<string, string | number>;

function liveSite(build = OLD, over: Record<string, string | number> = {}): Site {
  const site: Site = new Map();
  for (const { path, content } of tinyFiles({
    build,
    asOf: `${build.slice(0, 4)}-${build.slice(4, 6)}-${build.slice(6, 8)}`,
  })) {
    site.set(path, content);
  }
  site.set(`${build}/report.json`, JSON.stringify({ build }));
  for (const [path, value] of Object.entries(over)) site.set(path, value);
  return site;
}

interface Fake {
  http: Http;
  requests: string[];
  logs: string[];
}

function fake(
  site: Site,
  behaviour: (path: string, attempt: number) => Response | undefined = () => undefined,
): Fake {
  const requests: string[] = [];
  const logs: string[] = [];
  const attempts = new Map<string, number>();
  const fakeFetch: Fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    const path = url.pathname.slice(1);
    const attempt = (attempts.get(path) ?? 0) + 1;
    attempts.set(path, attempt);
    const special = behaviour(path, attempt);
    if (special !== undefined) return special;
    const value = site.get(path);
    if (value === undefined) return new Response("not found", { status: 404 });
    if (typeof value === "number") return new Response("", { status: value });
    return new Response(value);
  };
  return {
    http: { fetch: fakeFetch, sleep: async () => {}, log: (m) => logs.push(m) },
    requests,
    logs,
  };
}

const listing = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();

describe("first publish", () => {
  test("a 404 for index.json means no live index: only the new build is assembled", async () => {
    const { http, requests } = fake(new Map());
    const result = await assemble({ build: built, out, live: ORIGIN, http });
    expect(requests).toEqual(["/index.json"]);
    expect(result).toMatchObject({ builds: [NEW], previous: undefined, downloaded: 0, files: 5 });
    expect(listing(out)).toEqual(
      [
        "_headers",
        "index.json",
        `${NEW}/0.txt`,
        `${NEW}/1.txt`,
        `${NEW}/codes.json`,
        `${NEW}/report.json`,
      ].sort(),
    );
  });

  test("without --live nothing is fetched", async () => {
    const { http, requests } = fake(liveSite());
    const result = await assemble({ build: built, out, http });
    expect(requests).toEqual([]);
    expect(result.builds).toEqual([NEW]);
  });

  test("what is published: the build's files, the new manifest, the report, the headers", async () => {
    const { http } = fake(new Map());
    await assemble({ build: built, out, live: ORIGIN, http });
    expect(readFileSync(join(out, "index.json"), "utf8")).toBe(
      readFileSync(join(built, "index.json"), "utf8"),
    );
    expect(JSON.parse(readFileSync(join(out, NEW, "report.json"), "utf8"))).toMatchObject({
      build: NEW,
      entities: 3,
    });
    expect(readFileSync(join(out, NEW, "0.txt"), "utf8")).toBe(
      readFileSync(join(built, NEW, "0.txt"), "utf8"),
    );
    expect(existsSync(join(out, "build.json"))).toBe(false);
    expect(existsSync(join(out, "measured.json"))).toBe(false);
    expect(readFileSync(join(out, "_headers"), "utf8")).toContain(`/${NEW}/*`);
  });
});

describe("a normal publish", () => {
  test("keeps the live build: its files are downloaded and verified", async () => {
    const site = liveSite();
    const { http, requests } = fake(site);
    const result = await assemble({ build: built, out, live: ORIGIN, http });
    expect(result).toMatchObject({ builds: [NEW, OLD], previous: OLD, downloaded: 4 });
    expect(requests.sort()).toEqual(
      [
        "/index.json",
        `/${OLD}/0.txt`,
        `/${OLD}/1.txt`,
        `/${OLD}/codes.json`,
        `/${OLD}/report.json`,
      ].sort(),
    );
    expect(result.files).toBe(9);
    for (const name of ["0.txt", "1.txt", "codes.json", "report.json"]) {
      expect(readFileSync(join(out, OLD, name), "utf8")).toBe(site.get(`${OLD}/${name}`));
    }
    // index.json is the new one.
    expect(JSON.parse(readFileSync(join(out, "index.json"), "utf8")).build).toBe(NEW);
    const headers = readFileSync(join(out, "_headers"), "utf8");
    expect(headers).toContain(`/${NEW}/*`);
    expect(headers).toContain(`/${OLD}/*`);
  });

  test("a build published before reports existed has no report.json: fine", async () => {
    const site = liveSite(OLD);
    site.delete(`${OLD}/report.json`);
    const { http } = fake(site);
    const result = await assemble({ build: built, out, live: ORIGIN, http });
    expect(result.downloaded).toBe(3);
    expect(existsSync(join(out, OLD, "report.json"))).toBe(false);
  });

  test("a download that fails once is retried", async () => {
    const { http } = fake(liveSite(), (path, attempt) =>
      path === `${OLD}/1.txt` && attempt < 3 ? new Response("", { status: 503 }) : undefined,
    );
    const result = await assemble({ build: built, out, live: ORIGIN, http });
    expect(result.downloaded).toBe(4);
  });

  test("a corrupted download is fetched again, and if it stays corrupt nothing is assembled", async () => {
    const corrupt = "ABC\tnot a file\n";
    // Corrupt once: the second download is good.
    const once = fake(liveSite(), (path, attempt) =>
      path === `${OLD}/1.txt` && attempt === 1 ? new Response(corrupt) : undefined,
    );
    await expect(
      assemble({ build: built, out, live: ORIGIN, http: once.http }),
    ).resolves.toMatchObject({ downloaded: 4 });

    const always = fake(liveSite(OLD, { [`${OLD}/1.txt`]: corrupt }));
    await expect(assemble({ build: built, out, live: ORIGIN, http: always.http })).rejects.toThrow(
      new RegExp(`${OLD}/1.txt is corrupt after 3 downloads`),
    );
  });

  test("a truncated index file is corrupt", async () => {
    const whole = tinyFiles({ build: OLD, asOf: "2026-09-16" }).find(
      (f) => f.path === `${OLD}/0.txt`,
    )?.content as string;
    const { http } = fake(liveSite(OLD, { [`${OLD}/0.txt`]: whole.slice(0, whole.length - 4) }));
    await expect(assemble({ build: built, out, live: ORIGIN, http })).rejects.toThrow(/corrupt/);
  });

  test("a file the live manifest names but the Worker lacks fails the run", async () => {
    const site = liveSite();
    site.delete(`${OLD}/1.txt`);
    const { http } = fake(site);
    await expect(assemble({ build: built, out, live: ORIGIN, http })).rejects.toThrow(
      /1.txt: HTTP 404/,
    );
  });

  test("more files than the limit allows fail before any download", async () => {
    const { http, requests } = fake(liveSite());
    await expect(assemble({ build: built, out, live: ORIGIN, http, maxFiles: 8 })).rejects.toThrow(
      /limit is 8/,
    );
    expect(requests).toEqual(["/index.json"]);
  });

  test("the limit also holds for the whole version", async () => {
    const { http } = fake(liveSite());
    // 4 + 4 + index.json = 9 files: the version must stay below the limit.
    await expect(assemble({ build: built, out, live: ORIGIN, http, maxFiles: 9 })).rejects.toThrow(
      /limit is 9/,
    );
    await expect(
      assemble({ build: built, out, live: ORIGIN, http, maxFiles: 10 }),
    ).resolves.toMatchObject({ files: 9 });
  });

  test("the same build live again keeps nothing", async () => {
    const { http, requests } = fake(liveSite(NEW));
    const result = await assemble({ build: built, out, live: ORIGIN, http });
    expect(requests).toEqual(["/index.json"]);
    expect(result.builds).toEqual([NEW]);
  });

  test("an unreadable live index.json is a warning and a first publish", async () => {
    const { http, logs } = fake(liveSite(OLD, { "index.json": "{not json" }));
    const result = await assemble({ build: built, out, live: ORIGIN, http });
    expect(result.builds).toEqual([NEW]);
    expect(logs.join("\n")).toContain("::warning::");
  });

  test("a network error or a 500 for index.json is not a first publish", async () => {
    const down = fake(new Map(), () => {
      throw new TypeError("fetch failed");
    });
    await expect(assemble({ build: built, out, live: ORIGIN, http: down.http })).rejects.toThrow(
      /failed after 4 attempts/,
    );
    const broken = fake(new Map([["index.json", 500]]));
    await expect(assemble({ build: built, out, live: ORIGIN, http: broken.http })).rejects.toThrow(
      /HTTP 500/,
    );
    const forbidden = fake(new Map([["index.json", 403]]));
    await expect(
      assemble({ build: built, out, live: ORIGIN, http: forbidden.http }),
    ).rejects.toThrow(/HTTP 403/);
  });

  test("a stale output directory is emptied first", async () => {
    mkdirSync(join(out, "20200101-deadbeef"), { recursive: true });
    writeFileSync(join(out, "20200101-deadbeef", "0.txt"), "");
    const { http } = fake(new Map());
    await assemble({ build: built, out, live: ORIGIN, http });
    expect(existsSync(join(out, "20200101-deadbeef"))).toBe(false);
  });
});

describe("what it refuses", () => {
  test("a build whose checks did not pass", async () => {
    writeMeasured(false);
    const { http } = fake(new Map());
    await expect(assemble({ build: built, out, live: ORIGIN, http })).rejects.toThrow(
      /did not pass/,
    );
  });

  test("a measured.json from another build", async () => {
    writeMeasured(true, "20260101-cccccccc");
    const { http } = fake(new Map());
    await expect(assemble({ build: built, out, live: ORIGIN, http })).rejects.toThrow(
      /measured.json is for/,
    );
  });

  test("no measured.json at all", async () => {
    rmSync(join(built, "measured.json"));
    const { http } = fake(new Map());
    await expect(assemble({ build: built, out, live: ORIGIN, http })).rejects.toThrow(/ENOENT/);
  });

  test("an index file missing from the build", async () => {
    rmSync(join(built, NEW, "1.txt"));
    const { http } = fake(new Map());
    await expect(assemble({ build: built, out, live: ORIGIN, http })).rejects.toThrow(
      /1 files of .* are missing, such as 1.txt/,
    );
  });
});

test("the fixture's files are what the tests think", () => {
  expect(FILES).toHaveLength(2);
});
