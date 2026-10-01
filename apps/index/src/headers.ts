// The `_headers` file the Worker's assets are served with (docs/index-format.md).

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

/**
 * Every response: CORS for any origin, no content sniffing. The manifest is revalidated on
 * every load. The files of each build are immutable for a year.
 *
 * Rules that match one path add up, so Cache-Control is never set under `/*`. A build's own
 * rule is written per build id: `_headers` has no pattern for "one directory".
 */
export function headersFile(builds: readonly string[]): string {
  const lines = ["/*", "  Access-Control-Allow-Origin: *", "  X-Content-Type-Options: nosniff", ""];
  lines.push("/index.json", `  Cache-Control: ${REVALIDATE}`, "");
  for (const build of builds) {
    if (!/^\d{8}-[0-9a-f]{8,64}$/.test(build)) throw new Error(`build id ${build} is odd`);
    lines.push(`/${build}/*`, `  Cache-Control: ${IMMUTABLE}`, "");
  }
  return lines.join("\n");
}
