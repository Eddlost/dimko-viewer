import { useCallback, useEffect, useState } from "react";
import * as OBC from "@thatopen/components";
import { useViewerContext } from "../viewer/ViewerContext";
import type { LoadedModel } from "../viewer/useViewer";

type Group = { name: string; items: OBC.ModelIdMap };
type Axis = { key: string; label: string; groups: Group[] };

/** IFC models expose storeys and categories; OBJ models expose their parts. */
function ModelBlock({ model }: { model: LoadedModel }) {
  const {
    getModelGroups,
    getMeshParts,
    setModelHidden,
    removeModel,
    isolate,
    setVisibility,
    zoomToSelection,
    showAll,
  } = useViewerContext();

  const [axes, setAxes] = useState<Axis[]>([]);
  const [open, setOpen] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    (async () => {
      if (model.kind === "obj") {
        const parts = getMeshParts(model.id);
        if (!alive) return;
        setAxes([
          {
            key: "parts",
            label: "Parts",
            groups: parts.map((p) => ({
              name: `${p.name} · ${p.triangles.toLocaleString()} tris`,
              items: { [model.id]: new Set([p.localId]) },
            })),
          },
        ]);
      } else {
        const groups = await getModelGroups(model.id);
        if (!alive) return;
        setAxes([
          { key: "storeys", label: "Storeys", groups: groups?.storeys ?? [] },
          {
            key: "categories",
            label: "Categories",
            groups: groups?.categories ?? [],
          },
        ]);
      }
      if (alive) setBusy(false);
    })().catch((e) => {
      console.error("[models] group load failed", e);
      if (alive) setBusy(false);
    });
    return () => {
      alive = false;
    };
  }, [getMeshParts, getModelGroups, model.id, model.kind]);

  const toggleGroup = useCallback(
    async (axisKey: string, group: Group) => {
      const key = `${axisKey}:${group.name}`;
      const nowHidden = !hiddenGroups.has(key);
      setHiddenGroups((prev) => {
        const next = new Set(prev);
        if (nowHidden) next.add(key);
        else next.delete(key);
        return next;
      });
      await setVisibility(!nowHidden, group.items);
    },
    [hiddenGroups, setVisibility],
  );

  return (
    <div className="border-b border-(--color-border)">
      <div className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-(--color-panel-elevated) transition">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-(--color-text-mute) text-[10px] w-3"
        >
          {open ? "▼" : "▶"}
        </button>
        <button
          type="button"
          onClick={async () => {
            const next = !hidden;
            setHidden(next);
            await setModelHidden(model.id, next);
          }}
          title={hidden ? "Show model" : "Hide model"}
          className={`text-xs w-4 ${
            hidden ? "text-(--color-text-mute)" : "text-(--color-accent)"
          }`}
        >
          {hidden ? "○" : "●"}
        </button>
        <span
          className="flex-1 text-xs truncate text-(--color-text)"
          title={model.name}
        >
          {model.name}
        </span>
        <span className="text-[10px] uppercase text-(--color-text-mute) px-1 rounded border border-(--color-border)">
          {model.kind}
        </span>
        <button
          type="button"
          onClick={() => removeModel(model.id)}
          title="Remove model"
          className="text-(--color-text-mute) hover:text-(--color-danger) text-xs"
        >
          ✕
        </button>
      </div>

      {open && (
        <div className="pb-1">
          {busy && (
            <p className="px-6 py-1 text-[11px] text-(--color-text-mute)">
              reading structure…
            </p>
          )}
          {axes.map((axis) =>
            axis.groups.length ? (
              <div key={axis.key} className="mt-0.5">
                <p className="px-6 py-0.5 text-[10px] uppercase tracking-wider text-(--color-text-mute)">
                  {axis.label}
                </p>
                {axis.groups.map((group) => {
                  const key = `${axis.key}:${group.name}`;
                  const isHidden = hiddenGroups.has(key);
                  return (
                    <div
                      key={key}
                      className="group flex items-center gap-1.5 pl-6 pr-2 py-0.5 hover:bg-(--color-panel-elevated) transition"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(axis.key, group)}
                        className={`text-[10px] w-3 ${
                          isHidden
                            ? "text-(--color-text-mute)"
                            : "text-(--color-accent)"
                        }`}
                      >
                        {isHidden ? "○" : "●"}
                      </button>
                      <span
                        className="flex-1 text-[11px] truncate text-(--color-text-dim)"
                        title={group.name}
                      >
                        {group.name}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await isolate(group.items);
                          await zoomToSelection(group.items);
                        }}
                        title="Isolate"
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-(--color-text-mute) hover:text-(--color-accent) transition"
                      >
                        ◉
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null,
          )}
          <button
            type="button"
            onClick={() => {
              setHiddenGroups(new Set());
              void showAll();
            }}
            className="ml-6 mt-1 text-[10px] text-(--color-text-mute) hover:text-(--color-accent) transition"
          >
            show all
          </button>
        </div>
      )}
    </div>
  );
}

export function ModelsPanel() {
  const { models } = useViewerContext();

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-(--color-border)">
        <span className="text-xs uppercase tracking-wider text-(--color-text-mute)">
          Models
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!models.length && (
          <p className="px-3 py-4 text-xs text-(--color-text-mute)">
            No model loaded yet.
          </p>
        )}
        {models.map((model) => (
          <ModelBlock key={model.id} model={model} />
        ))}
      </div>
    </div>
  );
}
