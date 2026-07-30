import { useViewerContext } from "./ViewerContext";
import { DEFAULT_FOV, MAX_FOV, MIN_FOV } from "./useViewer";

/**
 * Field-of-view presets. 60°+ is a wide-angle lens: fine for games, wrong for
 * inspecting a building, where it stretches anything off the frame centre.
 */
const FOV_PRESETS = [
  { value: 25, label: "25°", hint: "Telephoto — almost no distortion" },
  { value: DEFAULT_FOV, label: "35°", hint: "Default — natural for buildings" },
  { value: 50, label: "50°", hint: "Wide — more of the scene, more stretch" },
];

export function CameraPanel() {
  const { projection, setProjection, fov, setFov } = useViewerContext();
  const isPerspective = projection === "perspective";

  return (
    <div className="px-3 py-2 border-b border-(--color-border)">
      <span className="text-xs uppercase tracking-wider text-(--color-text-mute)">
        Camera
      </span>

      <div className="mt-2 flex rounded-md border border-(--color-border) overflow-hidden">
        {(
          [
            ["perspective", "Perspective", "Natural depth; parallel lines converge"],
            ["orthographic", "Orthographic", "No perspective; true for comparing sizes"],
          ] as const
        ).map(([mode, label, hint]) => (
          <button
            key={mode}
            type="button"
            title={hint}
            onClick={() => void setProjection(mode)}
            className={`flex-1 px-2 py-1 text-[11px] transition ${
              projection === mode
                ? "bg-(--color-accent-soft) text-(--color-accent)"
                : "text-(--color-text-mute) hover:text-(--color-text-dim)"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {isPerspective ? (
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-(--color-text-mute)">
              Field of view
            </span>
            <span className="text-[11px] font-mono text-(--color-text-dim)">
              {Math.round(fov)}°
            </span>
          </div>
          <input
            type="range"
            min={MIN_FOV}
            max={MAX_FOV}
            step={1}
            value={fov}
            onChange={(e) => setFov(Number(e.target.value))}
            className="w-full mt-1 accent-(--color-accent)"
            aria-label="Field of view"
          />
          <div className="flex gap-1 mt-1">
            {FOV_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                title={preset.hint}
                onClick={() => setFov(preset.value)}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition ${
                  Math.round(fov) === preset.value
                    ? "border-(--color-accent-dim) text-(--color-accent)"
                    : "border-(--color-border) text-(--color-text-mute) hover:text-(--color-text-dim)"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-(--color-text-mute)">
            Lower the angle if objects look stretched when you get close.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[10px] leading-snug text-(--color-text-mute)">
          Parallel projection — no perspective distortion at all, and equal
          lengths stay equal anywhere on screen.
        </p>
      )}
    </div>
  );
}
