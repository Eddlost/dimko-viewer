import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem =
  | {
      id: string;
      label: string;
      icon?: string;
      disabled?: boolean;
      onClick: () => void | Promise<void>;
    }
  | { id: string; divider: true };

type MenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
} | null;

type Ctx = {
  open: (x: number, y: number, items: ContextMenuItem[]) => void;
  close: () => void;
};

const ContextMenuCtx = createContext<Ctx | null>(null);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MenuState>(null);

  const open = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setState({ x, y, items });
  }, []);
  const close = useCallback(() => setState(null), []);

  return (
    <ContextMenuCtx.Provider value={{ open, close }}>
      {children}
      {state && <ContextMenu state={state} onClose={close} />}
    </ContextMenuCtx.Provider>
  );
}

export function useContextMenu() {
  const ctx = useContext(ContextMenuCtx);
  if (!ctx) throw new Error("useContextMenu must be used within ContextMenuProvider");
  return ctx;
}

function ContextMenu({
  state,
  onClose,
}: {
  state: NonNullable<MenuState>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = state.x;
    let ny = state.y;
    if (nx + rect.width > vw - 4) nx = vw - rect.width - 4;
    if (ny + rect.height > vh - 4) ny = vh - rect.height - 4;
    if (nx < 4) nx = 4;
    if (ny < 4) ny = 4;
    setPos({ x: nx, y: ny });
  }, [state.x, state.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-44 py-1 rounded-md border border-(--color-border) bg-(--color-panel) shadow-xl text-xs text-(--color-text) select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((it) => {
        if ("divider" in it) {
          return (
            <div key={it.id} className="my-1 h-px bg-(--color-border)" />
          );
        }
        return (
          <button
            key={it.id}
            disabled={it.disabled}
            onClick={async () => {
              onClose();
              try {
                await it.onClick();
              } catch (e) {
                console.error("[ctxmenu] action failed", it.id, e);
              }
            }}
            className={`w-full px-3 py-1.5 text-left flex items-center gap-2 ${
              it.disabled
                ? "text-(--color-text-mute) cursor-not-allowed"
                : "hover:bg-(--color-bg-elevated)"
            }`}
          >
            {it.icon && (
              <span className="w-4 text-center text-(--color-text-dim)">
                {it.icon}
              </span>
            )}
            <span className="flex-1 truncate">{it.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
