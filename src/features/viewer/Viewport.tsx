import { useState } from "react";
import * as OBC from "@thatopen/components";
import { useViewerContext } from "./ViewerContext";
import { useModelImport } from "./useModelImport";
import { useContextMenu, type ContextMenuItem } from "../../components/ContextMenu";
import { OrientationGizmo } from "./OrientationGizmo";

export function Viewport() {
  const {
    ready,
    loading,
    error,
    containerRef,
    models,
    pickAt,
    isolate,
    hide,
    showAll,
    selectItem,
    selectMany,
    selectionMap,
    zoomToSelection,
    clipFromHit,
    clipMode,
    deleteAllClips,
    clipCount,
    measureMode,
    polylineMode,
    polylinePointCount,
    selectRect,
    recenter,
  } = useViewerContext();
  const { importFiles, importing, importError, setImportError } = useModelImport();
  const { open: openMenu } = useContextMenu();
  const [dragOver, setDragOver] = useState(false);

  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const hit = await pickAt(e.clientX, e.clientY);
    const items: ContextMenuItem[] = [];
    if (hit) {
      const inSelection = !!selectionMap[hit.modelId]?.has(hit.localId);
      const map: OBC.ModelIdMap = inSelection
        ? Object.fromEntries(
            Object.entries(selectionMap).map(([k, v]) => [k, new Set(v)]),
          )
        : { [hit.modelId]: new Set([hit.localId]) };
      const total = Object.values(map).reduce(
        (n, s) => n + (s as Set<number>).size,
        0,
      );
      const suffix = total > 1 ? ` (${total})` : "";
      items.push(
        {
          id: "isolate",
          label: `Isolate${suffix}`,
          icon: "◉",
          onClick: async () => {
            if (inSelection) await selectMany(map);
            else await selectItem(hit.modelId, hit.localId);
            await isolate(map);
            await zoomToSelection(map);
          },
        },
        { id: "hide", label: `Hide${suffix}`, icon: "◌", onClick: () => hide(map) },
        { id: "d1", divider: true },
        {
          id: "zoom",
          label: `Zoom to${suffix}`,
          icon: "⊕",
          onClick: () => zoomToSelection(map),
        },
        { id: "d2", divider: true },
      );
      if (hit.normal && hit.point) {
        items.push({
          id: "clip",
          label: "Section here",
          icon: "✂",
          onClick: () => clipFromHit(hit.normal!, hit.point!),
        });
      }
    }
    items.push({
      id: "showAll",
      label: "Show all",
      icon: "☼",
      onClick: () => showAll(),
    });
    if (clipCount > 0) {
      items.push({
        id: "clipDelete",
        label: `Delete sections (${clipCount})`,
        icon: "✕",
        onClick: () => deleteAllClips(),
      });
    }
    openMenu(e.clientX, e.clientY, items);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setImportError(null);
    if (e.dataTransfer.files.length) await importFiles(e.dataTransfer.files);
  };

  return (
    <div
      className="absolute inset-0 bg-(--color-bg)"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
    >
      <div ref={containerRef} className="absolute inset-0" />

      <OrientationGizmo />

      {ready && (
        <button
          type="button"
          onClick={() => recenter()}
          title="Fit model to view"
          className="absolute top-3 left-3 w-9 h-9 flex items-center justify-center rounded-md bg-(--color-panel)/80 backdrop-blur-sm border border-(--color-border) text-(--color-text-dim) hover:text-(--color-accent) hover:border-(--color-accent-dim) pointer-events-auto transition"
        >
          <span className="text-lg leading-none">⌖</span>
        </button>
      )}

      {(dragOver || (!models.length && ready)) && (
        <div
          className={`absolute inset-0 pointer-events-none flex items-center justify-center ${
            dragOver
              ? "border-2 border-dashed border-(--color-accent) bg-(--color-accent-soft)"
              : ""
          }`}
        >
          <div className="text-center">
            <div className="text-4xl mb-3 opacity-40">◲</div>
            <p className="text-(--color-accent) text-lg font-medium tracking-wide">
              Drop an IFC or OBJ file
            </p>
            <p className="text-(--color-text-mute) text-xs mt-2">
              Files are parsed in your browser — nothing is uploaded
            </p>
          </div>
        </div>
      )}

      <div className="absolute top-3 left-14 flex gap-2 text-xs">
        <span className="px-2 py-1 rounded-md bg-(--color-panel)/80 backdrop-blur-sm border border-(--color-border) text-(--color-text-dim)">
          {ready ? (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-(--color-accent) shadow-[0_0_6px_var(--color-accent)]" />
              ready
            </span>
          ) : (
            "init…"
          )}
        </span>
        {(loading || importing) && (
          <span className="px-2 py-1 rounded-md bg-(--color-accent-soft) text-(--color-accent) border border-(--color-accent-dim)">
            loading model…
          </span>
        )}
        {clipMode && (
          <span className="px-2 py-1 rounded-md bg-cyan-900/40 text-cyan-300 border border-cyan-700/40">
            Section — click a face to cut, Esc to exit
          </span>
        )}
        {measureMode && (
          <span className="px-2 py-1 rounded-md bg-emerald-900/40 text-emerald-300 border border-emerald-700/40">
            Distance — click start, click end, Esc to exit
          </span>
        )}
        {polylineMode && (
          <span className="px-2 py-1 rounded-md bg-emerald-900/40 text-emerald-300 border border-emerald-700/40">
            Polyline — {polylinePointCount} point(s), Enter to finish,
            Backspace to undo, Esc to cancel
          </span>
        )}
        {clipCount > 0 && !clipMode && (
          <span className="px-2 py-1 rounded-md bg-cyan-900/30 text-cyan-300/80 border border-cyan-800/40">
            Sections: {clipCount} (Del clears)
          </span>
        )}
        {(error || importError) && (
          <span className="px-2 py-1 rounded-md bg-red-900/40 text-red-300 border border-red-700/40">
            {error || importError}
          </span>
        )}
      </div>

      {selectRect && (
        <div
          className="fixed pointer-events-none border border-cyan-400 bg-cyan-400/10 z-50"
          style={{
            left: Math.min(selectRect.x1, selectRect.x2),
            top: Math.min(selectRect.y1, selectRect.y2),
            width: Math.abs(selectRect.x2 - selectRect.x1),
            height: Math.abs(selectRect.y2 - selectRect.y1),
          }}
        />
      )}
    </div>
  );
}
