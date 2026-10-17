import { Injectable } from '@angular/core';

/** How far ahead of view an inline image starts loading: one scroller height. */
const ROOT_MARGIN = '100% 0px';

/**
 * Tells inline images when they come within one viewport of view, so a long room does not
 * fetch every image in its history. One `IntersectionObserver` per scroll root (the
 * timeline's and the thread's `[data-message-scroller]`, or the page for other bodies),
 * shared by every image under it: a root margin on the page alone would not reach past a
 * scroller's clip. `loading="lazy"` cannot do this: it does not apply to the blob URLs
 * authenticated media resolves to. Without `IntersectionObserver`, an image counts as near.
 */
@Injectable({ providedIn: 'root' })
export class InlineImageVisibility {
  private readonly scrollers = new WeakMap<Element, IntersectionObserver>();
  private page: IntersectionObserver | null = null;
  private readonly waiting = new Map<Element, () => void>();

  /** Run `onNear` once, when `target` first comes within reach. The returned function cancels it. */
  whenNear(target: Element, onNear: () => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      onNear();
      return () => undefined;
    }
    const observer = this.observerFor(
      target.closest('[data-message-scroller]'),
    );
    this.waiting.set(target, onNear);
    observer.observe(target);
    return () => {
      this.waiting.delete(target);
      observer.unobserve(target);
    };
  }

  private observerFor(root: Element | null): IntersectionObserver {
    const existing = root ? this.scrollers.get(root) : this.page;
    if (existing) {
      return existing;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const onNear = this.waiting.get(entry.target);
          if (!onNear) continue;
          this.waiting.delete(entry.target);
          observer.unobserve(entry.target);
          onNear();
        }
      },
      { root, rootMargin: ROOT_MARGIN },
    );
    if (root) {
      this.scrollers.set(root, observer);
    } else {
      this.page = observer;
    }
    return observer;
  }
}
