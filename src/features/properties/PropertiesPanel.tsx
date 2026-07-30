import { useEffect, useState } from "react";
import { useViewerContext } from "../viewer/ViewerContext";

type Row = { label: string; value: string };
type Section = { title: string; rows: Row[] };

/** Fragments wraps scalars as `{ value: … }`; anything else is skipped. */
function scalar(input: any): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "object") {
    if ("value" in input) return scalar(input.value);
    return null;
  }
  if (typeof input === "boolean") return input ? "true" : "false";
  const text = String(input);
  return text.trim() ? text : null;
}

function toRows(source: any): Row[] {
  if (!source || typeof source !== "object") return [];
  const rows: Row[] = [];
  for (const [key, raw] of Object.entries(source)) {
    if (key.startsWith("_")) continue;
    const value = scalar(raw);
    if (value !== null) rows.push({ label: key, value });
  }
  return rows;
}

/**
 * Property sets hang off `IsDefinedBy`, each with its own `HasProperties`
 * list. Flatten them into one section per pset.
 */
function psetSections(data: any): Section[] {
  const defined = data?.IsDefinedBy;
  if (!Array.isArray(defined)) return [];
  const out: Section[] = [];
  for (const pset of defined) {
    const title = scalar(pset?.Name) ?? "Property set";
    const props = pset?.HasProperties;
    const rows: Row[] = [];
    if (Array.isArray(props)) {
      for (const prop of props) {
        const label = scalar(prop?.Name);
        const value = scalar(prop?.NominalValue);
        if (label && value !== null) rows.push({ label, value });
      }
    }
    if (rows.length) out.push({ title, rows });
  }
  return out;
}

export function PropertiesPanel() {
  const { selection, getItemData, getMeshParts, models } = useViewerContext();
  const [sections, setSections] = useState<Section[]>([]);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!selection) {
      setSections([]);
      setTitle(null);
      return;
    }
    const model = models.find((m) => m.id === selection.modelId);

    if (model?.kind === "obj") {
      const part = getMeshParts(selection.modelId).find(
        (p) => p.localId === selection.localId,
      );
      setTitle(part?.name ?? `Part ${selection.localId}`);
      setSections(
        part
          ? [
              {
                title: "Geometry",
                rows: [
                  { label: "Triangles", value: part.triangles.toLocaleString() },
                  { label: "Model", value: model.name },
                ],
              },
            ]
          : [],
      );
      return;
    }

    (async () => {
      const data = await getItemData(selection.modelId, selection.localId);
      if (!alive) return;
      if (!data) {
        setSections([]);
        setTitle(null);
        return;
      }
      setTitle(
        scalar((data as any).Name) ??
          scalar((data as any)._category) ??
          `#${selection.localId}`,
      );
      const attributes = toRows(data);
      setSections([
        ...(attributes.length ? [{ title: "Attributes", rows: attributes }] : []),
        ...psetSections(data),
      ]);
    })().catch((e) => console.error("[properties] load failed", e));

    return () => {
      alive = false;
    };
  }, [getItemData, getMeshParts, models, selection]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-(--color-border)">
        <span className="text-xs uppercase tracking-wider text-(--color-text-mute)">
          Properties
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!selection && (
          <p className="px-3 py-4 text-xs text-(--color-text-mute)">
            Click an element to inspect it.
          </p>
        )}
        {title && (
          <p className="px-3 py-2 text-sm text-(--color-text) border-b border-(--color-border)/50 truncate">
            {title}
          </p>
        )}
        {sections.map((section) => (
          <div key={section.title} className="border-b border-(--color-border)/50">
            <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-(--color-text-mute)">
              {section.title}
            </p>
            {section.rows.map((row) => (
              <div
                key={`${section.title}:${row.label}`}
                className="flex gap-2 px-3 py-0.5 text-[11px]"
              >
                <span className="text-(--color-text-mute) shrink-0 w-1/2 truncate">
                  {row.label}
                </span>
                <span className="text-(--color-text-dim) truncate" title={row.value}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
