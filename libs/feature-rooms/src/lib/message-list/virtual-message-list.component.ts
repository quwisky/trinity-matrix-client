import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  NgZone,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { MessageRowComponent } from '../message-row/message-row.component';
import { MessageListBase } from './message-list-base';
import {
  buildPrefixSums,
  computeWindow,
  offsetOf,
  type WindowResult,
} from './virtual-window';

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
 * Selected in place of {@link MessageListComponent} when the experimental
 * virtualized-timeline flag is on; shared logic lives in {@link MessageListBase}.
 *
 * Trade-off vs the plain list: native in-page find (Ctrl-F), linear screen-reader
 * reading order, and cross-row text selection only cover the rendered rows.
 */
@Component({
  selector: 'trn-virtual-message-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MessageComposerComponent, MessageRowComponent],
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

  // Backfill state — see MessageListComponent for the rationale (tracked by oldest id).
  private backfilling = false;
  private lastBackfillOldestId = '';
  private backfillRounds = 0;

  // Windowing state. `scrollTop`/`viewportH` drive which rows are in view; `measured`
  // records real row heights (bumping `heightVersion` to recompute the prefix sums).
  private readonly scrollTop = signal(0);
  private readonly viewportH = signal(0);
  private readonly heightVersion = signal(0);
  private measured = new Map<string, number>();
  private ro?: ResizeObserver;
  private containerRo?: ResizeObserver;
  /** Currently-observed `.msg` elements → their row id. */
  private readonly observed = new Map<Element, string>();
  // Reference row + its viewport offset, captured before a load-older so scroll can
  // be restored to it afterward (a raw scrollHeight delta drifts under windowing,
  // where the prepended rows are estimated spacer height, not real).
  private prependAnchorId = '';
  private prependAnchorOffset = 0;

  private readonly ngZone = inject(NgZone);
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

  constructor() {
    super();

    effect(() => {
      const msgs = this.messages();
      const el = this.scrollEl()?.nativeElement;
      if (!el) {
        return;
      }

      if (this.pendingPrepend) {
        // Keep the viewport anchored on what the user was reading.
        this.pendingPrepend = false;
        this.lastId = msgs[msgs.length - 1]?.id ?? this.lastId;
        const prevHeight = this.prevScrollHeight;
        const prevTop = this.prevScrollTop;
        const anchorId = this.prependAnchorId;
        const anchorOffset = this.prependAnchorOffset;
        requestAnimationFrame(() => {
          const idx = this.ids().indexOf(anchorId);
          if (idx >= 0) {
            // A raw scrollHeight delta is contaminated by the estimated spacer for
            // the (unrendered) prepended rows, so restore the reference row to its
            // captured viewport offset via its computed offset.
            el.scrollTop = Math.max(
              0,
              offsetOf(this.prefix(), idx) - anchorOffset,
            );
          } else {
            el.scrollTop = el.scrollHeight - prevHeight + prevTop;
          }
          this.scrollTop.set(el.scrollTop);
        });
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
          latest.kind !== 'redacted'
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
        const oldestId = msgs[0]?.id ?? '';
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

    // Scroll to an externally-requested event (search jump). jumpTo reads ids()/
    // prefix(); run it untracked so this fires only on a NEW jumpToId — not on every
    // timeline/height change, which would keep yanking the viewport back.
    effect(() => {
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
      this.ngZone.runOutsideAngular(() => {
        this.ro = new ResizeObserver((entries) => this.onRowsResized(entries));
        this.containerRo = new ResizeObserver(() =>
          this.ngZone.run(() => {
            const e = this.scrollEl()?.nativeElement;
            if (e) {
              this.viewportH.set(e.clientHeight);
            }
          }),
        );
        this.containerRo.observe(el);
      });
      this.reconcileObserved(this.rowHosts());
    });

    this.destroyRef.onDestroy(() => {
      this.ro?.disconnect();
      this.containerRo?.disconnect();
    });
  }

  protected override resetOnRoomChange(): void {
    super.resetOnRoomChange();
    this.lastId = '';
    this.lastBackfillOldestId = '';
    this.backfillRounds = 0;
    this.pendingPrepend = false;
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
    this.scrollTop.set(el.scrollTop);
    this.atBottomSig.set(
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX,
    );
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
   * Record measured row heights and keep the read position stable. Runs outside the
   * Angular zone (RO isn't zone-patched), so signal + scroll writes are wrapped in
   * `ngZone.run`.
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
    let aboveDelta = 0;
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
      // While scrolled up, any change to a row ABOVE the fold shoves the read
      // position (native anchoring is off): both a genuine reflow AND a first
      // estimate→real measurement of a row entering from the top overscan (spacer →
      // real element). Compensate it against its pre-update height (the estimate for
      // a first measurement). When pinned to the bottom we re-stick below instead, so
      // skip the delta there — shifting would un-pin.
      if (!atBottom) {
        const idx = idList.indexOf(mid);
        const effPrior = prior ?? ESTIMATED_ROW_HEIGHT_PX;
        if (idx >= 0 && offsetOf(prefixSnapshot, idx) + effPrior <= st) {
          aboveDelta += newH - effPrior;
        }
      }
    }
    if (!changed) {
      return;
    }
    this.ngZone.run(() => {
      if (atBottom) {
        // Stay pinned to the newest message as measured heights settle.
        el.scrollTop = el.scrollHeight;
        this.scrollTop.set(el.scrollTop);
      } else if (aboveDelta !== 0) {
        el.scrollTop = Math.max(0, st + aboveDelta);
        this.scrollTop.set(el.scrollTop);
      }
      this.heightVersion.update((v) => v + 1);
    });
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
    this.atBottomSig.set(false);
    const existing = el.querySelector(`[data-mid="${messageId}"]`);
    if (existing) {
      existing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    el.scrollTop = Math.max(
      0,
      offsetOf(this.prefix(), idx) - el.clientHeight / 2,
    );
    this.scrollTop.set(el.scrollTop);
    afterNextRender(
      () =>
        el
          .querySelector(`[data-mid="${messageId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      { injector: this.injector },
    );
  }
}
