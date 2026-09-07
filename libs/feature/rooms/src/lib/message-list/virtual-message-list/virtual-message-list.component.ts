import { EmptyStateComponent } from '@trinity/components/generic-content';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { MessageComposerComponent } from '../../message-composer/message-composer.component';
import { MessageRowComponent } from '../../message-row/message-row.component';
import { MessageListBase } from '../message-list-base';
import { TrnFileDropDirective } from '../../shared/file-drop.directive';
import { DropOverlayComponent } from '../drop-overlay/drop-overlay.component';
import { TimelineDividerComponent } from '../timeline-divider/timeline-divider.component';
import { TypingIndicatorComponent } from '../typing-indicator/typing-indicator.component';
import { scrollBehavior } from '@trinity/util/ui';
import {
  buildPrefixSums,
  computeWindow,
  offsetOf,
  scrollCompensation,
  type HeightChange,
  type WindowResult,
} from '../virtual-window';

/** Trigger older-history loading when the scroll top gets within this many px. */
const AUTO_LOAD_THRESHOLD_PX = 150;

/** Treat the viewport as "at the bottom" within this many px of the end. */
const NEAR_BOTTOM_PX = 120;

/** Safety cap on consecutive auto-backfill rounds for one fill sequence. */
const MAX_BACKFILL_ROUNDS = 20;

/**
 * Seed height (px) for a row not yet rendered/measured — a rough average message
 * height, used only to size the off-screen spacers until real heights are recorded.
 */
const ESTIMATED_ROW_HEIGHT_PX = 64;

/** Extra pixels rendered above and below the viewport to hide window-boundary churn. */
const OVERSCAN_PX = 800;

/** At or below this many rows, render everything (windowing isn't worth it). */
const SMALL_LIST_ROWS = 80;

/**
 * Windowed (virtualized) variant of the room timeline: renders only the rows in (and
 * near) the viewport plus top/bottom spacer divs, bounding the DOM in long rooms.
 * Selected in place of {@link SimpleMessageListComponent} when the experimental
 * virtualized-timeline flag is on; shared logic lives in {@link MessageListBase}.
 *
 * Trade-off vs the plain list: native in-page find (Ctrl-F), linear screen-reader
 * reading order, and cross-row text selection only cover the rendered rows.
 */
@Component({
  selector: 'trn-virtual-message-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    MessageComposerComponent,
    MessageRowComponent,
    DropOverlayComponent,
    TimelineDividerComponent,
    TypingIndicatorComponent,
  ],
  // The whole conversation is the drop target — "drop it on the room" is the gesture, and
  // these templates are host fragments with no element of their own to carry it.
  hostDirectives: [
    {
      directive: TrnFileDropDirective,
      // Neither is exposed on this element, and both are stated so that is a decision rather
      // than an omission (see `scripts/host-directives.spec.mjs`). `filesDropped` in
      // particular is deliberately NOT re-exported: `MessageListBase` subscribes to it
      // directly, so a host binding would be a second, silently divergent way in.
      inputs: [],
      outputs: [],
    },
  ],
  templateUrl: './virtual-message-list.component.html',
  styleUrl: './virtual-message-list.component.scss',
})
export class VirtualMessageListComponent extends MessageListBase {
  private lastId = '';
  /** Whether the user is scrolled to (or near) the bottom — gates auto-scroll and
   * pins the window to the newest row. A signal so windowing reacts to it. */
  private readonly atBottomSig = signal(true);

  // Scroll-anchoring state while older history is being prepended.
  private pendingPrepend = false;
  private prevScrollHeight = 0;
  private prevScrollTop = 0;

  // Backfill state — see SimpleMessageListComponent for the rationale (tracked by oldest id).
  private backfilling = false;
  // Null (not '') so an EMPTY projection still counts as "history not yet requested" — a
  // room whose whole loaded window is hidden system lines would otherwise compare '' to ''
  // and never backfill, leaving a permanently blank timeline with no scrollbar to recover
  // from.
  private lastBackfillOldestId: string | null = null;
  private backfillRounds = 0;

  // Windowing state. `scrollTop`/`viewportH` drive which rows are in view; `measured`
  // records real row heights (bumping `heightVersion` to recompute the prefix sums).
  private readonly scrollTop = signal(0);
  private readonly viewportH = signal(0);
  private readonly heightVersion = signal(0);
  private measured = new Map<string, number>();
  private ro?: ResizeObserver;
  /** Currently-observed `.msg` elements → their row id. */
  private readonly observed = new Map<Element, string>();
  // Reference row + its viewport offset, captured before a load-older so scroll can
  // be restored to it afterward (a raw scrollHeight delta drifts under windowing,
  // where the prepended rows are estimated spacer height, not real).
  private prependAnchorId = '';
  private prependAnchorOffset = 0;
  /** Keep the captured row fixed while the first rendered rows settle their heights. */
  private prependAnchorActive = false;
  private prependAnchorGeneration = 0;
  /** Last scrollTop written by our own correction; distinguishes it from user movement. */
  private expectedProgrammaticScrollTop: number | null = null;

  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  /** Rendered row hosts, to observe their `.msg` boxes for height measurement. */
  private readonly rowHosts = viewChildren(MessageRowComponent, {
    read: ElementRef,
  });

  /** Row ids in timeline order — the windowing key. */
  private readonly ids = computed(() => this.rows().map((r) => r.id));

  /** Prefix sums of row heights; recomputed when rows change or a height updates. */
  private readonly prefix = computed(() => {
    this.heightVersion();
    return buildPrefixSums(this.ids(), {
      measured: this.measured,
      estimate: ESTIMATED_ROW_HEIGHT_PX,
    });
  });

  /** Resolved render range + spacer heights (render-all fast path for short rooms). */
  private readonly windowResult = computed<WindowResult>(() =>
    computeWindow(
      {
        ids: this.ids(),
        heights: { measured: this.measured, estimate: ESTIMATED_ROW_HEIGHT_PX },
        scrollTop: this.scrollTop(),
        viewportHeight: this.viewportH(),
        overscanPx: OVERSCAN_PX,
        pinBottom: this.atBottomSig(),
        smallListThreshold: SMALL_LIST_ROWS,
        enabled: true,
      },
      this.prefix(),
    ),
  );

  /** The rows actually rendered — the full list sliced to the window. */
  readonly windowedRows = computed(() => {
    const w = this.windowResult();
    if (w.endIndex < 0) {
      return [];
    }
    const all = this.rows();
    // Short room: the window is the whole list — return the same reference so `@for`
    // sees no change and nothing is copied.
    if (w.startIndex === 0 && w.endIndex === all.length - 1) {
      return all;
    }
    return all.slice(w.startIndex, w.endIndex + 1);
  });

  /** Height of the top spacer standing in for off-screen rows above the window. */
  readonly topPad = computed(() => this.windowResult().topPadPx);
  /** Height of the bottom spacer standing in for off-screen rows below the window. */
  readonly bottomPad = computed(() => this.windowResult().bottomPadPx);

  /** Reactive mirror of `!atBottom` for the template's jump-to-latest pill. */
  protected readonly notAtBottom = computed(() => !this.atBottomSig());

  constructor() {
    super();

    effect(() => {
      const msgs = this.messages();
      // The delayed loading strip changes row geometry before history arrives too.
      this.showLoadingOlder();
      const el = this.scrollEl()?.nativeElement;
      if (!el) {
        return;
      }

      if (this.pendingPrepend) {
        // Keep the viewport anchored on what the user was reading.
        // Keep the same restore point through the loading strip and the final prepend.
        this.pendingPrepend = this.loadingOlder();
        this.lastId = msgs[msgs.length - 1]?.id ?? this.lastId;
        const prevHeight = this.prevScrollHeight;
        const prevTop = this.prevScrollTop;
        const anchorId = this.prependAnchorId;
        const anchorOffset = this.prependAnchorOffset;
        const anchorGeneration = this.prependAnchorGeneration;
        this.prependAnchorActive = true;
        // Correct as soon as the strip/prepend renders, before another scroll event
        // can capture its displaced geometry as the reader's intended position.
        untracked(() =>
          afterNextRender(
            () => {
              this.restorePrependAnchor(
                el,
                anchorId,
                anchorOffset,
                prevHeight,
                prevTop,
                anchorGeneration,
              );
            },
            { injector: this.injector },
          ),
        );
        return;
      }

      const hadPrevious = !!this.lastId;
      const latest = msgs[msgs.length - 1];
      const newest = latest?.id ?? '';
      const newestChanged = !!newest && newest !== this.lastId;
      this.lastId = newest || this.lastId;
      if (newestChanged) {
        this.backfillRounds = 0;
        if (
          hadPrevious &&
          latest &&
          !latest.isOwn &&
          !latest.decryptionFailed &&
          latest.kind !== 'redacted' &&
          latest.kind !== 'event'
        ) {
          this.announcement.set(`${latest.senderName}: ${latest.body}`);
        }
      }
      // Read the at-bottom signal untracked so this effect keeps firing only on
      // messages().
      const stickToBottom =
        (newestChanged &&
          (untracked(() => this.atBottomSig()) || !!latest?.isOwn)) ||
        this.backfilling;

      requestAnimationFrame(() => {
        if (stickToBottom) {
          el.scrollTop = el.scrollHeight;
          this.scrollTop.set(el.scrollTop);
        }

        const notFull = el.scrollHeight <= el.clientHeight + 1;
        const oldestId = this.oldestEventId();
        const prependedOlder = oldestId !== this.lastBackfillOldestId;
        if (
          notFull &&
          this.canLoadOlder() &&
          !this.loadingOlder() &&
          !this.pendingPrepend &&
          prependedOlder &&
          this.backfillRounds < MAX_BACKFILL_ROUNDS
        ) {
          this.backfilling = true;
          this.lastBackfillOldestId = oldestId;
          this.backfillRounds++;
          this.loadOlder.emit();
        } else {
          this.backfilling = false;
        }
      });
    });

    // Scroll to an externally-requested event (search / reply / pinned-panel jump).
    // jumpTo reads ids()/prefix(); run it untracked so this fires only on a NEW jump
    // request — not on every timeline/height change, which would keep yanking the
    // viewport back. jumpToNonce makes a repeat request to the same id re-fire.
    effect(() => {
      this.jumpToNonce();
      const id = this.jumpToId();
      if (id) {
        untracked(() => this.jumpTo(id));
      }
    });

    // Keep the observed set of rendered rows in sync with the window.
    effect(() => {
      const hosts = this.rowHosts();
      this.reconcileObserved(hosts);
    });

    // After first render: measure the viewport and create the observers.
    afterNextRender(() => {
      const el = this.scrollEl()?.nativeElement;
      if (!el) {
        return;
      }
      this.viewportH.set(el.clientHeight);
      if (typeof ResizeObserver === 'undefined') {
        return; // jsdom / SSR — degrades to render-all via estimate heights.
      }
      this.ro = new ResizeObserver((entries) => this.onRowsResized(entries));
      this.watchScrollerHeight((height, scrollTop) => {
        this.viewportH.set(height);
        this.scrollTop.set(scrollTop);
      });
      this.watchScrollerWidth();
      this.reconcileObserved(this.rowHosts());
    });

    this.destroyRef.onDestroy(() => {
      this.ro?.disconnect();
    });
  }

  protected override resetOnRoomChange(): void {
    super.resetOnRoomChange();
    this.lastId = '';
    this.lastBackfillOldestId = null;
    this.backfillRounds = 0;
    this.pendingPrepend = false;
    this.prependAnchorActive = false;
    this.prependAnchorGeneration++;
    this.expectedProgrammaticScrollTop = null;
    this.atBottomSig.set(true);
    // Forget the old room's measured heights and scroll position so the new room
    // starts from the top with fresh estimates.
    this.measured.clear();
    this.scrollTop.set(0);
    this.heightVersion.update((v) => v + 1);
  }

  /** Auto-load older history once the user scrolls near the top. */
  onScroll(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    if (this.expectedProgrammaticScrollTop !== null) {
      if (Math.abs(el.scrollTop - this.expectedProgrammaticScrollTop) < 1) {
        this.expectedProgrammaticScrollTop = null;
      } else {
        this.prependAnchorActive = false;
        this.prependAnchorGeneration++;
        this.expectedProgrammaticScrollTop = null;
      }
    } else if (this.prependAnchorActive) {
      // A subsequent user scroll starts a new read position; the prepend lock must not
      // keep correcting that intentional movement.
      this.prependAnchorActive = false;
      this.prependAnchorGeneration++;
    }
    this.scrollTop.set(el.scrollTop);
    this.atBottomSig.set(
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX,
    );
    this.updateJumpToUnread(); // divider may have scrolled in/out of the window
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (this.loadingOlder() && bottomGap >= 1) {
      // A reader can move while an earlier automatic backfill is still in flight.
      // Transfer its restore point even inside the incoming-message near-bottom
      // threshold: only an exact bottom pin has no reading offset to preserve.
      this.prevScrollHeight = el.scrollHeight;
      this.prevScrollTop = el.scrollTop;
      this.capturePrependAnchor(el);
      this.pendingPrepend = true;
      this.backfilling = false;
      return;
    }
    if (this.pendingPrepend || this.loadingOlder() || !this.canLoadOlder()) {
      return;
    }
    if (el.scrollTop < AUTO_LOAD_THRESHOLD_PX) {
      this.prevScrollHeight = el.scrollHeight;
      this.prevScrollTop = el.scrollTop;
      this.capturePrependAnchor(el);
      this.pendingPrepend = true;
      this.loadOlder.emit();
    }
  }

  /** Jump back to the newest message (the jump-to-latest pill). */
  scrollToLatest(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    // This explicit destination supersedes both an in-flight history restore and
    // any measurement correction already queued for its old reading position.
    this.pendingPrepend = false;
    this.prependAnchorActive = false;
    this.prependAnchorGeneration++;
    this.expectedProgrammaticScrollTop = null;
    // Pin the window to the bottom, then scroll to the end once it has re-rendered
    // the newest rows (the spacer heights shift when the window moves).
    this.atBottomSig.set(true);
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      this.scrollTop.set(el.scrollTop);
    });
  }

  /**
   * Record the first rendered `.msg` reaching into the viewport and its offset from
   * the viewport top, so scroll position can be restored to it after older history
   * prepends (see the prepend branch of the anchoring effect).
   */
  private capturePrependAnchor(el: HTMLElement): void {
    this.prependAnchorId = '';
    const top = el.getBoundingClientRect().top;
    for (const m of Array.from(el.querySelectorAll('.msg'))) {
      const rect = m.getBoundingClientRect();
      if (rect.bottom > top) {
        this.prependAnchorId = m.getAttribute('data-mid') ?? '';
        this.prependAnchorOffset = rect.top - top;
        return;
      }
    }
  }

  /**
   * Content offset of the row region (the first `.vpad` spacer) from the scroll
   * origin — the `.scroll` padding plus any `.load-older` banner rendered above the
   * rows. `offsetOf()` measures from the top of that region while `scrollTop` is
   * physical, so this bridges the two coordinate systems.
   */
  private rowsRegionTop(el: HTMLElement): number {
    const firstVpad = el.querySelector('.vpad');
    if (!firstVpad) {
      return 0;
    }
    return (
      firstVpad.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop
    );
  }

  /**
   * Observe the `.msg` box of every rendered row (adding new ones, dropping rows
   * that left the window). Observing a fresh element fires an immediate callback with
   * its size — that's how newly-rendered rows get measured.
   */
  private reconcileObserved(hosts: readonly ElementRef<HTMLElement>[]): void {
    if (!this.ro) {
      return; // observers not created yet (pre first render)
    }
    const seen = new Set<Element>();
    for (const host of hosts) {
      const msg = host.nativeElement.querySelector('.msg');
      if (!msg) {
        continue;
      }
      seen.add(msg);
      if (!this.observed.has(msg)) {
        const mid = msg.getAttribute('data-mid');
        if (mid) {
          this.observed.set(msg, mid);
          this.ro.observe(msg);
        }
      }
    }
    for (const [el] of this.observed) {
      if (!seen.has(el)) {
        this.ro.unobserve(el);
        this.observed.delete(el);
      }
    }
  }

  /**
   * Record measured row heights and keep the read position stable. The signal writes
   * below schedule change detection on their own under zoneless.
   */
  private onRowsResized(entries: ResizeObserverEntry[]): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    const atBottom = untracked(() => this.atBottomSig());
    const prefixSnapshot = this.prefix(); // pre-update offsets
    const idList = this.ids();
    const st = el.scrollTop;
    const changes: HeightChange[] = [];
    let changed = false;
    for (const entry of entries) {
      const mid = this.observed.get(entry.target);
      if (mid === undefined) {
        continue;
      }
      const newH =
        entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      const prior = this.measured.get(mid);
      if (newH <= 0 || newH === prior) {
        continue;
      }
      this.measured.set(mid, newH);
      changed = true;
      const idx = idList.indexOf(mid);
      if (idx >= 0) {
        // `prior` is the pre-update height — the estimate for a first measurement.
        changes.push({
          index: idx,
          prior: prior ?? ESTIMATED_ROW_HEIGHT_PX,
          next: newH,
        });
      }
    }
    if (!changed) {
      return;
    }
    if (this.prependAnchorActive) {
      // ResizeObserver runs after the prepend restore and can replace estimated spacer
      // heights with real measurements. Correct from the rendered anchor after each such
      // batch so the measured row remains in the same viewport position.
      const anchorGeneration = this.prependAnchorGeneration;
      const anchorId = this.prependAnchorId;
      const anchorOffset = this.prependAnchorOffset;
      const prevHeight = this.prevScrollHeight;
      const prevTop = this.prevScrollTop;
      requestAnimationFrame(() => {
        if (
          this.destroyRef.destroyed ||
          !this.prependAnchorActive ||
          anchorGeneration !== this.prependAnchorGeneration
        ) {
          return;
        }
        this.restorePrependAnchor(
          el,
          anchorId,
          anchorOffset,
          prevHeight,
          prevTop,
          anchorGeneration,
        );
      });
      this.heightVersion.update((v) => v + 1);
      return;
    }
    if (atBottom) {
      // Stay pinned to the newest message as measured heights settle.
      el.scrollTop = el.scrollHeight;
      this.scrollTop.set(el.scrollTop);
    } else {
      // While scrolled up, a change to a row ABOVE the fold shoves the read
      // position (native anchoring is off) — a genuine reflow OR a first
      // estimate→real measurement of an overscan row entering from the top.
      // Compensate in the same coordinate space as scrollTop (past the padding +
      // load-older banner).
      const delta = scrollCompensation(
        changes,
        prefixSnapshot,
        st,
        this.rowsRegionTop(el),
      );
      if (delta !== 0) {
        el.scrollTop = Math.max(0, st + delta);
        this.scrollTop.set(el.scrollTop);
      }
    }
    this.heightVersion.update((v) => v + 1);
  }

  /** Restore the captured row using rendered geometry, with prefix sums as a windowed fallback. */
  private restorePrependAnchor(
    el: HTMLElement,
    anchorId: string,
    anchorOffset: number,
    prevHeight: number,
    prevTop: number,
    anchorGeneration: number,
  ): void {
    if (
      this.destroyRef.destroyed ||
      !this.prependAnchorActive ||
      anchorGeneration !== this.prependAnchorGeneration
    ) {
      return;
    }
    const idx = this.ids().indexOf(anchorId);
    const anchor = Array.from(
      el.querySelectorAll<HTMLElement>('.msg[data-mid]'),
    ).find((row) => row.getAttribute('data-mid') === anchorId);
    if (anchor) {
      const currentOffset =
        anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop = Math.max(0, el.scrollTop + currentOffset - anchorOffset);
    } else if (idx >= 0) {
      el.scrollTop = Math.max(
        0,
        this.rowsRegionTop(el) + offsetOf(this.prefix(), idx) - anchorOffset,
      );
    } else {
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
    }
    this.expectedProgrammaticScrollTop = el.scrollTop;
    this.scrollTop.set(el.scrollTop);
  }

  /**
   * Scroll a message into view (reply-preview click or search jump). When the target
   * row is windowed out of the DOM, first scroll near its computed offset so the
   * window renders it, then centre it precisely once it's on screen. A no-op when the
   * event isn't loaded.
   */
  jumpTo(messageId: string): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    const idx = this.ids().indexOf(messageId);
    if (idx < 0) {
      return; // not loaded → no-op
    }
    // Remembered so a width change can re-aim it: every branch below ends in a measurement
    // that is only correct for the layout at this instant. See `notePendingJump`.
    this.notePendingJump(messageId);
    this.atBottomSig.set(false);
    const existing = el.querySelector(`[data-mid="${messageId}"]`);
    if (existing) {
      existing.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
      this.flash(existing);
      return;
    }
    el.scrollTop = Math.max(
      0,
      this.rowsRegionTop(el) +
        offsetOf(this.prefix(), idx) -
        el.clientHeight / 2,
    );
    this.scrollTop.set(el.scrollTop);
    afterNextRender(
      () => {
        const target = el.querySelector(`[data-mid="${messageId}"]`);
        target?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
        this.flash(target);
      },
      { injector: this.injector },
    );
  }
}
