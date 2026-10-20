// ────────────────────────────────────────────────────────────────────────────
// IfcGroup hierarchy → tree.
//
// Groups are how an IFC carries a classification that is neither spatial nor
// by class: a cost estimator's budget (section → part → item, each item a
// group of elements), systems, zones. A group's members are elements or other
// groups, so the tree is read off the membership itself — a group nested in
// no other group is a root. Pure, so it is testable without a model.
// ────────────────────────────────────────────────────────────────────────────

export type RawIfcGroup = {
  localId: number;
  name: string;
  /** Direct members: element localIds and nested group localIds alike. */
  memberIds: number[];
};

export type GroupNode = {
  localId: number;
  name: string;
  children: GroupNode[];
  /** Every element under this group, nested groups expanded, no duplicates. */
  elementIds: number[];
};

/**
 * Roots and children keep the order the groups came in (file order), which
 * for an estimator's IFC is the order of the budget. A group reachable twice
 * appears under each parent; a cycle is cut where it closes.
 */
export function buildGroupTree(groups: RawIfcGroup[]): GroupNode[] {
  const byId = new Map(groups.map((g) => [g.localId, g]));
  const nested = new Set<number>();
  for (const g of groups)
    for (const m of g.memberIds) if (byId.has(m)) nested.add(m);

  const build = (g: RawIfcGroup, path: Set<number>): GroupNode => {
    const inner = new Set(path).add(g.localId);
    const children: GroupNode[] = [];
    const elements = new Set<number>();
    for (const m of g.memberIds) {
      const sub = byId.get(m);
      if (!sub) {
        elements.add(m);
        continue;
      }
      if (inner.has(m)) continue;
      const child = build(sub, inner);
      children.push(child);
      for (const id of child.elementIds) elements.add(id);
    }
    return {
      localId: g.localId,
      name: g.name,
      children,
      elementIds: [...elements],
    };
  };

  return groups
    .filter((g) => !nested.has(g.localId))
    .map((g) => build(g, new Set()))
    .filter((n) => n.elementIds.length > 0);
}
