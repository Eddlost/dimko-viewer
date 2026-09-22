// Which point a click actually places.
//
// The reticle under the cursor is computed by a throttled, in-flight-guarded
// pick: at best it is 55 ms old, and while a pick is running new cursor
// positions are dropped entirely. If the click then runs its own fresh pick,
// the two can disagree — the snap pool is ordered by screen distance inside a
// 14 px radius, so three pixels of cursor travel are enough to hand the win to
// a different vertex. The point lands somewhere the user never saw a marker.
//
// So a click consumes the preview instead, as long as the cursor is still
// essentially where the preview was computed. Past that the preview was not
// describing this click and a fresh pick is the honest answer.

export type ScreenPoint = { x: number; y: number };

export type SnapPreview<T> = {
  /** Cursor position, in client pixels, the preview was computed for. */
  mouse: ScreenPoint;
  result: T;
};

/**
 * The previewed result when it still describes this click, otherwise null —
 * meaning the caller should pick afresh.
 *
 * `thresholdPx` is deliberately small. It is not a snap radius; it only
 * answers "is this the same click the reticle was drawn for".
 */
export function previewForClick<T>(
  preview: SnapPreview<T> | null,
  click: ScreenPoint,
  thresholdPx: number,
): T | null {
  if (!preview) return null;
  const dx = preview.mouse.x - click.x;
  const dy = preview.mouse.y - click.y;
  return Math.hypot(dx, dy) <= thresholdPx ? preview.result : null;
}
