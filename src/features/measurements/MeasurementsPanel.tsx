import { useState } from "react";
import { useMeasurements } from "./MeasurementsContext";

function format(value: number, unit: string): string {
  const decimals = Math.abs(value) < 10 ? 3 : 2;
  return `${value.toFixed(decimals)} ${unit}`;
}

export function MeasurementsPanel() {
  const { measurements, rename, remove, clear, totals } = useMeasurements();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-(--color-border)">
        <span className="text-xs uppercase tracking-wider text-(--color-text-mute)">
          Measurements
        </span>
        {measurements.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="text-xs text-(--color-text-mute) hover:text-(--color-danger) transition"
          >
            clear all
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!measurements.length && (
          <p className="px-3 py-4 text-xs text-(--color-text-mute) leading-relaxed">
            Pick <span className="text-(--color-text-dim)">Distance</span> or{" "}
            <span className="text-(--color-text-dim)">Polyline</span> in the
            toolbar and click points in the model. With snapping on, clicks lock
            onto corners and edge midpoints.
          </p>
        )}
        {measurements.map((m) => (
          <div
            key={m.id}
            className="group px-3 py-2 border-b border-(--color-border)/50 hover:bg-(--color-panel-elevated) transition"
          >
            <div className="flex items-center gap-2">
              {editing === m.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (draft.trim()) rename(m.id, draft.trim());
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="flex-1 bg-(--color-bg) border border-(--color-accent-dim) rounded px-1.5 py-0.5 text-xs outline-none"
                />
              ) : (
                <button
                  type="button"
                  onDoubleClick={() => {
                    setEditing(m.id);
                    setDraft(m.name);
                  }}
                  title="Double-click to rename"
                  className="flex-1 text-left text-xs text-(--color-text) truncate"
                >
                  {m.name}
                </button>
              )}
              <button
                type="button"
                onClick={() => remove(m.id)}
                className="opacity-0 group-hover:opacity-100 text-(--color-text-mute) hover:text-(--color-danger) text-xs transition"
              >
                ✕
              </button>
            </div>
            <div className="mt-0.5 font-mono text-sm text-(--color-accent)">
              {format(m.value, m.unit)}
            </div>
          </div>
        ))}
      </div>

      {Object.keys(totals).length > 0 && (
        <div className="px-3 py-2 border-t border-(--color-border) text-xs">
          <span className="text-(--color-text-mute)">Total </span>
          {Object.entries(totals).map(([unit, sum]) => (
            <span key={unit} className="ml-2 font-mono text-(--color-text-dim)">
              {format(sum, unit)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
