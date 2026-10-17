import {
  DestroyRef,
  type ElementRef,
  type Signal,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { TrnSettingsParts } from './trn-settings-parts';

/**
 * Part navigation for the settings layout: scrolls to a part, follows the reader's scroll
 * with an IntersectionObserver and debounces the reported part. Create it in the layout's
 * constructor so its effects and teardown share the layout's injection context and lifetime.
 */
export class TrnSettingsScrollSpy {
  private readonly registry = inject(TrnSettingsParts);
  private readonly destroyRef = inject(DestroyRef);
  private shownSection: string | null | undefined;
  private pendingPart: string | null = null;
  private visibleParts = new Set<string>();
  private lastEmitted: string | null = null; // null: no fragment
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lockTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollLocked = false;

  constructor(
    private readonly detail: Signal<ElementRef<HTMLElement> | undefined>,
    private readonly selectedSection: Signal<string | null>,
    private readonly initialPart: Signal<string | null>,
    private readonly compact: Signal<boolean>,
    private readonly emit: (id: string | null) => void,
  ) {
    // A section change abandons any pending or in-flight scroll and starts at the top.
    effect(() => {
      const section = this.selectedSection();
      untracked(() => {
        // The first run only records the section, so it cannot undo an initial part.
        if (this.shownSection === undefined || this.shownSection === section) {
          this.shownSection = section;
          return;
        }
        this.shownSection = section;
        this.pendingPart = null;
        this.visibleParts = new Set();
        this.lastEmitted = null;
        this.endScrollLock();
        clearTimeout(this.emitTimer);
        clearTimeout(this.settleTimer);
        this.settleTimer = undefined;
        this.registry.current.set(null);
        const detail = this.detail()?.nativeElement;
        if (detail) {
          detail.scrollTop = 0;
        }
      });
    });

    effect(() => {
      const part = this.initialPart();
      untracked(() => {
        if (part && part !== this.registry.current()) {
          this.pendingPart = part;
          clearTimeout(this.settleTimer);
          this.settleTimer = undefined;
          this.resolvePending(this.registry.parts());
        }
      });
    });

    effect(() => this.resolvePending(this.registry.parts()));

    effect((onCleanup) => {
      const parts = this.registry.parts();
      const detail = this.detail()?.nativeElement;
      if (
        !detail ||
        parts.length === 0 ||
        typeof IntersectionObserver === 'undefined'
      ) {
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = parts.find((p) => p.heading === entry.target)?.id;
            if (!id) continue;
            if (entry.isIntersecting) this.visibleParts.add(id);
            else this.visibleParts.delete(id);
          }
          this.followScroll(detail);
        },
        { root: detail, rootMargin: '0px 0px -70% 0px' },
      );
      for (const part of parts) observer.observe(part.heading);
      const onScroll = (): void => this.followScroll(detail);
      detail.addEventListener('scroll', onScroll, { passive: true });
      detail.addEventListener('scrollend', this.onScrollEnd);
      onCleanup(() => {
        observer.disconnect();
        detail.removeEventListener('scroll', onScroll);
        detail.removeEventListener('scrollend', this.onScrollEnd);
      });
    });

    // Keep the compact chip for the current part in view.
    effect(() => {
      const id = this.registry.current();
      this.compact();
      const row = this.detail()?.nativeElement.querySelector<HTMLElement>(
        '.settings-layout__chips',
      );
      const chip = row?.querySelector<HTMLElement>(`[data-part="${id}"]`);
      if (row && chip) {
        row.scrollLeft =
          chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2;
      }
    });

    this.destroyRef.onDestroy(() => {
      clearTimeout(this.emitTimer);
      clearTimeout(this.lockTimer);
      clearTimeout(this.settleTimer);
    });
  }

  /**
   * Scroll to the pending part once registered. A part that is still absent a moment
   * later (groups may render late, e.g. behind a platform check) is reported as unknown.
   */
  private resolvePending(parts: readonly { id: string }[]): void {
    untracked(() => {
      const id = this.pendingPart;
      if (!id) {
        return;
      }
      if (parts.some((p) => p.id === id)) {
        clearTimeout(this.settleTimer);
        this.settleTimer = undefined;
        this.goToPart(id);
      } else if (this.settleTimer === undefined) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = undefined;
          if (this.pendingPart === id) {
            this.pendingPart = null;
            this.emit(null);
          }
        }, 1000);
      }
    });
  }

  goToPart(id: string): void {
    const part = this.registry.parts().find((p) => p.id === id);
    if (!part) {
      return;
    }
    this.pendingPart = null;
    const reduce =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The spy ignores the headings a smooth scroll passes over until it settles.
    if (!reduce) {
      this.scrollLocked = true;
      clearTimeout(this.lockTimer);
      this.lockTimer = setTimeout(this.endScrollLock, 800);
    }
    // Scroll the content column alone (scrollIntoView would also move its ancestors), and
    // stop below the sticky chip row, which only exists while compact.
    const detail = this.detail()?.nativeElement;
    if (detail) {
      const chips = detail.querySelector<HTMLElement>(
        '.settings-layout__chips',
      );
      const clearance = this.compact() && chips ? chips.offsetHeight : 0;
      detail.style.scrollPaddingTop = clearance ? `${clearance}px` : '';
      detail.scrollTo({
        top:
          part.heading.getBoundingClientRect().top -
          detail.getBoundingClientRect().top +
          detail.scrollTop -
          clearance,
        behavior: reduce ? 'auto' : 'smooth',
      });
    }
    part.heading.focus({ preventScroll: true });
    this.registry.current.set(id);
    this.emitNow(id);
  }

  private readonly endScrollLock = (): void => {
    this.scrollLocked = false;
    clearTimeout(this.lockTimer);
  };

  /**
   * The scroll has really stopped. A scroll the reader started while the spy was held
   * (a wheel back up during a part's smooth scroll) was ignored, so catch up with it.
   */
  private readonly onScrollEnd = (): void => {
    const held = this.scrollLocked;
    this.endScrollLock();
    const detail = this.detail()?.nativeElement;
    if (held && detail) this.followScroll(detail);
  };

  private emitNow(id: string | null): void {
    clearTimeout(this.emitTimer);
    this.lastEmitted = id;
    this.emit(id);
  }

  /** Top-most visible heading wins; the page ends on the last part, its top on the first. */
  private followScroll(detail: HTMLElement): void {
    if (this.scrollLocked) {
      return;
    }
    const parts = this.registry.parts();
    const scrollable = detail.scrollHeight > detail.clientHeight;
    const atBottom =
      scrollable &&
      detail.scrollTop + detail.clientHeight >= detail.scrollHeight - 1;
    const top = !atBottom && detail.scrollTop === 0;
    // At the top an untitled leading block can precede the first part: then none is current.
    const id = atBottom
      ? parts.at(-1)?.id
      : parts.find((p) => this.visibleParts.has(p.id))?.id;
    if (!id && !top) {
      return;
    }
    this.registry.current.set(id ?? null);
    // The top of the page is the section itself: it carries no fragment.
    const emit = top ? null : (id ?? null);
    clearTimeout(this.emitTimer);
    if (emit !== this.lastEmitted) {
      this.emitTimer = setTimeout(() => this.emitNow(emit), 200);
    }
  }
}
