import type { Manifest } from "@whichlei/core";
import { describe, expect, it } from "vitest";
import { IndexChangedError, IndexClient, IndexError } from "./client.ts";
import { fakeServer, fixture } from "./test-helpers.ts";

const ORIGIN = "https://index.test";

function setup() {
  const { manifest, files } = fixture();
  const server = fakeServer(ORIGIN, manifest, files);
  const client = new IndexClient(`${ORIGIN}/`, { fetch: server.fetch });
  return { manifest, files, server, client };
}

/** The same index as another build: what a publish does. */
function republish(
  manifest: Manifest,
  files: Map<number, string>,
): [Manifest, Map<number, string>] {
  return [{ ...manifest, build: "20260917-0a0b0c0d", asOf: "2026-09-17" }, files];
}

describe("IndexClient", () => {
  it("loads the manifest once and asks for revalidation", async () => {
    const { client, server, manifest } = setup();
    const inits: (RequestInit | undefined)[] = [];
    const spy = new IndexClient(ORIGIN, {
      fetch: (input, init) => {
        inits.push(init);
        return server.fetch(input, init);
      },
    });
    expect(await spy.manifest()).toEqual(manifest);
    await spy.manifest();
    expect(inits).toEqual([{ cache: "no-cache" }]);
    expect(await client.manifest()).toEqual(manifest);
    expect(server.log.filter((p) => p === "index.json")).toHaveLength(2);
  });

  it("shares one request between two callers of the same file, and keeps the text", async () => {
    const { client, server, manifest, files } = setup();
    const [a, b] = await Promise.all([
      client.file(manifest.build, 3),
      client.file(manifest.build, 3),
    ]);
    expect(a).toBe(files.get(3));
    expect(b).toBe(a);
    await client.file(manifest.build, 3);
    expect(server.log.filter((p) => p === `${manifest.build}/3.txt`)).toHaveLength(1);
  });

  it("fetches the file from the build directory named in the manifest", async () => {
    const { client, server, manifest } = setup();
    await client.file(manifest.build, 0);
    expect(server.log).toEqual(["index.json", `${manifest.build}/0.txt`]);
  });

  it("aborts a request nobody waits for", async () => {
    const { client, server, manifest } = setup();
    await client.manifest();
    const release = server.hold(`${manifest.build}/1.txt`);
    const controller = new AbortController();
    const pending = client.file(manifest.build, 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(server.aborted).toEqual([`${manifest.build}/1.txt`]);
    release();
    // Asking again starts a fresh request.
    const again = client.file(manifest.build, 1);
    await expect(again).resolves.toContain("\t");
  });

  it("keeps a request while another caller still waits for it", async () => {
    const { client, server, manifest, files } = setup();
    await client.manifest();
    const release = server.hold(`${manifest.build}/1.txt`);
    const first = new AbortController();
    const a = client.file(manifest.build, 1, first.signal);
    const b = client.file(manifest.build, 1);
    first.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(server.aborted).toEqual([]);
    release();
    expect(await b).toBe(files.get(1));
  });

  it("rejects at once when the signal has already aborted", async () => {
    const { client, server, manifest } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.file(manifest.build, 1, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(server.log).toEqual([]);
  });

  it("reloads the manifest once on a 404 and says route again when the build changed", async () => {
    const { client, server, manifest, files } = setup();
    await client.manifest();
    server.publish(...republish(manifest, files));
    await expect(client.file(manifest.build, 2)).rejects.toBeInstanceOf(IndexChangedError);
    expect(server.log.filter((p) => p === "index.json")).toHaveLength(2);
    expect((await client.manifest()).build).toBe("20260917-0a0b0c0d");
    // A caller that routed with the old build is told so, whatever it asks for.
    await expect(client.file(manifest.build, 2)).rejects.toBeInstanceOf(IndexChangedError);
    // The next file comes from the new build.
    expect(await client.file("20260917-0a0b0c0d", 2)).toBe(files.get(2));
    expect(server.log.at(-1)).toBe("20260917-0a0b0c0d/2.txt");
  });

  it("reloads the manifest once for several files that 404 together", async () => {
    const { client, server, manifest, files } = setup();
    await client.manifest();
    server.publish(...republish(manifest, files));
    const results = await Promise.allSettled([
      client.file(manifest.build, 1),
      client.file(manifest.build, 2),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(server.log.filter((p) => p === "index.json")).toHaveLength(2);
  });

  it("says the index is broken when the build is still the same after a 404", async () => {
    const { client, server, manifest, files } = setup();
    await client.manifest();
    const broken = new Map(files);
    broken.delete(4);
    server.publish(manifest, broken);
    const error = await client.file(manifest.build, 4).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexError);
    expect(error).toMatchObject({ kind: "http" });
  });

  it("reports a network failure, and loads the manifest again next time", async () => {
    const { client, server } = setup();
    server.fail("index.json");
    await expect(client.manifest()).rejects.toMatchObject({ kind: "network" });
    server.fail(null);
    await expect(client.manifest()).resolves.toMatchObject({ format: 1 });
  });

  it("tells a manifest of another format version from a damaged one", async () => {
    const { server, manifest, files } = setup();
    server.publish({ ...manifest, format: 2 as never }, files);
    const client = new IndexClient(ORIGIN, { fetch: server.fetch });
    await expect(client.manifest()).rejects.toMatchObject({ kind: "unsupported" });
    server.publish({ ...manifest, bounds: [] }, files);
    await expect(new IndexClient(ORIGIN, { fetch: server.fetch }).manifest()).rejects.toMatchObject(
      { kind: "format" },
    );
  });

  it("keeps at most maxFiles files in memory", async () => {
    const { server, manifest } = setup();
    const client = new IndexClient(ORIGIN, { fetch: server.fetch, maxFiles: 2 });
    await client.file(manifest.build, 0);
    await client.file(manifest.build, 1);
    await client.file(manifest.build, 2);
    await client.file(manifest.build, 0);
    expect(server.log.filter((p) => p === `${manifest.build}/0.txt`)).toHaveLength(2);
  });
});
