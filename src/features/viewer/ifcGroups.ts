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

// Estimators name groups "205 | KV1.1; Klempířský výrobek…" or
// "(001-005) | F.01 | Provětrávaná fasáda…": codes sit between `|` and `;`.
const TOKEN_SPLIT = /[|;]/;

const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Groups a search names, topmost first — a match's subgroups are not listed
 * again, its elements already cover them. A query equal to a whole code
 * ("F.01", "KV1.1") matches only that code, never "F.01a" or "KV1.10"; only
 * when no group has the code does it fall back to any name containing the
 * text.
 */
export function findGroups(tree: GroupNode[], query: string): GroupNode[] {
  const q = normalize(query);
  if (!q) return [];
  const collect = (test: (n: GroupNode) => boolean) => {
    const out: GroupNode[] = [];
    const seen = new Set<number>();
    const walk = (n: GroupNode) => {
      if (test(n)) {
        if (!seen.has(n.localId)) out.push(n);
        seen.add(n.localId);
        return;
      }
      n.children.forEach(walk);
    };
    tree.forEach(walk);
    return out;
  };
  const exact = collect((n) => n.name.split(TOKEN_SPLIT).some((t) => normalize(t) === q));
  return exact.length ? exact : collect((n) => normalize(n.name).includes(q));
}

/** Every element under any of the groups, once. */
export function elementsOf(nodes: GroupNode[]): number[] {
  const ids = new Set<number>();
  for (const n of nodes) for (const id of n.elementIds) ids.add(id);
  return [...ids];
}
