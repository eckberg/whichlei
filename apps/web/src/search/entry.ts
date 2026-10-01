// What the result list and the preview show about an index entry.
import type { Entry, Status } from "@whichlei/core";

export type Tone = "active" | "lapsed" | "retired";

const LABELS: Record<string, string> = {
  I: "issued",
  L: "lapsed",
  T: "pending transfer",
  P: "pending archival",
  R: "retired",
  D: "duplicate",
  A: "annulled",
  M: "merged",
};

/**
 * One word for the state of a record, as the prototype and the record page show it. A lower
 * case status marks an INACTIVE entity. Issued and pending records count as active.
 */
export function statusOf(status: Status): { label: string; tone: Tone } {
  if (status === status.toLowerCase()) return { label: "inactive", tone: "retired" };
  if (status === "L") return { label: "lapsed", tone: "lapsed" };
  if (status === "I" || status === "T" || status === "P")
    return { label: "active", tone: "active" };
  return { label: LABELS[status] ?? status.toLowerCase(), tone: "retired" };
}

/** A result: an index entry, or the row a valid LEI typed in full makes. */
export interface Hit {
  entry: Entry;
  /**
   * The input is itself an LEI with valid check digits. Until GLEIF has confirmed it, the
   * entry is empty: the index has no data for it.
   */
  typed?: true;
  /** Found by a lookup at GLEIF, not in the index: the reading that found it, "isin" and so on. */
  via?: string;
  /** The state as GLEIF's status codes give it. A lookup has these, not the index's letter. */
  status?: { label: string; tone: Tone };
}

/** Legal name first, then the other names that are not the same text. */
export const namesOf = (entry: Entry): string[] => [entry.name, ...entry.otherNames];
