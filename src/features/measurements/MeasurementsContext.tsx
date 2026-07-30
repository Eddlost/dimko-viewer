import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useViewerContext } from "../viewer/ViewerContext";

export type Measurement = {
  id: string;
  name: string;
  kind: string;
  value: number;
  unit: string;
  points: Array<[number, number, number]>;
  createdAt: string;
  /**
   * Id of the objects drawn for this measurement. Only valid for the current
   * session — a reload restores the list from localStorage but the scene
   * starts empty, so a restored row has nothing left to erase.
   */
  visualId?: string;
};

const STORAGE_KEY = "dimko-viewer-measurements-v1";

const KIND_LABEL: Record<string, string> = {
  distance: "Distance",
  polyline: "Polyline",
  "volume-mesh": "Volume",
};

/**
 * Measurements live in the browser only. There is no account and no server —
 * localStorage is what makes a session survive a reload.
 */
function load(): Measurement[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type MeasurementsValue = {
  measurements: Measurement[];
  add: (m: Omit<Measurement, "id" | "createdAt">) => void;
  rename: (id: string, name: string) => void;
  /** Removes the row and, via `onRemoveVisual`, its objects in the scene. */
  remove: (id: string) => void;
  clear: () => void;
  /** Sum per unit — "how much of this did I measure in total". */
  totals: Record<string, number>;
};

const Context = createContext<MeasurementsValue | null>(null);

export function MeasurementsProvider({ children }: { children: ReactNode }) {
  // The list lives here, the drawn objects live in the viewer. Deletions have
  // to reach both, so the store owns that pairing rather than leaving every
  // call site to remember it.
  const {
    removeMeasurementVisual,
    deleteAllMeasurements,
    pendingMeasurement,
    clearPendingMeasurement,
  } = useViewerContext();
  const [measurements, setMeasurements] = useState<Measurement[]>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(measurements));
    } catch {
      /* quota or private mode — measurements just won't persist */
    }
  }, [measurements]);

  const add = useCallback((m: Omit<Measurement, "id" | "createdAt">) => {
    setMeasurements((prev) => [
      ...prev,
      {
        ...m,
        id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, []);

  const rename = useCallback((id: string, name: string) => {
    setMeasurements((prev) =>
      prev.map((m) => (m.id === id ? { ...m, name } : m)),
    );
  }, []);

  const remove = useCallback(
    (id: string) => {
      // Erase the scene objects outside the state updater — updaters must stay
      // free of side effects (StrictMode runs them twice).
      const target = measurements.find((m) => m.id === id);
      if (target?.visualId) removeMeasurementVisual(target.visualId);
      setMeasurements((prev) => prev.filter((m) => m.id !== id));
    },
    [measurements, removeMeasurementVisual],
  );

  const clear = useCallback(() => {
    deleteAllMeasurements();
    setMeasurements([]);
  }, [deleteAllMeasurements]);

  // Ingest finished measurements here rather than in the panel: the panel is
  // only mounted while its tab is open, so a measurement taken with the models
  // tab showing was drawn in the scene and then never recorded.
  //
  // Consumption is keyed on the pending object's identity — `clearPending-
  // Measurement` is a new closure every render, and StrictMode runs effects
  // twice, so anything weaker stores the measurement twice.
  const consumed = useRef<typeof pendingMeasurement>(null);
  const count = useRef(0);
  count.current = measurements.length;

  useEffect(() => {
    if (!pendingMeasurement || consumed.current === pendingMeasurement) return;
    consumed.current = pendingMeasurement;
    const label = KIND_LABEL[pendingMeasurement.kind] ?? pendingMeasurement.kind;
    add({
      name: `${label} ${count.current + 1}`,
      kind: pendingMeasurement.kind,
      value: pendingMeasurement.value,
      unit: pendingMeasurement.unit,
      points: pendingMeasurement.points,
      visualId: pendingMeasurement.visualId,
    });
    clearPendingMeasurement();
  }, [add, clearPendingMeasurement, pendingMeasurement]);

  const totals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of measurements) out[m.unit] = (out[m.unit] ?? 0) + m.value;
    return out;
  }, [measurements]);

  const value = useMemo(
    () => ({ measurements, add, rename, remove, clear, totals }),
    [add, clear, measurements, remove, rename, totals],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useMeasurements() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useMeasurements must be used within MeasurementsProvider");
  return ctx;
}
