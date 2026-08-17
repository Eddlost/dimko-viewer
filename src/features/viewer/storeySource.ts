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
// The choice is MANUAL. A scoring heuristic was tried first and did not
// survive contact with a real estimator's IFC — it ranked the wrong property
// and, worse, hid the right one behind a threshold. Guessing badly is worse
// than not guessing: the user knows which property they mean, so this module
// lists every property with the numbers needed to recognise it and stays out
// of the decision.
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

export type StoreySourceProperty = {
  /** Property name as it appears in the Pset — the value stored as the source. */
  name: string;
  /** Distinct values = how many storeys this source would produce. */
  valueCount: number;
  /** Share of the model's elements carrying the property, 0..1. */
  coverage: number;
  /** First few values in storey order, so the user can recognise the axis. */
  sample: string[];
};

/** Lowercase and strip diacritics so `Podlaží` matches `podlazi`. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Czech storey labels: `1.NP`, `2 NP`, `1.PP`. PP (podzemní podlaží) counts
 * downwards, so 1.PP sits below 1.NP and 2.PP below that.
 */
const CZ_STOREY = /^\s*(-?\d+)\s*[.,]?\s*(np|pp)\b/;
/** `Level 0`, `Etage -1`, `2. patro`. */
const WORD_AND_NUMBER =
  /(podlazi|patro|storey|story|level|floor|etage)\s*(-?\d+)|(-?\d+)\s*[.,]?\s*(podlazi|patro|storey|story|level|floor|etage)/;

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
 * Every property in the catalog, alphabetically, with what it would produce as
 * a storeys axis. No filtering and no ranking — see the header. The caller
 * shows this list and the user picks; `coverage` and `sample` are there so the
 * right one is recognisable at a glance.
 */
export function listStoreySourceProperties(
  catalog: PropertyCatalog,
): StoreySourceProperty[] {
  const total = catalog.totalElements;
  const out: StoreySourceProperty[] = [];
  for (const [name, entries] of catalog.properties) {
    if (!entries.length) continue;
    // One element can carry the same property from two Psets, so count the
    // union rather than summing the buckets.
    const covered = new Set<number>();
    for (const e of entries) for (const id of e.elementIds) covered.add(id);
    out.push({
      name,
      valueCount: entries.length,
      coverage: total ? covered.size / total : 0,
      sample: entries
        .map((e) => e.value)
        .sort(compareStoreyNames)
        .slice(0, 4),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
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
