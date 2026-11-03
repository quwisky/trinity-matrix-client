/** Pure maths for the image viewer's touch gestures; the component applies the results. */

export interface ViewPoint {
  readonly x: number;
  readonly y: number;
}

/** Zoom and pan; `x` and `y` translate the image from its centred rest position. */
export interface ImageView extends ViewPoint {
  readonly scale: number;
}

export const REST_VIEW: ImageView = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2.5;

const TAP_MAX_TRAVEL_PX = 10;
const TAP_MAX_MS = 300;
const DOUBLE_TAP_MAX_GAP_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 40;
/** A swipe down past this fraction of the viewer's height dismisses it. */
const DISMISS_FRACTION = 0.2;
/** px per ms; a flick this fast dismisses too, once it has travelled {@link FLICK_MIN_PX}. */
const FLICK_VELOCITY = 0.5;
const FLICK_MIN_PX = 40;

export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(1, scale));

/** The size a `contain`-fitted image really occupies inside its element box. */
export function containedSize(
  box: { readonly width: number; readonly height: number },
  natural: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  if (!natural.width || !natural.height || !box.width || !box.height)
    return box;
  const fit = Math.min(box.width / natural.width, box.height / natural.height);
  return { width: natural.width * fit, height: natural.height * fit };
}

/** Keeps a zoomed image covering its own box: no pan at rest, half the overshoot each way. */
export function clampView(
  view: ImageView,
  box: { readonly width: number; readonly height: number },
): ImageView {
  const scale = clampScale(view.scale);
  const limitX = ((scale - 1) * box.width) / 2;
  const limitY = ((scale - 1) * box.height) / 2;
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  };
}

/**
 * Re-scales a view so the image point under `focal` (measured from the box centre) stays
 * under it, the way a pinch or a double tap feels anchored to the fingers.
 */
export function zoomAbout(
  view: ImageView,
  nextScale: number,
  focal: ViewPoint,
): ImageView {
  const ratio = nextScale / view.scale;
  return {
    scale: nextScale,
    x: focal.x - (focal.x - view.x) * ratio,
    y: focal.y - (focal.y - view.y) * ratio,
  };
}

/** Double tap: back to rest when zoomed, otherwise in on the tapped point. */
export function doubleTapView(view: ImageView, focal: ViewPoint): ImageView {
  return view.scale > 1 ? REST_VIEW : zoomAbout(view, DOUBLE_TAP_SCALE, focal);
}

export const isTap = (travelPx: number, durationMs: number): boolean =>
  travelPx <= TAP_MAX_TRAVEL_PX && durationMs <= TAP_MAX_MS;

export function isDoubleTap(
  previous: { readonly at: number; readonly point: ViewPoint } | null,
  at: number,
  point: ViewPoint,
): boolean {
  return (
    previous !== null &&
    at - previous.at <= DOUBLE_TAP_MAX_GAP_MS &&
    Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <=
      DOUBLE_TAP_MAX_DISTANCE_PX
  );
}

/** Whether a finished swipe down travelled far enough, or fast enough, to close the viewer. */
export function shouldDismiss(
  dy: number,
  durationMs: number,
  height: number,
): boolean {
  return (
    dy / height > DISMISS_FRACTION ||
    (dy > FLICK_MIN_PX && dy / Math.max(1, durationMs) > FLICK_VELOCITY)
  );
}

/** How much of the backdrop is left while the image is dragged down (1 at rest). */
export const backdropOpacity = (dy: number, height: number): number =>
  Math.max(0.3, 1 - dy / height);
