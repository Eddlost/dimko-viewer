import { describe, expect, it } from "vitest";
import { buildGroupTree, type RawIfcGroup } from "./ifcGroups";

// Budget shaped like an estimator's IFC: section → skladba → items.
const BUDGET: RawIfcGroup[] = [
  { localId: 100, name: "1.3_32 | FASÁDA", memberIds: [101] },
  { localId: 101, name: "(001-002) | F.01 | Fasáda", memberIds: [102, 103] },
  { localId: 102, name: "001 | obklad", memberIds: [1, 2] },
  { localId: 103, name: "002 | rošt", memberIds: [2, 3] },
  { localId: 200, name: "KV | Klempířské", memberIds: [201] },
  { localId: 201, name: "001 | parapet", memberIds: [4] },
];

describe("buildGroupTree", () => {
  it("roots are groups no other group holds, in file order", () => {
    const tree = buildGroupTree(BUDGET);
    expect(tree.map((n) => n.localId)).toEqual([100, 200]);
    expect(tree[0].children.map((n) => n.localId)).toEqual([101]);
    expect(tree[0].children[0].children.map((n) => n.name)).toEqual([
      "001 | obklad",
      "002 | rošt",
    ]);
  });

  it("elements roll up to every ancestor without duplicates", () => {
    const [fasada] = buildGroupTree(BUDGET);
    expect(fasada.elementIds.sort()).toEqual([1, 2, 3]);
    expect(fasada.children[0].children[1].elementIds).toEqual([2, 3]);
  });

  it("drops empty groups and survives a cycle", () => {
    const tree = buildGroupTree([
      { localId: 1, name: "empty", memberIds: [] },
      { localId: 2, name: "a", memberIds: [3, 10] },
      { localId: 3, name: "b", memberIds: [2, 11] },
      { localId: 4, name: "root", memberIds: [2] },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["root"]);
    expect(tree[0].elementIds.sort()).toEqual([10, 11]);
  });
});
