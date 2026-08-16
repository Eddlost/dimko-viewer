// ────────────────────────────────────────────────────────────────────────────
// Where the "storeys" axis comes from.
//
// `IfcBuildingStorey` is the right answer for a model authored by the
// architect, and the wrong one the moment a second party layers its own
// structure on top: a cost estimator ships the same geometry with its own
// property (`rubim_podlazi` and friends), and that — not the spatial tree — is
// the division its users work in. So the source is a per-model setting, with
// the IFC spatial structure as the default nobody has to opt into.
//
// Everything here is pure so the ranking heuristic and the ordering are
// testable without a model: both are judgement calls that will need tuning
// against real files, and neither is observable enough to debug by eye.
// ────────────────────────────────────────────────────────────────────────────

import type { PropertyCatalog } from "../properties/propertyIndex";

export type StoreySource =
  | { kind: "ifc" }
  | { kind: "property"; name: string };

export const IFC_STOREY_SOURCE: StoreySource = { kind: "ifc" };

/**
 * Bucket for elements the chosen property says nothing about.
 *
 * Not cosmetic: `computeVisibleIds` treats the union of storeys as the base
 * set every other axis subtracts from, so an element outside every storey
 * disappears the moment the user hides anything at all. The IFC axis is
 * near-total by construction; a property axis never is — half a model may
 * simply not carry the estimator's property. Embedders localise the label.
 */
export const UNASSIGNED_STOREY_NAME = "Unassigned";

export type StoreySourceCandidate = {
  /** Property name as it appears in the Pset. */
  name: string;
  /** Distinct values — the storeys this source would produce. */
  valueCount: number;
  /** Share of the model's elements carrying the property, 0..1. */
  coverage: number;
  /** Higher = more storey-like. Only meaningful for ranking. */
  score: number;
  /** First few values in storey order, for showing the user what they'd get. */
  sample: string[];
};

/** A property with fewer values than this is a flag, not a storey division. */
const MIN_VALUES = 2;
/** More than this and it is an element-level attribute, not a division. */
const MAX_VALUES = 60;
/** Below this share of the model, the axis would hide most of the building. */
const MIN_COVERAGE = 0.15;
/** Candidates weaker than this are noise and are not offered at all. */
const MIN_SCORE = 1;

/** Lowercase and strip diacritics so `Podlaží` matches `podlazi`. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const NAME_HINTS =
  /podlaz|patro|storey|story|level|floor|etage|geschoss|niveau|nadzemi|podzemi/;

/**
 * Czech storey labels: `1.NP`, `2 NP`, `1.PP`. PP (podzemní podlaží) counts
 * downwards, so 1.PP sits below 1.NP and 2.PP below that.
 */
const CZ_STOREY = /^\s*(-?\d+)\s*[.,]?\s*(np|pp)\b/;
/** `Level 0`, `Etage -1`, `2. patro`. */
const WORD_AND_NUMBER = /(podlazi|patro|storey|story|level|floor|etage)\s*(-?\d+)|(-?\d+)\s*[.,]?\s*(podlazi|patro|storey|story|level|floor|etage)/;
/** A bare number is a plausible level index — weak on its own. */
const BARE_NUMBER = /^\s*-?\d+([.,]\d+)?\s*$/;

function looksLikeStoreyLabel(value: string): boolean {
  const v = fold(value);
  return CZ_STOREY.test(v) || WORD_AND_NUMBER.test(v) || BARE_NUMBER.test(v);
}

/**
 * Sort rank of a storey label, or null when it carries no number to sort by.
 * Negative = below ground, so the list reads bottom-up like the building.
 */
export function storeyRank(name: string): number | null {
  const v = fold(name);
  const cz = CZ_STOREY.exec(v);
  if (cz) {
    const n = Number(cz[1]);
    if (!Number.isFinite(n)) return null;
    return cz[2] === "pp" ? -Math.abs(n) : Math.abs(n);
  }
  const word = WORD_AND_NUMBER.exec(v);
  if (word) {
    const n = Number(word[2] ?? word[3]);
    if (Number.isFinite(n)) return n;
  }
  const lead = /^\s*(-?\d+)/.exec(v);
  if (lead) {
    const n = Number(lead[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Order storeys the way a building is stacked: basements first, then numbered
 * floors, then anything unparseable alphabetically, with the unassigned bucket
 * pinned last so it never sits between two real storeys.
 */
export function compareStoreyNames(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNASSIGNED_STOREY_NAME) return 1;
  if (b === UNASSIGNED_STOREY_NAME) return -1;
  const ra = storeyRank(a);
  const rb = storeyRank(b);
  if (ra !== null && rb !== null) {
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b, undefined, { numeric: true });
  }
  if (ra !== null) return -1;
  if (rb !== null) return 1;
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Rank the catalog's properties by how much they look like a storey division,
 * best first. Deliberately generous: the user picks from this list, so a false
 * positive costs a line in a dropdown while a false negative hides the one
 * property they actually needed.
 */
export function detectStoreySourceCandidates(
  catalog: PropertyCatalog,
): StoreySourceCandidate[] {
  const total = catalog.totalElements;
  if (!total) return [];

  const out: StoreySourceCandidate[] = [];
  for (const [name, entries] of catalog.properties) {
    if (entries.length < MIN_VALUES || entries.length > MAX_VALUES) continue;

    // One element can carry the same property from two Psets, so count the
    // union rather than summing the buckets.
    const covered = new Set<number>();
    for (const e of entries) for (const id of e.elementIds) covered.add(id);
    const coverage = covered.size / total;
    if (coverage < MIN_COVERAGE) continue;

    const labelled = entries.filter((e) => looksLikeStoreyLabel(e.value)).length;
    const labelShare = labelled / entries.length;

    // Name is the strongest signal (`rubim_podlazi` is unambiguous), value
    // shape the next, coverage a tie-breaker. Many distinct values pull down:
    // 40 of them is more likely a room number than a storey.
    let score = 0;
    if (NAME_HINTS.test(fold(name))) score += 3;
    if (labelShare >= 0.5) score += 2;
    else if (labelShare > 0) score += labelShare;
    score += coverage;
    score -= entries.length / MAX_VALUES;
    if (score < MIN_SCORE) continue;

    const sample = entries
      .map((e) => e.value)
      .sort(compareStoreyNames)
      .slice(0, 4);
    out.push({ name, valueCount: entries.length, coverage, score, sample });
  }

  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out;
}

/**
 * Build the storey groups a property source would produce, in storey order.
 * Returns null when the property is absent or carries nothing — the caller
 * falls back to the IFC axis rather than showing an empty tree.
 */
export function storeysFromCatalog(
  catalog: PropertyCatalog,
  propertyName: string,
): Array<{ name: string; ids: Set<number> }> | null {
  const entries = catalog.properties.get(propertyName);
  if (!entries || !entries.length) return null;

  const groups: Array<{ name: string; ids: Set<number> }> = [];
  const covered = new Set<number>();
  for (const e of entries) {
    if (!e.elementIds.length) continue;
    const ids = new Set(e.elementIds);
    for (const id of ids) covered.add(id);
    groups.push({ name: e.value, ids });
  }
  if (!groups.length) return null;

  groups.sort((a, b) => compareStoreyNames(a.name, b.name));

  // See UNASSIGNED_STOREY_NAME: without this bucket the elements the property
  // never mentions vanish as soon as the user hides any group.
  const rest = new Set<number>();
  for (const id of catalog.categoryByElement.keys()) {
    if (!covered.has(id)) rest.add(id);
  }
  if (rest.size) groups.push({ name: UNASSIGNED_STOREY_NAME, ids: rest });

  return groups;
}
