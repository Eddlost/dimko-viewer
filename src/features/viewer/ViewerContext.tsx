import { createContext, useContext, useRef, type ReactNode } from "react";
import { useViewer, type ViewerApi, type ViewerOptions } from "./useViewer";

export type ViewerContextValue = ViewerApi & {
  containerRef: React.RefObject<HTMLDivElement | null>;
};

const ViewerContext = createContext<ViewerContextValue | null>(null);

/**
 * Publishes an already-built viewer API. An embedder that calls useViewer
 * itself — to wrap it with its own extras — must mount this, or components
 * from this package (OrientationGizmo) read an empty context and throw: a
 * context is identified by its object, so the embedder's own provider is a
 * different one no matter how alike the value looks.
 */
export function ViewerApiProvider({
  value,
  children,
}: {
  value: ViewerContextValue;
  children: ReactNode;
}) {
  return (
    <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>
  );
}

export function ViewerProvider({
  children,
  options,
}: {
  children: ReactNode;
  /** Embedder hooks — see ViewerOptions. Omit for the stock viewer. */
  options?: ViewerOptions;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewer = useViewer(containerRef, options);
  return (
    <ViewerApiProvider value={{ ...viewer, containerRef }}>
      {children}
    </ViewerApiProvider>
  );
}

export function useViewerContext() {
  const ctx = useContext(ViewerContext);
  if (!ctx) throw new Error("useViewerContext must be used within ViewerProvider");
  return ctx;
}
