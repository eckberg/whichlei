// Read a zip member as a stream with the system's `unzip -p`, so the raw CSV never sits in
// memory and no zip library is needed. GitHub's runners have unzip installed.
import { execFileSync, spawn } from "node:child_process";

/** Name of the first file in the archive. The golden copies hold exactly one. */
export function firstMember(zipPath: string): string {
  const names = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split("\n")
    .filter((name) => name !== "");
  const [first] = names;
  if (first === undefined) throw new Error(`${zipPath} is empty`);
  return first;
}

/** The first member's bytes, in chunks. Throws at the end if `unzip` failed. */
export async function* unzipStream(zipPath: string): AsyncGenerator<Buffer> {
  const child = spawn("unzip", ["-p", zipPath, firstMember(zipPath)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    if (stderr.length < 4000) stderr += text;
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // A failed spawn must not go unhandled while we are still reading.
  exit.catch(() => {});
  let read = false;
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    read = true;
  } finally {
    if (!read) child.kill();
  }
  const code = await exit;
  if (code !== 0) throw new Error(`unzip -p ${zipPath} exited with ${code}: ${stderr.trim()}`);
}
