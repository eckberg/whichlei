import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { fixtureGolden, writeInputs, zipOf } from "./fixture.ts";
import {
  codeListLink,
  download,
  downloadInputs,
  ELF_PAGE,
  findMapping,
  type Http,
  localInputs,
  MAPPING_API,
  type MappingUpload,
  PUBLISHES_API,
  pickMapping,
  RA_PAGE,
  resolvePublish,
} from "./sources.ts";

const root = mkdtempSync(join(tmpdir(), "whichlei-sources-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Real zips, so the download's integrity test has something to test. */
const zipBody = (url: string) => zipOf("x.csv", `content of ${url}`);

const publish = (date: string) => ({
  publish_date: date,
  lei2: {
    full_file: {
      csv: {
        url: `https://files.example/lei2-${date.replace(" ", "T")}.zip`,
        record_count: 12,
        size: zipBody(`https://files.example/lei2-${date.replace(" ", "T")}.zip`).length,
      },
    },
  },
  rr: { full_file: { csv: { url: `https://files.example/rr-${date.replace(" ", "T")}.zip` } } },
});

const upload = (
  at: string,
  extra: { valid?: boolean; processed?: boolean } = {},
): MappingUpload => ({
  attributes: {
    fileName: `file-${at}.zip`,
    uploadedAt: at,
    downloadLink: `https://files.example/map-${at}.zip`,
    valid: true,
    processed: true,
    ...extra,
  },
});

const sleep = async () => {};
const quick: Http = { sleep, backoffMs: 0 };

/** GLEIF, as far as the downloader talks to it. Requests are recorded in `seen`. */
function gleif(seen: string[] = []): typeof fetch {
  const pages = [
    [
      publish("2026-09-17 16:00:00"),
      publish("2026-09-17 08:00:00"),
      publish("2026-09-16 16:00:00"),
    ],
    [publish("2026-09-16 08:00:00"), publish("2026-09-15 08:00:00")],
    [],
  ];
  const json = (body: unknown) => new Response(JSON.stringify(body));
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith(`${PUBLISHES_API}?page=`)) {
      return json({ data: pages[Number(url.split("=")[1]) - 1] ?? [] });
    }
    if (url.startsWith(`${MAPPING_API}/isin-lei`) || url.startsWith(`${MAPPING_API}/bic-lei`)) {
      // Newest first; the one from 2026-09-30 is after the golden copy.
      return json({
        data: [
          upload("2026-09-30T07:15:09Z"),
          upload("2026-09-16T07:15:10Z"),
          upload("2026-09-15T07:15:10Z"),
        ],
      });
    }
    if (url === ELF_PAGE) {
      return new Response(
        '<a href="https://www.gleif.org/x/other.csv">o</a><a href="https://www.gleif.org/x/2026-02-19-elf-code-list-v1.6.csv">elf</a>',
      );
    }
    if (url === RA_PAGE) {
      return new Response('<a href="https://www.gleif.org/x/2026-09-30_ra-list-v1.9.csv">ra</a>');
    }
    if (url.startsWith("https://files.example/")) return new Response(zipBody(url));
    if (url.startsWith("https://www.gleif.org/x/")) return new Response(`content of ${url}`);
    return new Response("not found", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;
}

describe("resolvePublish", () => {
  test("the latest is the first of the newest page", async () => {
    expect(await resolvePublish("latest", { fetch: gleif() })).toMatchObject({
      asOf: "2026-09-17",
      publishedAt: "2026-09-17T16:00:00Z",
      lei2: { url: "https://files.example/lei2-2026-09-17T16:00:00.zip" },
      records: 12,
    });
  });

  test("a date takes its 08:00 golden copy, paging back to it, with the size the API gives", async () => {
    const seen: string[] = [];
    const found = await resolvePublish("2026-09-16", { fetch: gleif(seen) });
    // Not the 16:00 copy of the same day.
    expect(found.lei2.url).toBe("https://files.example/lei2-2026-09-16T08:00:00.zip");
    expect(found.lei2.size).toBeGreaterThan(0);
    expect(found.rr).toEqual({ url: "https://files.example/rr-2026-09-16T08:00:00.zip" });
    expect(found.asOf).toBe("2026-09-16");
    expect(found.publishedAt).toBe("2026-09-16T08:00:00Z");
    // The 16:00 copy on page 1 is not the one; the 08:00 copy is on page 2.
    expect(seen).toHaveLength(2);
  });

  test("a date with no golden copy is an error", async () => {
    const seen: string[] = [];
    await expect(resolvePublish("2026-09-10", { fetch: gleif(seen) })).rejects.toThrow(
      /no golden copy/,
    );
    expect(seen).toHaveLength(3); // the third page is empty
    await expect(resolvePublish("yesterday", { fetch: gleif() })).rejects.toThrow(/not YYYY-MM-DD/);
  });
});

describe("mapping files", () => {
  // Uploads as GLEIF's API lists them (recorded 2026-09-30): newest first.
  const recorded: MappingUpload[] = [
    upload("2026-09-30T07:15:09Z"),
    upload("2026-09-29T07:15:10Z"),
    upload("2026-09-16T07:15:10Z", { processed: false }),
    upload("2026-09-15T07:15:09Z", { valid: false }),
    upload("2026-09-14T07:15:08Z"),
    upload("2026-09-13T07:15:08Z"),
  ];

  test("the newest valid, processed upload from before the golden copy", () => {
    // At 2026-09-16 08:00 the 09-16 upload is not processed and the 09-15 one is not valid.
    expect(pickMapping(recorded, "2026-09-16T08:00:00Z")?.attributes.uploadedAt).toBe(
      "2026-09-14T07:15:08Z",
    );
    expect(pickMapping(recorded, "2026-09-30T08:00:00Z")?.attributes.uploadedAt).toBe(
      "2026-09-30T07:15:09Z",
    );
    // An upload after the golden copy is never taken, even if it is the newest valid one.
    expect(pickMapping(recorded, "2026-09-29T07:15:09Z")?.attributes.uploadedAt).toBe(
      "2026-09-14T07:15:08Z",
    );
    expect(pickMapping(recorded, "2026-09-01T00:00:00Z")).toBeUndefined();
    // The order of the list does not matter.
    expect(
      pickMapping([...recorded].reverse(), "2026-09-16T08:00:00Z")?.attributes.uploadedAt,
    ).toBe("2026-09-14T07:15:08Z");
  });

  test("an upload with no valid or processed flag is not taken", () => {
    const bare = {
      attributes: { fileName: "f", uploadedAt: "2026-09-01T00:00:00Z", downloadLink: "u" },
    };
    expect(pickMapping([bare], "2026-09-16T08:00:00Z")).toBeUndefined();
  });

  test("findMapping follows the pages until one has an upload from before the golden copy", async () => {
    const pages: Record<string, { data: MappingUpload[]; links: { next: string | null } }> = {
      [`${MAPPING_API}/bic-lei?page%5Bsize%5D=100`]: {
        data: [upload("2026-09-30T00:00:00Z"), upload("2026-09-25T00:00:00Z")],
        links: { next: "https://mapping.example/page2" },
      },
      "https://mapping.example/page2": {
        data: [upload("2026-09-20T00:00:00Z", { valid: false }), upload("2026-08-28T00:00:00Z")],
        links: { next: null },
      },
    };
    const seen: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      seen.push(String(input));
      const page = pages[String(input)];
      return page === undefined
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(page));
    }) as typeof fetch;
    expect(await findMapping("bic-lei", "2026-09-16T08:00:00Z", { fetch: fetcher })).toBe(
      "https://files.example/map-2026-08-28T00:00:00Z.zip",
    );
    expect(seen).toHaveLength(2);
    await expect(
      findMapping("bic-lei", "2026-01-01T00:00:00Z", { fetch: fetcher }),
    ).rejects.toThrow(/no valid bic-lei upload from before/);
  });

  test("the code list's CSV is the link on its page that matches", async () => {
    const http = { fetch: gleif() };
    expect(await codeListLink(ELF_PAGE, /elf-code-list/i, http)).toMatch(
      /elf-code-list-v1\.6\.csv$/,
    );
    await expect(codeListLink(RA_PAGE, /elf-code-list/i, http)).rejects.toThrow(/no CSV link/);
  });
});

describe("downloadInputs", () => {
  test("fetches the six files, through .part files, and names the date", async () => {
    const dir = join(root, "download");
    const inputs = await downloadInputs(dir, "2026-09-16", { fetch: gleif(), ...quick });
    expect(inputs.asOf).toBe("2026-09-16");
    expect(inputs.records).toBe(12);
    expect(readFileSync(inputs.lei2)).toEqual(
      zipBody("https://files.example/lei2-2026-09-16T08:00:00.zip"),
    );
    // The mapping files are the uploads from before the golden copy, not the newest.
    expect(readFileSync(inputs.isin)).toEqual(
      zipBody("https://files.example/map-2026-09-16T07:15:10Z.zip"),
    );
    expect(readFileSync(inputs.ra as string, "utf8")).toMatch(/ra-list-v1\.9\.csv$/);
  });
});

describe("download", () => {
  const remote = (body: Buffer, size = body.length) => ({
    url: "https://files.example/a.zip",
    size,
  });
  // Content that does not compress to nothing, so that cutting the zip short cuts it.
  const body = zipOf(
    "a.csv",
    Array.from({ length: 3000 }, (_, i) => ((i * 7919) % 10007).toString(36)).join(","),
  );

  /** A fetch that plays one response per call. */
  function script(...responses: (() => Response)[]): { fetch: typeof fetch; calls: () => number } {
    let calls = 0;
    return {
      fetch: (async () => {
        const next = responses[Math.min(calls, responses.length - 1)] as () => Response;
        calls++;
        return next();
      }) as typeof fetch,
      calls: () => calls,
    };
  }

  /** A body that sends `part` and then fails, as a connection reset does. */
  const reset = (part: Buffer) => () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(part);
          controller.error(new Error("socket hang up"));
        },
      }),
    );
  const whole = (data: Buffer) => () => new Response(data);

  test("tries the whole download again after a reset half way through", async () => {
    const destination = join(root, "reset.zip");
    const http = script(reset(body.subarray(0, 1000)), whole(body));
    await download(remote(body), destination, { ...http, ...quick });
    expect(http.calls()).toBe(2);
    expect(readFileSync(destination)).toEqual(body);
  });

  test("a short body is an error even when the connection ends cleanly, and is retried", async () => {
    const destination = join(root, "short.zip");
    const http = script(whole(body.subarray(0, 500)), whole(body));
    await download(remote(body), destination, { ...http, ...quick });
    expect(http.calls()).toBe(2);
  });

  test("the size the API gives is checked, and Content-Length when the API gives none", async () => {
    const wrong = script(whole(body));
    await expect(
      download(remote(body, body.length + 1), join(root, "wrong.zip"), { ...wrong, ...quick }),
    ).rejects.toThrow(/got \d+ bytes, expected \d+/);
    const header = script(
      () =>
        new Response(body.subarray(0, 700), { headers: { "content-length": String(body.length) } }),
      whole(body),
    );
    await download({ url: "https://files.example/b.zip" }, join(root, "header.zip"), {
      ...header,
      ...quick,
    });
    expect(header.calls()).toBe(2);
  });

  test("a zip that does not test clean is an error", async () => {
    const broken = Buffer.from(body);
    broken.fill(0x41, 100, 200);
    const http = script(whole(broken));
    await expect(
      download(remote(broken), join(root, "broken.zip"), { ...http, ...quick, tries: 2 }),
    ).rejects.toThrow(/does not test clean/);
    expect(http.calls()).toBe(2);
  });

  test("gives up after the tries, backs off between them, and leaves no .part file", async () => {
    const waits: number[] = [];
    const http = script(reset(body.subarray(0, 10)));
    await expect(
      download(remote(body), join(root, "never.zip"), {
        ...http,
        tries: 3,
        backoffMs: 100,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).rejects.toThrow(/download https:\/\/files.example\/a.zip: socket hang up/);
    expect(http.calls()).toBe(3);
    expect(waits).toEqual([100, 200]);
    expect(() => readFileSync(join(root, "never.zip.part"))).toThrow();
    expect(() => readFileSync(join(root, "never.zip"))).toThrow();
  });

  test("a stalled body is abandoned after the idle time, and tried again", async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(body.subarray(0, 100));
          },
        }),
      );
    const http = script(stalled, whole(body));
    await download(remote(body), join(root, "stall.zip"), { ...http, ...quick, idleMs: 100 });
    expect(http.calls()).toBe(2);
  });

  test("a 404 is not retried, a 503 is", async () => {
    const missing = script(() => new Response("", { status: 404, statusText: "Not Found" }));
    await expect(
      download(remote(body), join(root, "x.zip"), { ...missing, ...quick }),
    ).rejects.toThrow(/404/);
    expect(missing.calls()).toBe(1);
    const busy = script(() => new Response("", { status: 503 }), whole(body));
    await download(remote(body), join(root, "busy.zip"), { ...busy, ...quick });
    expect(busy.calls()).toBe(2);
  });

  test("a JSON request that fails half way is retried too", async () => {
    const http = script(reset(Buffer.from('{"data": [')), () => new Response('{"data": []}'));
    expect(
      await resolvePublish("latest", { ...http, ...quick }).catch((e: Error) => e.message),
    ).toMatch(/no golden copy/);
    expect(http.calls()).toBe(2);
  });
});

describe("localInputs", () => {
  test("finds the files in a directory and reads the date from the golden copy", async () => {
    const dir = join(root, "local");
    writeInputs(dir, fixtureGolden());
    const inputs = await localInputs(dir);
    expect(inputs.asOf).toBe("2026-09-16");
    expect(inputs.lei2).toBe(join(dir, "lei2.csv.zip"));
    expect((await localInputs(dir, "2026-09-20")).asOf).toBe("2026-09-20");
    await expect(localInputs(dir, "soon")).rejects.toThrow(/not YYYY-MM-DD/);
  });

  test("also looks in signals/, as research/data does; the RA list is optional, the rest is not", async () => {
    const dir = join(root, "research");
    writeInputs(join(dir, "signals"), fixtureGolden());
    writeFileSync(join(dir, "lei2.csv.zip"), readFileSync(join(dir, "signals", "lei2.csv.zip")));
    const inputs = await localInputs(dir);
    expect(inputs.elf).toBe(join(dir, "signals", "elf-raw.csv"));
    expect(inputs.ra).toBe(join(dir, "signals", "ra-list.csv"));
    rmSync(join(dir, "signals", "ra-list.csv"));
    expect((await localInputs(dir)).ra).toBeUndefined();
    rmSync(join(dir, "signals", "bic-lei.zip"));
    await expect(localInputs(dir)).rejects.toThrow(/bic-lei\.zip is not in/);
  });
});
