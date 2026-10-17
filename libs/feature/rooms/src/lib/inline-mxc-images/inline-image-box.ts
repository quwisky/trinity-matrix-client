/**
 * The box an inline image takes before and after it loads, and how a concealed spoiler
 * hides it. The height cap has one source: `--trinity-message-image-max-height` on
 * `img.mx-image` in `apps/trinity/src/rendered-markdown.scss`, which is also the image's
 * `max-height`; the reserved width below reads the same property.
 */

/**
 * What a loading inline image shows until its thumbnail arrives: a 1×1 transparent GIF, inline
 * (CSP `img-src` allows `data:`), so nothing is fetched and nothing is pinned. Without a source
 * the browser draws its broken-image icon in the loading box.
 */
export const LOADING_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The stylesheet's cap on an inline image's height, as a CSS value. */
const IMAGE_MAX_HEIGHT = 'var(--trinity-message-image-max-height)';
/** Largest sender `width`/`height` trusted to reserve a box. */
const MAX_RESERVED_PX = 10_000;
/** A sender size as the only form trusted: 1–5 digits, nothing else. */
const SENDER_SIZE = /^\d{1,5}$/;

/** A sender's `width` or `height`, if it is a plain integer from 1 to {@link MAX_RESERVED_PX}. */
export function senderSize(value: string | null): number | null {
  if (value === null || !SENDER_SIZE.test(value)) {
    return null;
  }
  const size = Number(value);
  return size >= 1 && size <= MAX_RESERVED_PX ? size : null;
}

/**
 * Reserve the box a sender's `width` and `height` describe, so the row does not jump: the
 * same aspect ratio, no wider than the sender's width or the height cap allows. The
 * stylesheet's `max-height` holds the cap whatever the width rounds to. The attributes go
 * either way, so a sender's `height="20000"` is never drawn as a presentational hint.
 */
export function reserveBox(image: HTMLImageElement): void {
  const width = senderSize(image.getAttribute('width'));
  const height = senderSize(image.getAttribute('height'));
  image.removeAttribute('width');
  image.removeAttribute('height');
  if (width === null || height === null) {
    return;
  }
  image.style.setProperty('aspect-ratio', `${width} / ${height}`);
  image.style.width = `min(${width}px, calc(${IMAGE_MAX_HEIGHT} * ${width} / ${height}))`;
}

/**
 * Take an image a spoiler conceals out of the tab order and the accessibility tree, so
 * assistive tech does not announce "View image: <alt>" inside a hidden spoiler. Defence in
 * depth beside the stylesheet's `visibility: hidden`.
 */
export function conceal(image: HTMLImageElement): void {
  image.setAttribute('aria-hidden', 'true');
  if (image.getAttribute('role') === 'button') {
    image.setAttribute('tabindex', '-1');
  }
}

/** Undo {@link conceal} once every spoiler around the image is revealed. */
export function unconceal(image: HTMLImageElement): void {
  image.removeAttribute('aria-hidden');
  if (image.getAttribute('role') === 'button') {
    image.setAttribute('tabindex', '0');
  }
}

/** Marks a concealed spoiler whose only content is collapsed images; the stylesheet labels it. */
export const IMAGE_ONLY_SPOILER = 'mx-spoiler--image-only';
const CONCEALED_SPOILER = '.mx-spoiler:not(.is-revealed)';

/**
 * Keep a concealed image's spoiler visible: a concealed image takes no space, so a spoiler
 * holding nothing else would draw no bar. Marks the outermost concealed spoiler around
 * `image` (within `host`) that has no text of its own, so nested spoilers draw one bar;
 * call it again after a reveal to mark the next one in.
 */
export function markImageOnlySpoiler(
  image: HTMLImageElement,
  host: HTMLElement,
): void {
  let outermost: HTMLElement | null = null;
  for (
    let spoiler = image.closest<HTMLElement>(CONCEALED_SPOILER);
    spoiler && host.contains(spoiler);
    spoiler =
      spoiler.parentElement?.closest<HTMLElement>(CONCEALED_SPOILER) ?? null
  ) {
    outermost = spoiler;
  }
  if (outermost && !outermost.textContent?.trim()) {
    outermost.classList.add(IMAGE_ONLY_SPOILER);
  }
}
