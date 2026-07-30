import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Measurement = {
  id: string;
  name: string;
  kind: string;
  value: number;
  unit: string;
  points: Array<[number, number, number]>;
  createdAt: string;
};

const STORAGE_KEY = "dimko-viewer-measurements-v1";

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
  remove: (id: string) => void;
  clear: () => void;
  /** Sum per unit — "how much of this did I measure in total". */
  totals: Record<string, number>;
};

const Context = createContext<MeasurementsValue | null>(null);

export function MeasurementsProvider({ children }: { children: ReactNode }) {
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

  const remove = useCallback((id: string) => {
    setMeasurements((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const clear = useCallback(() => setMeasurements([]), []);

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
