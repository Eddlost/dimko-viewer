// Property catalog: walks geometry-bearing elements once, extracts their Psets
// via IsDefinedBy → HasProperties tree, and stores the result as
// (propertyName -> value -> elementLocalIds[]). Slow to build (~minutes for
// a few thousand elements), but persisted to disk and reused on every reload.
// Click-to-highlight is then a direct lookup.

const CHUNK_SIZE = 100;

// Categories to SKIP when collecting the "element universe" to walk. Everything
// else starting with IFC is treated as a real building element (walls, slabs,
// spaces, beams, etc.). Spatial roots (IFCPROJECT/SITE/BUILDING/STOREY/SPACE)
// are kept — IFCSPACE in particular carries the wedge property (Skladba podlahy).
const NON_ELEMENT_PATTERNS: RegExp[] = [
  /^IFCPROPERTY/,
  /^IFCREL/,
  // Rozpočtové skupiny mají vlastní osu (features/budget); v katalogu by jen
  // přidávaly ne-geometrické items bez psetů.
  /^IFCGROUP$/,
  /^IFCQUANTITY/,
  /^IFCPHYSICALSIMPLEQUANTITY/,
  /^IFCELEMENTQUANTITY/,
  /^IFCOWNERHISTORY$/,
  /^IFCORGANIZATION$/,
  /^IFCPERSON/,
  /^IFCAPPLICATION$/,
  /^IFCUNIT/,
  /^IFCSIUNIT$/,
  /^IFCMEASUREWITHUNIT$/,
  /^IFCDERIVEDUNIT/,
  /^IFCMONETARY/,
  /^IFCGEOMETRICREPRESENTATIONCONTEXT$/,
  /^IFCGEOMETRICREPRESENTATIONSUBCONTEXT$/,
  /^IFCREPRESENTATION/,
  /^IFCSHAPEREPRESENTATION$/,
  /^IFCSHAPEASPECT$/,
  /^IFCPRODUCTDEFINITIONSHAPE$/,
  /^IFCAXIS2PLACEMENT/,
  /^IFCLOCALPLACEMENT$/,
  /^IFCCARTESIAN/,
  /^IFCDIRECTION$/,
  /^IFCVECTOR$/,
  /^IFCPOLYLINE$/,
  /^IFCPOLYLOOP$/,
  /^IFCFACE/,
  /^IFCMATERIAL/,
  /^IFCPRESENTATIONLAYER/,
  /^IFCSTYLE/,
  /^IFCSURFACESTYLE/,
  /^IFCCURVESTYLE/,
  /^IFCFILLAREASTYLE/,
  /^IFCCOLOURRGB$/,
  /^IFCBOUNDARYCONDITION/,
  /^IFCCLASSIFICATIONREFERENCE$/,
  /^IFCCLASSIFICATION$/,
  /^IFCEXTRUDED/,
  /^IFCMAPPEDITEM$/,
  /^IFCBOOLEANCLIPPINGRESULT$/,
  /^IFCBOOLEANRESULT$/,
  /^IFCHALFSPACE/,
  /^IFCPLANE$/,
  /^IFCCONNECTION/,
  /^IFCPROJECTLIBRARY$/,
];

function isElementCategory(category: string): boolean {
  const up = category.toUpperCase();
  if (!up.startsWith("IFC")) return false;
  for (const p of NON_ELEMENT_PATTERNS) {
    if (p.test(up)) return false;
  }
  return true;
}

export type ValueEntry = {
  value: string;
  // Building element localIds (geometry-bearing items) that carry a Pset
  // property whose Name and NominalValue equal the parent (propName, value).
  elementIds: number[];
};

export type PropertyCatalog = {
  modelId: string;
  totalElements: number;
  // property name -> values
  properties: Map<string, ValueEntry[]>;
  // elementId -> IFC category (e.g. "IFCSPACE", "IFCSLAB"). Captured during
  // the same walk that builds `properties`, so the cost is negligible.
  categoryByElement: Map<number, string>;
};

export type MergedCatalog = {
  // property name -> value -> modelId -> elementIds (Set for dedupe + highlight)
  flat: Map<string, Map<string, Map<string, Set<number>>>>;
  perModelTotals: Map<string, number>;
  // modelId -> (elementId -> category)
  categoryByElement: Map<string, Map<number, string>>;
};

export type BuildProgress = {
  phase: "scan" | "done";
  modelId: string;
  done: number;
  total: number;
};

export type BuildOptions = {
  onProgress?: (p: BuildProgress) => void;
  signal?: AbortSignal;
};

function attrToString(a: any): string | null {
  if (a === null || a === undefined) return null;
  if (typeof a === "object") {
    if ("value" in a) {
      const v = a.value;
      if (v === null || v === undefined) return null;
      return String(v);
    }
    return null;
  }
  return String(a);
}

function collectPsetProperties(pset: any): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const push = (nameAttr: any, valueAttr: any) => {
    const name = attrToString(nameAttr);
    const value = attrToString(valueAttr);
    if (!name) return;
    if (value === null) return;
    out.push([name, value]);
  };

  if (Array.isArray(pset.HasProperties)) {
    for (const p of pset.HasProperties) {
      push(p?.Name, p?.NominalValue ?? p?.Value);
    }
  } else {
    for (const v of Object.values(pset)) {
      if (!Array.isArray(v)) continue;
      for (const item of v as any[]) {
        if (
          item &&
          typeof item === "object" &&
          "Name" in item &&
          ("NominalValue" in item || "Value" in item)
        ) {
          push(item.Name, item.NominalValue ?? item.Value);
        }
      }
    }
  }
  return out;
}

export async function buildPropertyCatalog(
  model: any,
  options: BuildOptions = {},
): Promise<PropertyCatalog> {
  const modelId: string = model?.modelId ?? model?.id ?? "unknown";

  // Element universe = items of real building element categories. Filters out
  // psets, relations, geometry refs, materials, etc. — without that filter
  // getItemsIdsWithGeometry returns ~50k geometry items (extrusions, mapped
  // items, etc.) which carry no Psets.
  const elementIds: number[] = [];
  const categoryByElement = new Map<number, string>();
  const keptCats: Array<{ name: string; count: number }> = [];
  const droppedCats: Array<{ name: string; count: number }> = [];
  try {
    const byCat: Record<string, number[]> = await model.getItemsOfCategories([
      /^IFC.+/,
    ]);
    for (const [cat, ids] of Object.entries(byCat)) {
      if (isElementCategory(cat)) {
        keptCats.push({ name: cat, count: ids.length });
        for (const id of ids) {
          elementIds.push(id);
          categoryByElement.set(id, cat);
        }
      } else {
        droppedCats.push({ name: cat, count: ids.length });
      }
    }
  } catch (e) {
    console.error(`[catalog] ${modelId} getItemsOfCategories failed`, e);
  }
  keptCats.sort((a, b) => b.count - a.count);
  droppedCats.sort((a, b) => b.count - a.count);
  console.log(
    `[catalog] ${modelId}: ${elementIds.length} elements across ${keptCats.length} kept categories`,
  );
  console.log(
    `[catalog] ${modelId} TOP kept:`,
    keptCats.slice(0, 10).map((c) => `${c.name}=${c.count}`).join(", "),
  );
  console.log(
    `[catalog] ${modelId} TOP dropped:`,
    droppedCats.slice(0, 10).map((c) => `${c.name}=${c.count}`).join(", "),
  );

  // propName -> value -> Set<elementId>
  const buckets = new Map<string, Map<string, Set<number>>>();

  const insert = (name: string, value: string, elId: number) => {
    let valMap = buckets.get(name);
    if (!valMap) {
      valMap = new Map();
      buckets.set(name, valMap);
    }
    let set = valMap.get(value);
    if (!set) {
      set = new Set();
      valMap.set(value, set);
    }
    set.add(elId);
  };

  const total = elementIds.length;
  options.onProgress?.({ phase: "scan", modelId, done: 0, total });

  let sampleLogged = false;
  let psetCount = 0;
  for (let i = 0; i < elementIds.length; i += CHUNK_SIZE) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const chunk = elementIds.slice(i, i + CHUNK_SIZE);
    const label = `[catalog] ${modelId} chunk ${i}-${i + chunk.length}`;
    console.time(label);
    let data: any[] = [];
    try {
      data = await model.getItemsData(chunk, {
        attributesDefault: true,
        relations: {
          IsDefinedBy: { attributes: true, relations: true },
        },
        relationsDefault: { attributes: false, relations: false },
      });
    } catch (e) {
      console.error(`${label} failed`, e);
      console.timeEnd(label);
      continue;
    }
    console.timeEnd(label);

    for (let k = 0; k < data.length; k++) {
      const item = data[k];
      const elId = chunk[k];
      if (!item) continue;
      const psets = item.IsDefinedBy;
      if (!Array.isArray(psets) || psets.length === 0) continue;
      if (!sampleLogged) {
        console.log(
          `[catalog] ${modelId} SAMPLE element ${elId}: keys=${Object.keys(item).join(",")} psetCount=${psets.length}`,
        );
        const p0 = psets[0];
        if (p0) {
          console.log(
            `[catalog] ${modelId} SAMPLE pset[0] keys=${Object.keys(p0).join(",")}`,
          );
        }
        sampleLogged = true;
      }
      psetCount++;
      for (const p of psets) {
        for (const [name, value] of collectPsetProperties(p)) {
          insert(name, value, elId);
        }
      }
    }
    options.onProgress?.({
      phase: "scan",
      modelId,
      done: Math.min(i + CHUNK_SIZE, total),
      total,
    });
  }

  // Convert to final ValueEntry[] shape.
  const properties = new Map<string, ValueEntry[]>();
  for (const [name, valMap] of buckets) {
    const entries: ValueEntry[] = [];
    for (const [value, set] of valMap) {
      entries.push({ value, elementIds: Array.from(set) });
    }
    properties.set(name, entries);
  }

  options.onProgress?.({ phase: "done", modelId, done: total, total });
  console.log(
    `[catalog] ${modelId}: built ${properties.size} properties from ${total} elements (${psetCount} had Psets)`,
  );

  return { modelId, totalElements: total, properties, categoryByElement };
}

export function mergeCatalogs(catalogs: PropertyCatalog[]): MergedCatalog {
  const flat: MergedCatalog["flat"] = new Map();
  const perModelTotals = new Map<string, number>();
  const categoryByElement = new Map<string, Map<number, string>>();

  for (const cat of catalogs) {
    perModelTotals.set(cat.modelId, cat.totalElements);
    categoryByElement.set(cat.modelId, cat.categoryByElement);
    for (const [propName, values] of cat.properties) {
      let propMap = flat.get(propName);
      if (!propMap) {
        propMap = new Map();
        flat.set(propName, propMap);
      }
      for (const entry of values) {
        let valMap = propMap.get(entry.value);
        if (!valMap) {
          valMap = new Map();
          propMap.set(entry.value, valMap);
        }
        let set = valMap.get(cat.modelId);
        if (!set) {
          set = new Set();
          valMap.set(cat.modelId, set);
        }
        for (const id of entry.elementIds) set.add(id);
      }
    }
  }

  return { flat, perModelTotals, categoryByElement };
}

// ──────────────────────────────────────────────────────────────────────────────
// Serialization (disk persistence). Version 2 = elementIds (was 1 = propertyItemIds).
// ──────────────────────────────────────────────────────────────────────────────

const CATALOG_VERSION = 4;

type SerializedCatalog = {
  v: typeof CATALOG_VERSION;
  modelId: string;
  totalElements: number;
  properties: Array<{
    name: string;
    values: Array<{ value: string; ids: number[] }>;
  }>;
  categories: Array<{ category: string; ids: number[] }>;
};

export function serializeCatalog(c: PropertyCatalog): string {
  const props: SerializedCatalog["properties"] = [];
  for (const [name, values] of c.properties) {
    props.push({
      name,
      values: values.map((v) => ({ value: v.value, ids: v.elementIds })),
    });
  }
  const byCategory = new Map<string, number[]>();
  for (const [id, cat] of c.categoryByElement) {
    let arr = byCategory.get(cat);
    if (!arr) {
      arr = [];
      byCategory.set(cat, arr);
    }
    arr.push(id);
  }
  const categories: SerializedCatalog["categories"] = [];
  for (const [category, ids] of byCategory) categories.push({ category, ids });
  const out: SerializedCatalog = {
    v: CATALOG_VERSION,
    modelId: c.modelId,
    totalElements: c.totalElements,
    properties: props,
    categories,
  };
  return JSON.stringify(out);
}

export function deserializeCatalog(json: string): PropertyCatalog | null {
  let parsed: SerializedCatalog;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed?.v !== CATALOG_VERSION) return null;
  const properties = new Map<string, ValueEntry[]>();
  for (const entry of parsed.properties ?? []) {
    properties.set(
      entry.name,
      (entry.values ?? []).map((v) => ({ value: v.value, elementIds: v.ids })),
    );
  }
  const categoryByElement = new Map<number, string>();
  for (const entry of parsed.categories ?? []) {
    for (const id of entry.ids) categoryByElement.set(id, entry.category);
  }
  return {
    modelId: parsed.modelId,
    totalElements: parsed.totalElements ?? 0,
    properties,
    categoryByElement,
  };
}

// Backward-compat type aliases (some imports may still reference these names).
export type PropertyIndex = PropertyCatalog;
export type MergedPropertyIndex = MergedCatalog;
export const buildPropertyIndex = buildPropertyCatalog;
export const mergeIndexes = mergeCatalogs;
