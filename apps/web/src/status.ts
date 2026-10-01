// One word for the state of a record, from GLEIF's own status codes. Shared by the record page
// and the lookups on the search page.

export type Tone = "active" | "lapsed" | "retired";

/** GLEIF codes such as `NO_KNOWN_PERSON` and `FULLY_CORROBORATED`, in plain lower case. */
export const words = (code: string): string => code.toLowerCase().replace(/[_-]/g, " ");

/**
 * One word for the state of the record, as the prototype shows it. An inactive entity is
 * inactive whatever its registration says; issued and pending records count as active.
 */
export function stateOf(
  entityStatus: string,
  registrationStatus: string,
): { label: string; tone: Tone } {
  if (entityStatus === "INACTIVE") return { label: "inactive", tone: "retired" };
  if (registrationStatus === "LAPSED") return { label: "lapsed", tone: "lapsed" };
  if (["ISSUED", "PENDING_TRANSFER", "PENDING_ARCHIVAL"].includes(registrationStatus)) {
    return { label: "active", tone: "active" };
  }
  if (registrationStatus === "NULL") return { label: "unknown", tone: "lapsed" };
  return { label: words(registrationStatus), tone: "retired" };
}
