import { describe, expect, it } from "vitest";
import {
  buildGroupTree,
  elementsOf,
  findGroups,
  type RawIfcGroup,
} from "./ifcGroups";

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

describe("findGroups", () => {
  const tree = buildGroupTree([
    { localId: 1, name: "1.3_32 | FASÁDA", memberIds: [2, 5] },
    { localId: 2, name: "(001-002) | F.01 | Provětrávaná fasáda", memberIds: [3] },
    { localId: 3, name: "001 | obklad", memberIds: [10, 11] },
    { localId: 5, name: "(003-003) | F.01a | Sokl", memberIds: [6] },
    { localId: 6, name: "003 | obklad soklu", memberIds: [12] },
    { localId: 7, name: "(205-220) | KV1 | Oplechování", memberIds: [8, 9] },
    { localId: 8, name: "205 | KV1.1; Klempířský výrobek, atika", memberIds: [20] },
    { localId: 9, name: "206 | KV1.10; Klempířský výrobek", memberIds: [21] },
  ]);
  const names = (q: string) => findGroups(tree, q).map((n) => n.localId);

  it("a code matches that code only", () => {
    expect(names("F.01")).toEqual([2]);
    expect(names("f.01a")).toEqual([5]);
    expect(names("KV1.1")).toEqual([8]);
    expect(names("KV1")).toEqual([7]);
  });

  it("falls back to text, topmost match only", () => {
    expect(names("obkl")).toEqual([3, 6]);
    // A whole token wins over text inside other names.
    expect(names("obklad")).toEqual([3]);
    expect(names("fasáda")).toEqual([1]);
    expect(names("  ")).toEqual([]);
    expect(names("nic takového")).toEqual([]);
  });

  it("elementsOf unions without duplicates", () => {
    expect(elementsOf(findGroups(tree, "KV1")).sort()).toEqual([20, 21]);
    expect(elementsOf([...findGroups(tree, "F.01"), ...findGroups(tree, "F.01")])).toEqual([10, 11]);
  });
});
