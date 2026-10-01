// Which Worker version a rollback goes to. Never "the previous version": that is whatever
// was deployed last, which after an earlier rollback or a re-run is not the build before.
// Each publish names its version with the build id (`wrangler deploy --message <build>`), so
// the version list says which build each version serves.

const BUILD = /^\d{8}-[0-9a-f]{8,64}$/;

/** One entry of `wrangler versions list --json`; other fields are ignored. */
export interface WorkerVersion {
  id: string;
  metadata?: { created_on?: string };
  annotations?: { "workers/message"?: string };
}

export interface RollbackTarget {
  /** The Worker version to restore. */
  id: string;
  /** The build its index.json names, from the version's message. */
  build: string;
}

/**
 * Build ids order by their date, then by the whole string: the id starts with YYYYMMDD,
 * so comparing the strings does both.
 */
export const olderBuild = (a: string, b: string): boolean => a < b;

const buildOf = (v: WorkerVersion): string | undefined => {
  const message = v.annotations?.["workers/message"]?.trim();
  return message !== undefined && BUILD.test(message) ? message : undefined;
};

/**
 * The version to restore, or a reason there is none.
 *
 * Without `versionId`: the version of the newest build older than `live` (several versions of
 * one build: the most recently created). With `versionId`: that version, which must be among
 * `versions`, must have a build id for its message, and must not be the live build.
 */
export function pickRollbackTarget(
  versions: readonly WorkerVersion[],
  live: string,
  versionId?: string,
): RollbackTarget | { error: string } {
  if (!BUILD.test(live)) return { error: `the live build "${live}" is not a build id` };
  if (versionId !== undefined) {
    const version = versions.find((v) => v.id === versionId);
    if (version === undefined) {
      return { error: `version ${versionId} is not among the ${versions.length} most recent` };
    }
    const build = buildOf(version);
    if (build === undefined) {
      return {
        error: `version ${versionId} has no build id as its message, so it is not one this workflow published`,
      };
    }
    if (build === live)
      return { error: `version ${versionId} serves ${build}, which is live already` };
    return { id: version.id, build };
  }
  const older = versions
    .flatMap((v) => {
      const build = buildOf(v);
      return build !== undefined && olderBuild(build, live) ? [{ v, build }] : [];
    })
    .sort(
      (x, y) =>
        (x.build < y.build ? 1 : x.build > y.build ? -1 : 0) ||
        (y.v.metadata?.created_on ?? "").localeCompare(x.v.metadata?.created_on ?? ""),
    );
  const best = older[0];
  if (best === undefined) {
    return {
      error: `none of the ${versions.length} most recent versions serves a build older than ${live}`,
    };
  }
  return { id: best.v.id, build: best.build };
}
