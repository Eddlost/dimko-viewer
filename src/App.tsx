import { useState } from "react";
import "./App.css";
import { Viewport } from "./features/viewer/Viewport";
import { ViewerProvider } from "./features/viewer/ViewerContext";
import { ContextMenuProvider } from "./components/ContextMenu";
import { Toolbar } from "./components/Toolbar";
import { ModelsPanel } from "./features/models/ModelsPanel";
import { PropertiesPanel } from "./features/properties/PropertiesPanel";
import { MeasurementsPanel } from "./features/measurements/MeasurementsPanel";
import { MeasurementsProvider } from "./features/measurements/MeasurementsContext";

type Tab = "models" | "measurements";

function Sidebar() {
  const [tab, setTab] = useState<Tab>("models");

  return (
    <aside className="w-72 shrink-0 flex flex-col border-r border-(--color-border) bg-(--color-panel)">
      <div className="flex border-b border-(--color-border)">
        {(["models", "measurements"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 px-3 py-2 text-xs capitalize transition border-b-2 ${
              tab === key
                ? "text-(--color-accent) border-(--color-accent)"
                : "text-(--color-text-mute) border-transparent hover:text-(--color-text-dim)"
            }`}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === "models" ? <ModelsPanel /> : <MeasurementsPanel />}
      </div>
    </aside>
  );
}

function Header() {
  return (
    <header className="flex items-center gap-3 px-4 py-2 border-b border-(--color-border) bg-(--color-bg-elevated)">
      <span className="text-sm font-medium tracking-wide text-(--color-text)">
        DIMKO <span className="text-(--color-accent)">Viewer</span>
      </span>
      <span className="text-[11px] text-(--color-text-mute)">
        IFC &amp; OBJ · everything runs in your browser
      </span>
      <span className="flex-1" />
      <a
        href="https://github.com/"
        target="_blank"
        rel="noreferrer"
        className="text-[11px] text-(--color-text-mute) hover:text-(--color-accent) transition"
      >
        source on GitHub
      </a>
    </header>
  );
}

export default function App() {
  return (
    <ViewerProvider>
      <MeasurementsProvider>
        <ContextMenuProvider>
          <div className="flex flex-col h-screen w-screen overflow-hidden bg-(--color-bg)">
            <Header />
            <div className="flex flex-1 overflow-hidden">
              <Sidebar />
              <main className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 relative">
                  <Viewport />
                </div>
                <Toolbar />
              </main>
              <div className="w-72 shrink-0 border-l border-(--color-border) bg-(--color-panel)">
                <PropertiesPanel />
              </div>
            </div>
          </div>
        </ContextMenuProvider>
      </MeasurementsProvider>
    </ViewerProvider>
  );
}
