import {
  DestroyRef,
  type ElementRef,
  type Signal,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { PendingInvite } from '@trinity/data-access/room-library';
import {
  buildPrefixSums,
  computeWindow,
  scrollCompensation,
  type HeightChange,
  type WindowResult,
} from '../../message-list/virtual-window';
import type { SidebarItem } from './sidebar-room-list.component';

/** At or below this many lines, render every one (windowing is not worth it). */
const SMALL_LIST_ITEMS = 80;

/** Rendered beyond the viewport on each side, so a fast scroll does not show blanks. */
const OVERSCAN_PX = 400;

/** A room row's height before any has been measured: a two-line row at default density. */
const ESTIMATED_ROW_PX = 52;

/**
 * Windowing for the sidebar room list: follows the scroller, measures the rendered lines and
 * computes which lines render and the pads around them. Create it in a field initialiser of
 * the list so its effects and teardown share the list's injection context and lifetime.
 */
export class SidebarListWindow {
  private readonly destroyRef = inject(DestroyRef);

  // Windowing state. `scrollTop` and `viewportH` come from the scroller; `regionTop` is where the
  // windowed lines start inside it (below the invites); `measured` keeps each rendered line's real
  // height, bumping `heightVersion` when one changes.
  private readonly scrollTop = signal(0);
  private readonly viewportH = signal(0);
  private readonly regionTop = signal(0);
  private readonly heightVersion = signal(0);
  private readonly measured = new Map<string, number>();
  private readonly observed = new Map<Element, string>();
  private itemObserver?: ResizeObserver;

  private readonly ids = computed(() => this.items().map((item) => item.key));

  /** Measured room rows' typical height, standing in for rows not rendered yet. */
  private readonly estimate = computed(() => {
    this.heightVersion();
    let sum = 0;
    let count = 0;
    for (const [key, height] of this.measured) {
      if (key.includes(':')) continue; // labels and dividers are not room rows
      sum += height;
      count++;
    }
    return count ? sum / count : ESTIMATED_ROW_PX;
  });

  private readonly prefix = computed(() => {
    this.heightVersion();
    return buildPrefixSums(this.ids(), {
      measured: this.measured,
      estimate: this.estimate(),
    });
  });

  private readonly windowResult = computed<WindowResult>(() =>
    computeWindow(
      {
        ids: this.ids(),
        heights: { measured: this.measured, estimate: this.estimate() },
        scrollTop: Math.max(0, this.scrollTop() - this.regionTop()),
        viewportHeight: this.viewportH(),
        overscanPx: OVERSCAN_PX,
        pinBottom: false,
        smallListThreshold: SMALL_LIST_ITEMS,
        enabled: this.scroller() !== null && this.viewportH() > 0,
      },
      this.prefix(),
    ),
  );

  /** The lines actually rendered. */
  readonly windowedItems = computed(() => {
    const { startIndex, endIndex } = this.windowResult();
    const all = this.items();
    if (endIndex < 0) return [];
    return startIndex === 0 && endIndex === all.length - 1
      ? all
      : all.slice(startIndex, endIndex + 1);
  });
  readonly topPad = computed(() => this.windowResult().topPadPx);
  readonly bottomPad = computed(() => this.windowResult().bottomPadPx);

  constructor(
    private readonly items: Signal<readonly SidebarItem[]>,
    private readonly scroller: Signal<HTMLElement | null>,
    private readonly invites: Signal<readonly PendingInvite[]>,
    private readonly topSpacer: Signal<ElementRef<HTMLElement> | undefined>,
    private readonly itemHosts: Signal<readonly ElementRef<Element>[]>,
  ) {
    // Follow the scroller. A plain listener rather than a template binding, so a scroll that keeps the
    // same lines rendered costs one signal write and a cheap recompute, not a change-detection pass per event.
    effect((onCleanup) => {
      const el = this.scroller();
      if (!el) return;
      const onScroll = () => this.scrollTop.set(el.scrollTop);
      el.addEventListener('scroll', onScroll, { passive: true });
      this.viewportH.set(el.clientHeight);
      this.scrollTop.set(el.scrollTop);
      let viewport: ResizeObserver | undefined;
      if (typeof ResizeObserver !== 'undefined') {
        viewport = new ResizeObserver(() => {
          this.viewportH.set(el.clientHeight);
          this.measureRegionTop();
        });
        viewport.observe(el);
      }
      onCleanup(() => {
        el.removeEventListener('scroll', onScroll);
        viewport?.disconnect();
      });
    });

    // Invites render above the windowed lines; when they come or go, the lines move.
    afterRenderEffect({
      read: () => {
        this.invites(); // tracked: invites render above the windowed lines
        untracked(() => this.measureRegionTop());
      },
    });

    // Measure the rendered lines; stop measuring ones that left the window.
    afterRenderEffect({
      read: () => this.reconcileObserved(this.itemHosts()),
    });

    this.destroyRef.onDestroy(() => this.itemObserver?.disconnect());
  }

  /**
   * Where the windowed lines start inside the scroller. Read on resize and when the invites change,
   * not per scroll: the offset does not move when the list scrolls.
   */
  private measureRegionTop(): void {
    const el = this.scroller();
    const spacer = this.topSpacer()?.nativeElement;
    if (!el || !spacer) return;
    this.regionTop.set(
      spacer.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop,
    );
  }

  /** The box to measure for one rendered line; a row's host is `display: contents`. */
  private measureTarget(host: Element): Element | null {
    return host.tagName === 'TRN-SIDEBAR-ROOM-ROW'
      ? host.firstElementChild
      : host;
  }

  private reconcileObserved(hosts: readonly ElementRef<Element>[]): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.itemObserver ??= new ResizeObserver((entries) =>
      this.onItemsResized(entries),
    );
    const seen = new Set<Element>();
    for (const { nativeElement } of hosts) {
      const key = nativeElement.getAttribute('data-sidebar-key');
      const target = this.measureTarget(nativeElement);
      if (!key || !target) continue;
      seen.add(target);
      if (!this.observed.has(target)) {
        this.observed.set(target, key);
        this.itemObserver.observe(target);
      }
    }
    for (const [target] of this.observed) {
      if (!seen.has(target)) {
        this.itemObserver.unobserve(target);
        this.observed.delete(target);
      }
    }
  }

  /** Record real heights, keeping the visible lines still when one above them changes. */
  private onItemsResized(entries: readonly ResizeObserverEntry[]): void {
    const el = this.scroller();
    const prefix = untracked(this.prefix);
    const ids = untracked(this.ids);
    const estimate = untracked(this.estimate);
    const changes: HeightChange[] = [];
    for (const entry of entries) {
      const key = this.observed.get(entry.target);
      if (key === undefined) continue;
      const height =
        entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      const prior = this.measured.get(key);
      if (height <= 0 || height === prior) continue;
      this.measured.set(key, height);
      const index = ids.indexOf(key);
      if (index >= 0) {
        changes.push({ index, prior: prior ?? estimate, next: height });
      }
    }
    if (!changes.length) return;
    if (el) {
      const top = el.scrollTop;
      const delta = scrollCompensation(
        changes,
        prefix,
        top,
        untracked(this.regionTop),
      );
      if (delta !== 0) {
        el.scrollTop = Math.max(0, top + delta);
        this.scrollTop.set(el.scrollTop);
      }
    }
    this.heightVersion.update((v) => v + 1);
  }
}
