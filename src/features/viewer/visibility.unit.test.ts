import { describe, it, expect } from "vitest";
import {
  computeVisibleIds,
  chooseSnapshotMode,
  filterSelectionBySnapshot,
  type Groups,
} from "./visibility";

const M = "model-A";

function groups(): Groups {
  return {
    storeys: [
      { name: "1NP", items: { [M]: new Set([1, 2, 3]) } },
      { name: "2NP", items: { [M]: new Set([4, 5, 6]) } },
    ],
    categories: [
      { name: "IFCSLAB", items: { [M]: new Set([1, 4]) } },
      { name: "IFCSPACE", items: { [M]: new Set([3, 6]) } },
    ],
  };
}

describe("computeVisibleIds", () => {
  it("nothing hidden, no root → unrestricted", () => {
    const r = computeVisibleIds(M, groups(), new Set(), null);
    expect(r.restricted).toBe(false);
    expect(r.visibleIds.size).toBe(0);
  });

  it("hides a storey → its ids drop out", () => {
    const r = computeVisibleIds(M, groups(), new Set(["stor:2NP"]), null);
    expect(r.restricted).toBe(true);
    expect([...r.visibleIds].sort()).toEqual([1, 2, 3]);
  });

  it("hides a category → removes those ids across visible storeys", () => {
    // Hide IFCSPACE (3,6). Visible storeys = both → {1..6} minus {3,6}.
    const r = computeVisibleIds(M, groups(), new Set(["cat:IFCSPACE"]), null);
    expect([...r.visibleIds].sort()).toEqual([1, 2, 4, 5]);
  });

  it("storey + category hide compose", () => {
    const r = computeVisibleIds(
      M,
      groups(),
      new Set(["stor:2NP", "cat:IFCSPACE"]),
      null,
    );
    // 1NP {1,2,3} minus IFCSPACE {3} → {1,2}
    expect([...r.visibleIds].sort()).toEqual([1, 2]);
  });

  it("isolation root with no tree hiding → visible = root", () => {
    const r = computeVisibleIds(M, groups(), new Set(), new Set([2, 5]));
    expect(r.restricted).toBe(true);
    expect([...r.visibleIds].sort()).toEqual([2, 5]);
  });

  it("intersects tree visibility with isolation root", () => {
    // Hide 2NP → {1,2,3}; root {2,3,4} → intersection {2,3}.
    const r = computeVisibleIds(
      M,
      groups(),
      new Set(["stor:2NP"]),
      new Set([2, 3, 4]),
    );
    expect([...r.visibleIds].sort()).toEqual([2, 3]);
  });

  it("only this model's ids are returned (multi-model isolation)", () => {
    const g = groups();
    g.storeys[0].items["model-B"] = new Set([100, 200]);
    const r = computeVisibleIds(M, g, new Set(["stor:2NP"]), null);
    expect([...r.visibleIds]).not.toContain(100);
  });

  it("hides a budget item → removes its ids (subtractive, like categories)", () => {
    const g = groups();
    g.budget = [
      { name: "01 | malba", items: { [M]: new Set([1, 4]) } },
      { name: "02 | penetrace", items: { [M]: new Set([2, 5]) } },
    ];
    const r = computeVisibleIds(M, g, new Set(["bud:01 | malba"]), null);
    expect(r.restricted).toBe(true);
    expect([...r.visibleIds].sort()).toEqual([2, 3, 5, 6]);
  });

  it("budget + storey hide compose", () => {
    const g = groups();
    g.budget = [{ name: "01 | malba", items: { [M]: new Set([1, 4]) } }];
    const r = computeVisibleIds(
      M,
      g,
      new Set(["stor:2NP", "bud:01 | malba"]),
      null,
    );
    // 1NP {1,2,3} minus budget {1,4} → {2,3}
    expect([...r.visibleIds].sort()).toEqual([2, 3]);
  });

  it("hides a budget section via budsec: prefix (not confused with bud:)", () => {
    const g = groups();
    g.budget = [{ name: "X", items: { [M]: new Set([1]) } }];
    g.budgetSections = [
      { name: "1.3_38 | VNITŘNÍ DVEŘE", items: { [M]: new Set([2, 5]) } },
    ];
    const r = computeVisibleIds(
      M,
      g,
      new Set(["budsec:1.3_38 | VNITŘNÍ DVEŘE"]),
      null,
    );
    // Sekce {2,5} pryč; položka X (id 1) zůstává — prefixy se nesmí splést.
    expect([...r.visibleIds].sort()).toEqual([1, 3, 4, 6]);
  });

  it("overlapping budget items: hiding one removes shared ids too", () => {
    // Stejný povrch může nést víc položek (malba + penetrace). Skrytí
    // jedné položky element odstraní — subtraktivní sémantika.
    const g = groups();
    g.budget = [
      { name: "01 | malba", items: { [M]: new Set([1, 2]) } },
      { name: "02 | penetrace", items: { [M]: new Set([2, 3]) } },
    ];
    const r = computeVisibleIds(M, g, new Set(["bud:02 | penetrace"]), null);
    expect([...r.visibleIds].sort()).toEqual([1, 4, 5, 6]);
  });
});

describe("chooseSnapshotMode", () => {
  it("whole model hidden", () => {
    expect(chooseSnapshotMode(M, [], [], true)).toEqual({
      modelId: M,
      mode: "hidden",
      visibleIds: [],
    });
  });
  it("nothing hidden → all", () => {
    expect(chooseSnapshotMode(M, [1, 2, 3], [], false).mode).toBe("all");
  });
  it("few hidden of many → partial-hidden (stores the lean list)", () => {
    const e = chooseSnapshotMode(M, [1, 2, 3, 4, 5, 6, 7], [8, 9], false);
    expect(e.mode).toBe("partial-hidden");
    expect(e.hiddenIds).toEqual([8, 9]);
    expect(e.visibleIds).toEqual([]);
  });
  it("most hidden → partial (stores visible)", () => {
    const e = chooseSnapshotMode(M, [1], [2, 3, 4, 5], false);
    expect(e.mode).toBe("partial");
    expect(e.visibleIds).toEqual([1]);
  });
});

describe("filterSelectionBySnapshot", () => {
  const sel = [{ modelId: M, localIds: [1, 2, 3] }];

  it("all mode → selection untouched", () => {
    expect(
      filterSelectionBySnapshot(sel, [{ modelId: M, mode: "all", visibleIds: [] }]),
    ).toEqual(sel);
  });
  it("hidden model → selection dropped", () => {
    expect(
      filterSelectionBySnapshot(sel, [{ modelId: M, mode: "hidden", visibleIds: [] }]),
    ).toEqual([]);
  });
  it("partial → keeps only visible ids", () => {
    const out = filterSelectionBySnapshot(sel, [
      { modelId: M, mode: "partial", visibleIds: [2] },
    ]);
    expect(out).toEqual([{ modelId: M, localIds: [2] }]);
  });
  it("partial-hidden → drops hidden ids", () => {
    const out = filterSelectionBySnapshot(sel, [
      { modelId: M, mode: "partial-hidden", visibleIds: [], hiddenIds: [2] },
    ]);
    expect(out).toEqual([{ modelId: M, localIds: [1, 3] }]);
  });
  it("model not in snapshot → kept as-is", () => {
    expect(filterSelectionBySnapshot(sel, [])).toEqual(sel);
  });
});
