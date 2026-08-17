import { describe, expect, it } from "vitest";
import type { PropertyCatalog, ValueEntry } from "../properties/propertyIndex";
import {
  UNASSIGNED_STOREY_NAME,
  compareStoreyNames,
  listStoreySourceProperties,
  storeyRank,
  storeysFromCatalog,
} from "./storeySource";

function catalog(
  props: Record<string, Record<string, number[]>>,
  totalElements: number,
  allElementIds?: number[],
): PropertyCatalog {
  const properties = new Map<string, ValueEntry[]>();
  for (const [name, values] of Object.entries(props)) {
    properties.set(
      name,
      Object.entries(values).map(([value, elementIds]) => ({
        value,
        elementIds,
      })),
    );
  }
  const universe =
    allElementIds ?? Array.from({ length: totalElements }, (_, i) => i + 1);
  const categoryByElement = new Map<number, string>(
    universe.map((id) => [id, "IFCWALL"] as const),
  );
  return { modelId: "m1", totalElements, properties, categoryByElement };
}

describe("storeyRank", () => {
  it("reads Czech storey labels, basements negative", () => {
    expect(storeyRank("1.NP")).toBe(1);
    expect(storeyRank("2 NP")).toBe(2);
    expect(storeyRank("1.PP")).toBe(-1);
    expect(storeyRank("2.PP")).toBe(-2);
  });

  it("handles diacritics and word forms", () => {
    expect(storeyRank("2. podlaží")).toBe(2);
    expect(storeyRank("Level -1")).toBe(-1);
  });

  it("falls back to a leading number", () => {
    expect(storeyRank("0 - Přízemí")).toBe(0);
  });

  it("returns null when there is nothing to sort by", () => {
    expect(storeyRank("Střecha")).toBeNull();
    expect(storeyRank("")).toBeNull();
  });
});

describe("compareStoreyNames", () => {
  it("stacks the building bottom-up", () => {
    const sorted = ["2.NP", "1.PP", "1.NP", "2.PP"].sort(compareStoreyNames);
    expect(sorted).toEqual(["2.PP", "1.PP", "1.NP", "2.NP"]);
  });

  it("sorts numerically, not alphabetically", () => {
    const sorted = ["10.NP", "2.NP", "1.NP"].sort(compareStoreyNames);
    expect(sorted).toEqual(["1.NP", "2.NP", "10.NP"]);
  });

  it("puts unparseable names after numbered storeys", () => {
    const sorted = ["Střecha", "1.NP", "Základy"].sort(compareStoreyNames);
    expect(sorted[0]).toBe("1.NP");
    expect(sorted.slice(1)).toEqual(["Střecha", "Základy"]);
  });

  it("pins the unassigned bucket last", () => {
    const sorted = [UNASSIGNED_STOREY_NAME, "Střecha", "1.NP"].sort(
      compareStoreyNames,
    );
    expect(sorted[sorted.length - 1]).toBe(UNASSIGNED_STOREY_NAME);
  });
});

describe("listStoreySourceProperties", () => {
  it("lists every property, alphabetically, with no filtering", () => {
    const c = catalog(
      {
        rubim_podlazi: { "1.PP": [1, 2], "1.NP": [3, 4], "2.NP": [5, 6] },
        Dodavatel: { Alfa: [1, 2, 3], Beta: [4, 5, 6] },
        // Jednohodnotová i "moc hodnot" musí zůstat — volba je na userovi.
        Nosne: { ano: [1, 2, 3, 4, 5, 6] },
      },
      6,
    );
    expect(listStoreySourceProperties(c).map((p) => p.name)).toEqual([
      "Dodavatel",
      "Nosne",
      "rubim_podlazi",
    ]);
  });

  it("reports value count and coverage so the right one is recognisable", () => {
    const c = catalog({ podlazi: { "1.NP": [1, 2], "2.NP": [3] } }, 6);
    const [p] = listStoreySourceProperties(c);
    expect(p.valueCount).toBe(2);
    expect(p.coverage).toBeCloseTo(0.5);
  });

  it("counts an element once when two Psets carry the same property", () => {
    const c = catalog({ podlazi: { "1.NP": [1, 2], "2.NP": [2, 3] } }, 3);
    expect(listStoreySourceProperties(c)[0].coverage).toBe(1);
  });

  it("shows the sample values in storey order", () => {
    const c = catalog({ podlazi: { "2.NP": [3], "1.PP": [1], "1.NP": [2] } }, 3);
    expect(listStoreySourceProperties(c)[0].sample).toEqual([
      "1.PP",
      "1.NP",
      "2.NP",
    ]);
  });

  it("skips a property with no values at all", () => {
    const c = catalog({ prazdna: {}, podlazi: { "1.NP": [1] } }, 1);
    expect(listStoreySourceProperties(c).map((p) => p.name)).toEqual([
      "podlazi",
    ]);
  });

  it("reports zero coverage instead of dividing by zero on an empty model", () => {
    const c = catalog({ podlazi: { "1.NP": [1] } }, 0, []);
    expect(listStoreySourceProperties(c)[0].coverage).toBe(0);
  });
});

describe("storeysFromCatalog", () => {
  it("builds groups in storey order", () => {
    const c = catalog(
      { podlazi: { "2.NP": [5, 6], "1.NP": [3, 4], "1.PP": [1, 2] } },
      6,
    );
    const groups = storeysFromCatalog(c, "podlazi");
    expect(groups?.map((g) => g.name)).toEqual(["1.PP", "1.NP", "2.NP"]);
    expect(groups?.[0].ids).toEqual(new Set([1, 2]));
  });

  it("collects elements the property never mentions into one bucket", () => {
    // Universe is 1..6, the property only covers 1..4.
    const c = catalog({ podlazi: { "1.NP": [1, 2], "2.NP": [3, 4] } }, 6);
    const groups = storeysFromCatalog(c, "podlazi");
    const last = groups![groups!.length - 1];
    expect(last.name).toBe(UNASSIGNED_STOREY_NAME);
    expect(last.ids).toEqual(new Set([5, 6]));
  });

  it("omits the bucket when the property covers everything", () => {
    const c = catalog({ podlazi: { "1.NP": [1, 2], "2.NP": [3, 4] } }, 4);
    const names = storeysFromCatalog(c, "podlazi")!.map((g) => g.name);
    expect(names).not.toContain(UNASSIGNED_STOREY_NAME);
  });

  it("returns null for an unknown property so the caller can fall back", () => {
    const c = catalog({ podlazi: { "1.NP": [1] } }, 1);
    expect(storeysFromCatalog(c, "neexistuje")).toBeNull();
  });

  it("returns null when every value is empty", () => {
    const c = catalog({ podlazi: { "1.NP": [], "2.NP": [] } }, 4);
    expect(storeysFromCatalog(c, "podlazi")).toBeNull();
  });
});
