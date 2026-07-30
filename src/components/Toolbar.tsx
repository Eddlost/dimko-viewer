import { useRef } from "react";
import { useViewerContext } from "../features/viewer/ViewerContext";
import { useModelImport } from "../features/viewer/useModelImport";
import { useMeasurements } from "../features/measurements/MeasurementsContext";
import { ACCEPTED_EXTENSIONS } from "../lib/fileImport";

type ButtonProps = {
  label: string;
  icon: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
};

function ToolButton({ label, icon, active, disabled, title, onClick }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "bg-(--color-accent-soft) text-(--color-accent) border-(--color-accent-dim)"
          : "bg-(--color-panel) text-(--color-text-dim) border-(--color-border) hover:text-(--color-text) hover:border-(--color-border-strong)"
      }`}
    >
      <span className="leading-none">{icon}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function Toolbar() {
  const {
    ready,
    models,
    measureMode,
    setMeasureMode,
    polylineMode,
    setPolylineMode,
    finalizePolyline,
    clipMode,
    setClipMode,
    clipCount,
    deleteAllClips,
    snapEnabled,
    setSnapEnabled,
    showAll,
    clear,
  } = useViewerContext();
  const { importFiles } = useModelImport();
  // Goes through the store, not the viewer, so the list and the scene stay in
  // step — clearing one without the other is what left orphaned dimensions.
  const { clear: clearMeasurements } = useMeasurements();
  const fileInput = useRef<HTMLInputElement>(null);

  const hasModels = models.length > 0;

  return (
    <div className="flex items-center gap-1.5 px-3 py-2 border-t border-(--color-border) bg-(--color-bg-elevated)">
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(",")}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <ToolButton
        label="Open"
        icon="⭱"
        disabled={!ready}
        title="Open an IFC or OBJ file"
        onClick={() => fileInput.current?.click()}
      />

      <span className="w-px h-5 bg-(--color-border) mx-1" />

      <ToolButton
        label="Distance"
        icon="↔"
        active={measureMode}
        disabled={!hasModels}
        title="Measure between two points"
        onClick={() => setMeasureMode(!measureMode)}
      />
      <ToolButton
        label="Polyline"
        icon="⌁"
        active={polylineMode}
        disabled={!hasModels}
        title="Measure a chain of segments (Enter finishes)"
        onClick={() => setPolylineMode(!polylineMode)}
      />
      {polylineMode && (
        <ToolButton label="Finish" icon="✓" onClick={() => finalizePolyline()} />
      )}
      <ToolButton
        label={snapEnabled ? "Snap on" : "Snap off"}
        icon={snapEnabled ? "◎" : "○"}
        active={snapEnabled}
        title="Snap clicks to corners and edge midpoints"
        onClick={() => setSnapEnabled(!snapEnabled)}
      />

      <span className="w-px h-5 bg-(--color-border) mx-1" />

      <ToolButton
        label="Section"
        icon="✂"
        active={clipMode}
        disabled={!hasModels}
        title="Cut a section plane through a clicked face"
        onClick={() => setClipMode(!clipMode)}
      />
      {clipCount > 0 && (
        <ToolButton
          label={`Clear cuts (${clipCount})`}
          icon="✕"
          onClick={() => deleteAllClips()}
        />
      )}

      <span className="flex-1" />

      <ToolButton
        label="Show all"
        icon="☼"
        disabled={!hasModels}
        onClick={() => showAll()}
      />
      <ToolButton
        label="Reset"
        icon="⌫"
        disabled={!hasModels}
        title="Remove all models and measurements from the scene"
        onClick={() => {
          clear();
          clearMeasurements();
          deleteAllClips();
        }}
      />
    </div>
  );
}
