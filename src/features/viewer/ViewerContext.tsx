import { createContext, useContext, useRef, type ReactNode } from "react";
import { useViewer, type ViewerApi } from "./useViewer";

type ViewerContextValue = ViewerApi & {
  containerRef: React.RefObject<HTMLDivElement | null>;
};

const ViewerContext = createContext<ViewerContextValue | null>(null);

export function ViewerProvider({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewer = useViewer(containerRef);
  return (
    <ViewerContext.Provider value={{ ...viewer, containerRef }}>
      {children}
    </ViewerContext.Provider>
  );
}

export function useViewerContext() {
  const ctx = useContext(ViewerContext);
  if (!ctx) throw new Error("useViewerContext must be used within ViewerProvider");
  return ctx;
}
