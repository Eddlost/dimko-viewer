// Pure visibility math shared by the spatial tree and saved-view snapshots.
// Deliberately free of React / @thatopen runtime imports so it unit-tests in
// a plain node environment — this is where the storey/category filter bugs
// lived, and where regressions are cheapest to catch.

export type IdList = Set<number> | number[];
// Items are always Sets at runtime (matches @thatopen ModelIdMap); the
// helpers stay array-tolerant defensively, but the stored type is Set-only
// so this is assignable to OBC.ModelIdMap without friction.
export type ModelIdMap = Record<string, Set<number>>;
export type Group = { name: string; items: ModelIdMap };
export type Groups = {
  storeys: Group[];
  categories: Group[];
  /** Rozpočtové položky (IFCGROUP) — subtraktivní osa jako categories. */
  budget?: Group[];
  /** Oddíly/díly rozpočtu (transitivně rozbalené na elementy) — subtraktivní. */
  budgetSections?: Group[];
};

export type VisibilityMode = "all" | "hidden" | "partial" | "partial-hidden";
export type VisibilitySnapshotEntry = {
  modelId: string;
  mode: VisibilityMode;
  visibleIds: number[];
  hiddenIds?: number[];
};

function addIds(target: Set<number>, ids: IdList | undefined) {
  if (!ids) return;
  if (ids instanceof Set) ids.forEach((i) => target.add(i));
  else ids.forEach((i) => target.add(i));
}

function removeIds(target: Set<number>, ids: IdList | undefined) {
  if (!ids) return;
  if (ids instanceof Set) ids.forEach((i) => target.delete(i));
  else ids.forEach((i) => target.delete(i));
}

/**
 * Visible element id set for a model given hidden storey/category/budget keys
 * (`stor:Name` / `cat:Name` / `bud:Name`) and an optional isolation root. `restricted`
 * false ⇒ nothing constrains the model (caller should show all).
 */
export function computeVisibleIds(
  modelId: string,
  groups: Groups,
  hidden: Set<string>,
  root: Set<number> | null,
): { restricted: boolean; visibleIds: Set<number> } {
  const hiddenStoreyNames = new Set<string>();
  const hiddenCatNames = new Set<string>();
  const hiddenBudgetNames = new Set<string>();
  const hiddenSectionNames = new Set<string>();
  for (const k of hidden) {
    if (k.startsWith("stor:")) hiddenStoreyNames.add(k.slice(5));
    else if (k.startsWith("cat:")) hiddenCatNames.add(k.slice(4));
    // Pozor na pořadí — "budsec:" má prefix "bud" jen zdánlivě; testovat dřív.
    else if (k.startsWith("budsec:")) hiddenSectionNames.add(k.slice(7));
    else if (k.startsWith("bud:")) hiddenBudgetNames.add(k.slice(4));
  }
  const hasHidden =
    hiddenStoreyNames.size > 0 ||
    hiddenCatNames.size > 0 ||
    hiddenBudgetNames.size > 0 ||
    hiddenSectionNames.size > 0;
  const hasRoot = root !== null && root.size > 0;

  if (!hasHidden && !hasRoot) {
    return { restricted: false, visibleIds: new Set() };
  }
  if (!hasHidden && hasRoot) {
    return { restricted: true, visibleIds: new Set(root!) };
  }

  const visibleIds = new Set<number>();
  if (groups.storeys.length > 0) {
    for (const s of groups.storeys) {
      if (hiddenStoreyNames.has(s.name)) continue;
      addIds(visibleIds, s.items[modelId]);
    }
  } else {
    for (const c of groups.categories) addIds(visibleIds, c.items[modelId]);
  }
  for (const c of groups.categories) {
    if (!hiddenCatNames.has(c.name)) continue;
    removeIds(visibleIds, c.items[modelId]);
  }
  for (const b of groups.budget ?? []) {
    if (!hiddenBudgetNames.has(b.name)) continue;
    removeIds(visibleIds, b.items[modelId]);
  }
  for (const s of groups.budgetSections ?? []) {
    if (!hiddenSectionNames.has(s.name)) continue;
    removeIds(visibleIds, s.items[modelId]);
  }

  if (hasRoot) {
    for (const id of Array.from(visibleIds)) {
      if (!root!.has(id)) visibleIds.delete(id);
    }
  }
  return { restricted: true, visibleIds };
}

/**
 * Pick the leaner of {visible, hidden} id lists for one model so a saved
 * snapshot never persists 99 997 ids to hide 3 elements.
 */
export function chooseSnapshotMode(
  modelId: string,
  visible: number[],
  hidden: number[],
  modelHidden: boolean,
): VisibilitySnapshotEntry {
  if (modelHidden) return { modelId, mode: "hidden", visibleIds: [] };
  if (!hidden.length) return { modelId, mode: "all", visibleIds: [] };
  if (hidden.length <= visible.length) {
    return { modelId, mode: "partial-hidden", visibleIds: [], hiddenIds: hidden };
  }
  return { modelId, mode: "partial", visibleIds: visible };
}

/**
 * Drop selected ids that are invisible in the given snapshot, so saving a
 * view after "select → hide" never persists the hidden selection.
 */
export function filterSelectionBySnapshot(
  selection: Array<{ modelId: string; localIds: number[] }>,
  snapshot: VisibilitySnapshotEntry[],
): Array<{ modelId: string; localIds: number[] }> {
  const byModel = new Map(snapshot.map((s) => [s.modelId, s]));
  const out: Array<{ modelId: string; localIds: number[] }> = [];
  for (const s of selection) {
    const entry = byModel.get(s.modelId);
    if (!entry || entry.mode === "all") {
      out.push(s);
      continue;
    }
    if (entry.mode === "hidden") continue;
    if (entry.mode === "partial-hidden") {
      const hiddenSet = new Set(entry.hiddenIds ?? []);
      const kept = s.localIds.filter((id) => !hiddenSet.has(id));
      if (kept.length) out.push({ modelId: s.modelId, localIds: kept });
      continue;
    }
    const visible = new Set(entry.visibleIds);
    const kept = s.localIds.filter((id) => visible.has(id));
    if (kept.length) out.push({ modelId: s.modelId, localIds: kept });
  }
  return out;
}
