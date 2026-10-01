import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { zipOf } from "./fixture.ts";
import { firstMember, unzipStream } from "./unzip.ts";

const dir = mkdtempSync(join(tmpdir(), "whichlei-unzip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("unzip", () => {
  test("streams the first member's bytes", async () => {
    const path = join(dir, "a.zip");
    const text = "LEI,name\r\n1,Mærsk\r\n".repeat(50_000);
    writeFileSync(path, zipOf("20260916-0800-lei2.csv", text));
    expect(firstMember(path)).toBe("20260916-0800-lei2.csv");
    const chunks: Buffer[] = [];
    for await (const chunk of unzipStream(path)) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(text);
  });

  test("fails loudly on a file that is no zip", async () => {
    const path = join(dir, "bad.zip");
    writeFileSync(path, "not a zip");
    await expect(async () => {
      for await (const _ of unzipStream(path)) {
        // read to the end
      }
    }).rejects.toThrow();
  });
});
