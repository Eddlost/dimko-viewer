import { useCallback, useEffect, useState } from "react";
import * as OBC from "@thatopen/components";
import { useViewerContext } from "../viewer/ViewerContext";
import { CameraPanel } from "../viewer/CameraPanel";
import { deleteModel as deleteStoredModel } from "../../lib/modelStore";
import type { LoadedModel } from "../viewer/useViewer";
import type { GroupNode } from "../viewer/ifcGroups";

type Group = { name: string; items: OBC.ModelIdMap };
type Axis = { key: string; label: string; groups: Group[] };

/**
 * One IfcGroup and, when open, its subgroups. Roots start open so a budget's
 * sections show at once; deeper levels open on demand — an estimator's model
 * has thousands of items.
 */
function GroupRow({
  node,
  modelId,
  depth,
  hiddenGroups,
  onToggle,
  onIsolate,
}: {
  node: GroupNode;
  modelId: string;
  depth: number;
  hiddenGroups: Set<string>;
  onToggle: (key: string, label: string, items: OBC.ModelIdMap) => void;
  onIsolate: (label: string, items: OBC.ModelIdMap) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const key = `groups:#${node.localId}`;
  const isHidden = hiddenGroups.has(key);
  const items = { [modelId]: new Set(node.elementIds) };
  return (
    <>
      <div
        className="group flex items-center gap-1.5 pr-2 py-0.5 hover:bg-(--color-panel-elevated) transition"
        style={{ paddingLeft: `${24 + depth * 12}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`text-(--color-text-mute) text-[9px] w-2.5 ${
            node.children.length ? "" : "invisible"
          }`}
        >
          {open ? "▼" : "▶"}
        </button>
        <button
          type="button"
          onClick={() => onToggle(key, node.name, items)}
          className={`text-[10px] w-3 ${
            isHidden ? "text-(--color-text-mute)" : "text-(--color-accent)"
          }`}
        >
          {isHidden ? "○" : "●"}
        </button>
        <span
          className="flex-1 text-[11px] truncate text-(--color-text-dim)"
          title={node.name}
        >
          {node.name}
        </span>
        <span className="text-[10px] text-(--color-text-mute)">
          {node.elementIds.length}
        </span>
        <button
          type="button"
          onClick={() => onIsolate(node.name, items)}
          title="Isolate"
          className="opacity-0 group-hover:opacity-100 text-[10px] text-(--color-text-mute) hover:text-(--color-accent) transition"
        >
          ◉
        </button>
      </div>
      {open &&
        node.children.map((child) => (
          <GroupRow
            key={child.localId}
            node={child}
            modelId={modelId}
            depth={depth + 1}
            hiddenGroups={hiddenGroups}
            onToggle={onToggle}
            onIsolate={onIsolate}
          />
        ))}
    </>
  );
}

/**
 * IFC models expose their IfcGroup tree (a budget, when an estimator made
 * the file), storeys and categories; OBJ models expose their parts.
 */
function ModelBlock({ model }: { model: LoadedModel }) {
  const {
    getModelGroups,
    getGroupTree,
    getMeshParts,
    setModelHidden,
    removeModel,
    isolate,
    setVisibility,
    zoomToSelection,
    showAll,
    recordVisibilityUndo,
  } = useViewerContext();

  const [axes, setAxes] = useState<Axis[]>([]);
  const [groupTree, setGroupTree] = useState<GroupNode[]>([]);
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
        const [groups, tree] = await Promise.all([
          getModelGroups(model.id),
          getGroupTree(model.id).catch((e) => {
            console.error("[models] group tree failed", e);
            return [];
          }),
        ]);
        if (!alive) return;
        setGroupTree(tree);
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
  }, [getMeshParts, getModelGroups, getGroupTree, model.id, model.kind]);

  const toggleGroup = useCallback(
    async (key: string, label: string, items: OBC.ModelIdMap) => {
      const nowHidden = !hiddenGroups.has(key);
      // The checkbox set is this panel's own state, so it rides along with the
      // scene snapshot — restoring one without the other leaves the ticks
      // disagreeing with the model.
      const before = new Set(hiddenGroups);
      await recordVisibilityUndo({
        label: nowHidden ? `hide ${label}` : `show ${label}`,
        restore: () => setHiddenGroups(before),
      });
      setHiddenGroups((prev) => {
        const next = new Set(prev);
        if (nowHidden) next.add(key);
        else next.delete(key);
        return next;
      });
      await setVisibility(!nowHidden, items);
    },
    [hiddenGroups, recordVisibilityUndo, setVisibility],
  );

  const isolateGroup = useCallback(
    async (label: string, items: OBC.ModelIdMap) => {
      await recordVisibilityUndo({ label: `isolate ${label}` });
      await isolate(items);
      await zoomToSelection(items);
    },
    [isolate, recordVisibilityUndo, zoomToSelection],
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
            const wasHidden = hidden;
            await recordVisibilityUndo({
              label: next ? `hide ${model.name}` : `show ${model.name}`,
              restore: () => setHidden(wasHidden),
            });
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
          onClick={async () => {
            await removeModel(model.id);
            // Drop it from storage too, or it returns on the next reload.
            await deleteStoredModel(model.id);
          }}
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
          {groupTree.length > 0 && (
            <div className="mt-0.5">
              <p className="px-6 py-0.5 text-[10px] uppercase tracking-wider text-(--color-text-mute)">
                Groups
              </p>
              {groupTree.map((node) => (
                <GroupRow
                  key={node.localId}
                  node={node}
                  modelId={model.id}
                  depth={0}
                  hiddenGroups={hiddenGroups}
                  onToggle={toggleGroup}
                  onIsolate={isolateGroup}
                />
              ))}
            </div>
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
                        onClick={() => toggleGroup(key, group.name, group.items)}
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
                        onClick={() => isolateGroup(group.name, group.items)}
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
              const before = new Set(hiddenGroups);
              void recordVisibilityUndo({
                label: "show all",
                restore: () => setHiddenGroups(before),
              }).then(() => {
                setHiddenGroups(new Set());
                return showAll();
              });
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
    <div className="flex flex-col h-full overflow-y-auto">
      <CameraPanel />
      <div className="px-3 py-2 border-b border-(--color-border)">
        <span className="text-xs uppercase tracking-wider text-(--color-text-mute)">
          Models
        </span>
      </div>
      <div>
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
