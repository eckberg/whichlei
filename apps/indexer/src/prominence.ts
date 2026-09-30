// Static prominence of an entity, known at build time from GLEIF data alone. Port of
// `ranking.prominence` in research/ranking/ranking.py with W_RECOMMENDED, in the
// arithmetic of `engine.prominence`, which built the reference index.
//
// The research sums in float32: each feature is a float32 and so is every product and
// every sum. Registration age is the largest effect. A float32 holds a year near 2026 to
// 1.2e-4, so ages move by up to 6e-5 years, about 1.5e-5 of prominence. Computed in double,
// most entities would differ from the reference in the fifth decimal. So this port rounds
// to float32 after every operation (`f`), in the same order, and gets the same bits.
// The one exception is ln(name length), which numpy evaluates with its own float32 log;
// that can differ from the correctly rounded one in the last bit for some lengths.
const f = Math.fround;

/** The fitted weights, ranking.W_RECOMMENDED. Match weights are not needed to build. */
export const W_RECOMMENDED = {
  /** Entity INACTIVE, or registration RETIRED, ANNULLED, DUPLICATE or MERGED. */
  p_dead: -2.9,
  /** Registration LAPSED. */
  p_lapsed: -0.39,
  /** Category FUND. */
  p_fund: 0.32,
  /** Fixed at 0: a boost only reflected the Wikidata head sample. */
  p_gov: 0.0,
  /** Times log1p(max(direct, ultimate) consolidated children). */
  p_children: 0.5,
  /** Has consolidated children and no parent. */
  p_top: 1.36,
  p_has_parent: -0.56,
  /** Times log1p(international branches). */
  p_branches: -0.91,
  /** Times min(log1p(ISIN count), isin_cap). */
  p_isin: 0.49,
  /** log1p(50) */
  isin_cap: 3.932,
  p_bic: 0.74,
  /** Times min(years since LEI registration, 15) / 10. */
  p_age: 2.46,
  /** Times ln(legal name length in characters). */
  p_len: -1.01,
} as const;

export type ProminenceWeights = typeof W_RECOMMENDED;

/** GLEIF's registration statuses that mean the record is no longer live. */
const DEAD_REGISTRATION = new Set(["RETIRED", "ANNULLED", "DUPLICATE", "MERGED"]);
const GOVERNMENT = new Set(["RESIDENT_GOVERNMENT_ENTITY", "INTERNATIONAL_ORGANIZATION"]);

/** Raw attributes of an entity. */
export interface ProminenceInput {
  /** `Entity.EntityStatus`: ACTIVE or INACTIVE. Anything but ACTIVE counts as dead. */
  entityStatus: string;
  /** `Registration.RegistrationStatus`. */
  registrationStatus: string;
  /** `Entity.EntityCategory`. */
  category: string;
  /** ACTIVE IS_DIRECTLY_CONSOLIDATED_BY relationships where this LEI is the parent. */
  nDirect: number;
  /** The same for IS_ULTIMATELY_CONSOLIDATED_BY. */
  nUltimate: number;
  /** The same for IS_INTERNATIONAL_BRANCH_OF. */
  nBranch: number;
  /** Reports a direct or an ultimate accounting parent. */
  hasParent: boolean;
  /** Rows for this LEI in the ISIN mapping. */
  isin: number;
  /** Has a row in the BIC mapping. */
  bic: boolean;
  /** `registrationYear` of the initial registration date; NaN if unknown. */
  registeredYear: number;
  /** Characters (code points) in the legal name. */
  nameLength: number;
}

/**
 * Prominence of one entity, as float32 arithmetic gives it. `nowYear` is the golden copy's
 * date as a year fraction (`yearFraction`).
 */
export function prominence(
  e: ProminenceInput,
  nowYear: number,
  w: ProminenceWeights = W_RECOMMENDED,
): number {
  const dead = e.entityStatus !== "ACTIVE" || DEAD_REGISTRATION.has(e.registrationStatus);
  const lapsed = !dead && e.registrationStatus === "LAPSED";
  const nConsolidated = Math.max(e.nDirect, e.nUltimate);

  // Years since registration, float32, unknown as 0, at most 15, in tens of years.
  const age = f(f(nowYear) - f(e.registeredYear));
  const years = Number.isNaN(age) ? 0 : Math.min(Math.max(age, 0), 15);

  const term = (weight: number, feature: number) => f(f(weight) * f(feature));
  let p = f(term(w.p_dead, dead ? 1 : 0) + term(w.p_lapsed, lapsed ? 1 : 0));
  p = f(p + term(w.p_fund, e.category === "FUND" ? 1 : 0));
  p = f(p + term(w.p_gov, GOVERNMENT.has(e.category) ? 1 : 0));
  p = f(p + term(w.p_children, Math.log1p(nConsolidated)));
  p = f(p + term(w.p_top, nConsolidated > 0 && !e.hasParent ? 1 : 0));
  p = f(p + term(w.p_has_parent, e.hasParent ? 1 : 0));
  p = f(p + term(w.p_branches, Math.log1p(e.nBranch)));
  p = f(p + term(w.p_isin, Math.min(f(Math.log1p(e.isin)), f(w.isin_cap))));
  p = f(p + term(w.p_bic, e.bic ? 1 : 0));
  p = f(p + term(w.p_age, f(years / 10)));
  p = f(p + term(w.p_len, Math.log(Math.max(e.nameLength, 1))));
  return p;
}

/**
 * A date as a year fraction, the way the research reads registration dates: the year plus
 * whole months over 12. "2012-11-06T09:18:00.000Z" is 2012.8333. NaN if it is no date.
 */
export function registrationYear(date: string): number {
  if (date.length < 10 || !/^\d{4}$/.test(date.slice(0, 4))) return Number.NaN;
  const month = Number(date.slice(5, 7));
  return Number(date.slice(0, 4)) + (month - 1) / 12;
}

/** "Now" for a golden copy published on `date` (YYYY-MM-DD): the year and the fraction past. */
export function yearFraction(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return year + (month - 1 + (day - 1) / daysInMonth) / 12;
}

/** Characters as Python's len() counts them: a code point, not a UTF-16 unit. */
export function codePointLength(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        length--;
        i++;
      }
    }
  }
  return length;
}
