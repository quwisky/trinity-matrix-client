import { DOCUMENT, inject, InjectionToken } from '@angular/core';

/** CSS px the timeline gives a media thumbnail's long edge. */
const DISPLAY_THUMBNAIL_CSS_PX = 320;

/**
 * Edges (px) a display thumbnail is rounded up to, one per 1x/2x/3x screen, so cache keys and
 * server thumbnail requests stay stable across ratios like 1.25x and 1.75x. The server answers
 * a `scale` request with its nearest configured size at least as large, else the nearest
 * smaller one. Synapse's default `thumbnail_sizes` scale to 320×240, 640×480 and 800×600 (plus
 * 32 and 96 px crops), so it serves 320 and 640 exactly and 960 from 800×600.
 */
const DISPLAY_THUMBNAIL_BUCKETS = [320, 640, 960] as const;

/** Highest ratio thumbnails are sized for; denser screens get the 3x bucket. */
const MAX_DEVICE_PIXEL_RATIO = 3;

export type DisplayThumbnailEdge = (typeof DISPLAY_THUMBNAIL_BUCKETS)[number];

/**
 * Long edge (px) of a thumbnail generated when the media is sent. Fixed rather than sized to
 * the sender's screen because other people's devices view it: 640 px (2 × 320) stays sharp on
 * common 2x screens, and a 3x screen asks the server for its own size when the event ships none.
 */
export const UPLOAD_THUMBNAIL_PX = 640;

/**
 * Reads the screen's current `devicePixelRatio`, or 1 where there is no window. It is a
 * function so callers read the ratio when they resolve a thumbnail: after the window moves
 * to a screen with another ratio, new thumbnails use the new bucket.
 */
export const DEVICE_PIXEL_RATIO = new InjectionToken<() => number>(
  'DEVICE_PIXEL_RATIO',
  {
    providedIn: 'root',
    factory: () => {
      const view = inject(DOCUMENT).defaultView;
      return () => view?.devicePixelRatio ?? 1;
    },
  },
);

/**
 * The thumbnail bucket for a screen: the smallest bucket at least `320 × dpr` px, with the
 * ratio clamped to [1, 3]. A ratio that is not a positive finite number counts as 1.
 */
export function displayThumbnailEdge(dpr: number): DisplayThumbnailEdge {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const clamped = Math.min(Math.max(ratio, 1), MAX_DEVICE_PIXEL_RATIO);
  const target = Math.ceil(DISPLAY_THUMBNAIL_CSS_PX * clamped);
  return (
    DISPLAY_THUMBNAIL_BUCKETS.find((edge) => edge >= target) ??
    DISPLAY_THUMBNAIL_BUCKETS[DISPLAY_THUMBNAIL_BUCKETS.length - 1]
  );
}
