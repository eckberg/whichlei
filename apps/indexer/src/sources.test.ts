import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { fixtureGolden, writeInputs } from "./fixture.ts";
import {
  codeListLink,
  downloadInputs,
  ELF_PAGE,
  latestMapping,
  localInputs,
  MAPPING_API,
  PUBLISHES_API,
  RA_PAGE,
  resolvePublish,
} from "./sources.ts";

const root = mkdtempSync(join(tmpdir(), "whichlei-sources-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const publish = (date: string) => ({
  publish_date: date,
  lei2: {
    full_file: {
      csv: { url: `https://files.example/lei2-${date.replace(" ", "T")}.zip`, record_count: 12 },
    },
  },
  rr: { full_file: { csv: { url: `https://files.example/rr-${date.replace(" ", "T")}.zip` } } },
});

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
    if (url === `${MAPPING_API}/isin-lei`) {
      return json({ data: [{ attributes: { downloadLink: "https://files.example/isin.zip" } }] });
    }
    if (url === `${MAPPING_API}/bic-lei`) {
      return json({ data: [{ attributes: { downloadLink: "https://files.example/bic.zip" } }] });
    }
    if (url === ELF_PAGE) {
      return new Response(
        '<a href="https://www.gleif.org/x/other.csv">o</a><a href="https://www.gleif.org/x/2026-02-19-elf-code-list-v1.6.csv">elf</a>',
      );
    }
    if (url === RA_PAGE) {
      return new Response('<a href="https://www.gleif.org/x/2026-09-30_ra-list-v1.9.csv">ra</a>');
    }
    if (url.startsWith("https://files.example/") || url.startsWith("https://www.gleif.org/x/")) {
      return new Response(`content of ${url}`);
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;
}

describe("resolvePublish", () => {
  test("the latest is the first of the newest page", async () => {
    expect(await resolvePublish("latest", gleif())).toMatchObject({
      asOf: "2026-09-17",
      lei2: "https://files.example/lei2-2026-09-17T16:00:00.zip",
      records: 12,
    });
  });

  test("a date takes its 08:00 golden copy, paging back to it", async () => {
    const seen: string[] = [];
    const found = await resolvePublish("2026-09-16", gleif(seen));
    // Not the 16:00 copy of the same day.
    expect(found.lei2).toBe("https://files.example/lei2-2026-09-16T08:00:00.zip");
    expect(found.rr).toBe("https://files.example/rr-2026-09-16T08:00:00.zip");
    // The 16:00 copy on page 1 is not the one; the 08:00 copy is on page 2.
    expect(seen).toHaveLength(2);
    expect(found.asOf).toBe("2026-09-16");
  });

  test("a date with no golden copy is an error", async () => {
    const seen: string[] = [];
    await expect(resolvePublish("2026-09-10", gleif(seen))).rejects.toThrow(/no golden copy/);
    expect(seen).toHaveLength(3); // the third page is empty
    await expect(resolvePublish("yesterday", gleif())).rejects.toThrow(/not YYYY-MM-DD/);
  });
});

describe("mapping files and code lists", () => {
  test("the newest upload of a mapping file", async () => {
    expect(await latestMapping("isin-lei", gleif())).toBe("https://files.example/isin.zip");
  });

  test("the code list's CSV is the link on its page that matches", async () => {
    expect(await codeListLink(ELF_PAGE, /elf-code-list/i, gleif())).toMatch(
      /elf-code-list-v1\.6\.csv$/,
    );
    await expect(codeListLink(RA_PAGE, /elf-code-list/i, gleif())).rejects.toThrow(/no CSV link/);
  });
});

describe("downloadInputs", () => {
  test("fetches the six files, through .part files, and names the date", async () => {
    const dir = join(root, "download");
    const inputs = await downloadInputs(dir, "2026-09-16", gleif());
    expect(inputs.asOf).toBe("2026-09-16");
    expect(inputs.records).toBe(12);
    expect(readFileSync(inputs.lei2, "utf8")).toBe(
      "content of https://files.example/lei2-2026-09-16T08:00:00.zip",
    );
    expect(readFileSync(inputs.ra, "utf8")).toMatch(/ra-list-v1\.9\.csv$/);
    expect(readFileSync(inputs.isin, "utf8")).toMatch(/isin\.zip$/);
  });

  test("a failing download is an error, with retries for a server error only", async () => {
    let calls = 0;
    const broken = (async () => {
      calls++;
      return new Response("", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    await expect(resolvePublish("latest", broken)).rejects.toThrow(/404/);
    expect(calls).toBe(1);
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

  test("also looks in signals/, as research/data does, and names what is missing", async () => {
    const dir = join(root, "research");
    writeInputs(join(dir, "signals"), fixtureGolden());
    writeFileSync(join(dir, "lei2.csv.zip"), readFileSync(join(dir, "signals", "lei2.csv.zip")));
    const inputs = await localInputs(dir);
    expect(inputs.elf).toBe(join(dir, "signals", "elf-raw.csv"));
    rmSync(join(dir, "signals", "ra-list.csv"));
    await expect(localInputs(dir)).rejects.toThrow(/ra-list\.csv is not in/);
  });
});
