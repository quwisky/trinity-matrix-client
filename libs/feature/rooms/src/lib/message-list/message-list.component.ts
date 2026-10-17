import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TimelineSkeletonComponent } from './timeline-skeleton/timeline-skeleton.component';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { outputFromObservable, toObservable } from '@angular/core/rxjs-interop';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { MessageRowComponent } from '../message-row/message-row.component';
import { BodyOverflowObserver } from '../message-row/body-overflow';
import { MessageListBase, type JumpOptions } from './message-list-base';
import { scrollToJumpTarget } from './jump-scroll';
import { TimelineScrollActivity } from '../shared/timeline-scroll-activity';
import { TimelineMediaGate } from '../shared/timeline-media-gate';
import { FlingRows } from './fling-rows';
import { scrollBehavior } from '@trinity/util/ui';
import { TrnFileDropDirective } from '../shared/file-drop.directive';
import { DropOverlayComponent } from './drop-overlay/drop-overlay.component';
import { TimelineDividerComponent } from './timeline-divider/timeline-divider.component';
import { TypingIndicatorComponent } from './typing-indicator/typing-indicator.component';
import {
  buildPrefixSums,
  computeWindow,
  firstRowWithin,
  offsetOf,
  scrollCompensation,
  type HeightChange,
  type WindowResult,
} from './virtual-window';

/** Trigger older-history loading when the scroll top gets within this many px. */
const AUTO_LOAD_THRESHOLD_PX = 150;

/** Treat the viewport as "at the bottom" within this many px of the end. */
const NEAR_BOTTOM_PX = 120;

/** Safety cap on consecutive auto-backfill rounds for one fill sequence. */
const MAX_BACKFILL_ROUNDS = 20;

/** Seed height (px) for a row not yet measured; sizes the off-screen spacers until real heights arrive. */
const ESTIMATED_ROW_HEIGHT_PX = 64;

/**
 * With "Blank rows while scrolling fast" on, unmeasured rows are counted at the room's average
 * measured row once this many rows are measured…
 */
const MIN_MEASURED_FOR_ESTIMATE = 20;

/** …and only when that average has moved this far, so the estimate does not churn. */
const ESTIMATE_STEP_PX = 4;

/** No row is a placeholder: one shared map, so the rows' reads stay stable between flings. */
const NO_PLACEHOLDERS: ReadonlyMap<string, number> = new Map();

/** Extra pixels rendered above and below the viewport to hide window-boundary churn. */
const OVERSCAN_PX = 800;

/**
 * What an unmeasured row is counted at when the list says what it keeps on screen: the
 * shortest row it renders (a one-line compact system line at the small text scale). Rows that
 * arrive while a web tab is hidden are rendered but never measured, and counting them at the
 * 64 px estimate could name too few rows to fill the viewport when the window is shown again.
 */
const MIN_UNMEASURED_ROW_PX = 16;

/** At or below this many rows, render everything (windowing isn't worth it). */
const SMALL_LIST_ROWS = 80;

/** How long after the last scroll event a row under the pointer gets its hover work. */
const SCROLL_IDLE_MS = 150;

/**
 * The room timeline. With `windowed` on (the default) it renders only the rows in and near the
 * viewport plus top and bottom spacers, so the DOM stays bounded in long rooms; off (Settings →
 * Experimental) it renders every loaded row through the same anchoring, measurement and jump
 * code. Rooms of {@link SMALL_LIST_ROWS} rows or fewer render in full either way.
 *
 * Windowing trade-off: native find (Ctrl-F), linear screen-reader order and cross-row text
 * selection only cover the rendered rows.
 */
@Component({
  selector: 'trn-message-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    TimelineSkeletonComponent,
    TrnButton,
    MessageComposerComponent,
    MessageRowComponent,
    DropOverlayComponent,
    TimelineDividerComponent,
    TypingIndicatorComponent,
  ],
  // The whole conversation is the drop target; these templates are host fragments with no
  // element of their own to carry it.
  hostDirectives: [
    {
      directive: TrnFileDropDirective,
      // Neither is exposed on this element, stated so that is a decision rather than an
      // omission (see `scripts/host-directives.spec.mjs`). `filesDropped` is deliberately NOT
      // re-exported: `MessageListBase` subscribes to it directly, and a host binding would be
      // a second, silently divergent way in.
      inputs: [],
      outputs: [],
    },
  ],
  // Rows read the scroll activity to hold hover work back while scrolling, use the media gate to
  // load images, and share one ResizeObserver for every row body (Show more).
  providers: [TimelineScrollActivity, TimelineMediaGate, BodyOverflowObserver],
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss',
})
export class MessageListComponent extends MessageListBase {
  private lastId = '';
  /** The first row as last rendered, to tell rows trimmed away above the reader. */
  private lastFirstRowId: string | null = null;
  /** True when scrolled to (or near) the bottom: gates auto-scroll and pins the window to the newest row. */
  private readonly atBottomSig = signal(true);

  // Scroll-anchoring state while older history is prepended.
  private pendingPrepend = false;
  private prevScrollHeight = 0;
  private prevScrollTop = 0;

  // Backfill state, tracked by oldest id.
  private backfilling = false;
  // Null (not '') so an EMPTY projection still counts as "history not yet requested": a room
  // whose loaded window is all hidden system lines would otherwise compare '' to '' and never
  // backfill, leaving a blank timeline with no scrollbar to recover from.
  private lastBackfillOldestId: string | null = null;
  private backfillRounds = 0;

  // Windowing state: `scrollTop`/`viewportH` pick the rows in view; `measured` records real
  // heights (bumping `heightVersion` recomputes the prefix sums).
  private readonly scrollTop = signal(0);
  private readonly viewportH = signal(0);
  private readonly heightVersion = signal(0);
  private measured = new Map<string, number>();
  private ro?: ResizeObserver;
  /** Currently-observed `.msg` elements → their row id. */
  private readonly observed = new Map<Element, string>();
  // Reference row + viewport offset captured before a load-older, to restore scroll afterwards
  // (a raw scrollHeight delta drifts under windowing, where prepended rows are estimated spacer height).
  private prependAnchorId = '';
  private prependAnchorOffset = 0;
  /** Keep the captured row fixed while the first rendered rows settle their heights. */
  private prependAnchorActive = false;
  // Scroll-anchor session token, bumped by every gesture that owns the anchor; not a latest-wins guard.
  private prependAnchorGeneration = 0;
  /** Last scrollTop written by our own correction; distinguishes it from user movement. */
  private expectedProgrammaticScrollTop: number | null = null;
  /** Pending end of the current scroll; see {@link markScrolling}. */
  private scrollIdle: ReturnType<typeof setTimeout> | null = null;
  /**
   * The height an unmeasured row is counted at: {@link ESTIMATED_ROW_HEIGHT_PX}, or with "Blank
   * rows while scrolling fast" on, the room's average measured row ({@link adaptEstimate}).
   */
  private readonly rowEstimate = signal(ESTIMATED_ROW_HEIGHT_PX);
  /** A jump is scrolling until the list settles: its smooth scroll is the list's doing, not a fling. */
  private jumping = false;
  /** Ends {@link jumping} once the jump has been still for the idle window. */
  private jumpIdle: ReturnType<typeof setTimeout> | null = null;

  private readonly destroyRef = inject(DestroyRef);
  private readonly scrollActivity = inject(TimelineScrollActivity);
  private readonly mediaGate = inject(TimelineMediaGate);
  private readonly bodyOverflow = inject(BodyOverflowObserver);
  private readonly rowHosts = viewChildren(MessageRowComponent, {
    read: ElementRef,
  });

  /** Row ids in timeline order (the windowing key). */
  private readonly ids = computed(() => this.rows().map((r) => r.id));

  /** Prefix sums of row heights; recomputed when rows change or a height updates. */
  private readonly prefix = computed(() => {
    this.heightVersion();
    return buildPrefixSums(this.ids(), {
      measured: this.measured,
      estimate: this.rowEstimate(),
    });
  });

  /** Resolved render range + spacer heights (render-all fast path for short rooms). */
  private readonly windowResult = computed<WindowResult>(() =>
    computeWindow(
      {
        ids: this.ids(),
        heights: { measured: this.measured, estimate: this.rowEstimate() },
        scrollTop: this.scrollTop(),
        viewportHeight: this.viewportH(),
        overscanPx: OVERSCAN_PX,
        pinBottom: this.atBottomSig(),
        smallListThreshold: SMALL_LIST_ROWS,
        enabled: this.windowed(),
      },
      this.prefix(),
    ),
  );

  /**
   * The oldest event the list keeps on screen while following the newest message: the first
   * event of the oldest row within the viewport and its overscan of the end, counting an
   * unmeasured row at {@link MIN_UNMEASURED_ROW_PX}. Null while the reader is scrolled back,
   * history is paging in, or the viewport has no height (else a shrunk window keeps only the overscan).
   */
  private readonly liveViewFrom = computed(() => {
    const rows = this.rows();
    const viewport = this.viewportH();
    if (
      !this.atBottomSig() ||
      this.loadingOlder() ||
      rows.length === 0 ||
      viewport <= 0
    ) {
      return null;
    }
    this.heightVersion();
    const prefix = buildPrefixSums(this.ids(), {
      measured: this.measured,
      estimate: MIN_UNMEASURED_ROW_PX,
    });
    const row = rows[firstRowWithin(prefix, viewport + OVERSCAN_PX)];
    return row.systemRun?.events[0]?.id ?? row.id;
  });

  /** Render only the rows near the viewport. Off (Settings → Experimental) renders every loaded row. */
  readonly windowed = input(true);

  /**
   * Hold row images back until their row is near the viewport and the list is no longer
   * flinging ("Load images after fast scrolling", Settings → Experimental). Off by default.
   */
  readonly deferMediaWhileScrolling = input(false);

  /**
   * While the reader flings the list, rows entering the window render as blank placeholders
   * and the real rows mount once it slows down ("Blank rows while scrolling fast", Settings →
   * Experimental). Off by default.
   */
  readonly flingPlaceholders = input(false);

  /**
   * The room already shows its own empty-room prompt, so the list adds no empty line. Bind it
   * to the same condition as the `[trnMessageListIntro]` content: projection cannot report it.
   */
  readonly introShown = input(false);

  /**
   * {@link liveViewFrom} as it changes. The host passes it to the conversation, which while the
   * window is hidden trims the room no further back than this, so the list looks the same when shown again.
   */
  readonly liveView = outputFromObservable(toObservable(this.liveViewFrom));

  /** The rows actually rendered — the full list sliced to the window. */
  readonly windowedRows = computed(() => {
    const w = this.windowResult();
    if (w.endIndex < 0) {
      return [];
    }
    const all = this.rows();
    // Short room: return the same reference so `@for` sees no change and nothing is copied.
    if (w.startIndex === 0 && w.endIndex === all.length - 1) {
      return all;
    }
    return all.slice(w.startIndex, w.endIndex + 1);
  });

  /** Rows of the window rendered as placeholders during a fling; see {@link FlingRows}. */
  private readonly fling = new FlingRows(
    () => this.flingPlaceholders() && this.windowed(),
    computed(() => this.windowedRows().map((row) => row.id)),
  );

  /** Each placeholder's height: the row's measured height, else the estimate. */
  protected readonly placeholderHeights = computed(() => {
    const ids = this.fling.placeholderIds();
    if (ids.size === 0) return NO_PLACEHOLDERS;
    this.heightVersion();
    const estimate = this.rowEstimate();
    return new Map(
      [...ids].map((id) => [id, this.measured.get(id) ?? estimate] as const),
    );
  });

  /** Height of the top spacer standing in for off-screen rows above the window. */
  readonly topPad = computed(() => this.windowResult().topPadPx);
  /** Height of the bottom spacer standing in for off-screen rows below the window. */
  readonly bottomPad = computed(() => this.windowResult().bottomPadPx);

  /** Reactive mirror of `!atBottom` for the template's jump-to-latest pill. */
  protected readonly notAtBottom = computed(() => !this.atBottomSig());

  private lastChrome = '';

  constructor() {
    super();

    effect(() => {
      const msgs = this.messages();
      // The delayed loading strip changes row geometry before history arrives too.
      this.showLoadingOlder();
      // The skeleton and the load error sit in flow above the rows as well.
      const chrome = `${this.showSkeleton()}|${this.loadError()}`;
      const chromeToggled = chrome !== this.lastChrome;
      this.lastChrome = chrome;
      // Tracked so a load that ends with the same messages still retries the viewport fill.
      const settled = this.settled();
      const el = this.scrollEl()?.nativeElement;
      if (!el) {
        return;
      }
      const ids = untracked(() => this.ids());
      const firstBefore = this.lastFirstRowId;
      this.lastFirstRowId = ids[0] ?? null;

      if (this.pendingPrepend) {
        // The viewport moves before the browser delivers its scroll event. Capture that
        // movement before the strip or landed page changes row geometry (this effect runs
        // before the view renders either). Recapturing only while loading would let a page
        // landing in the same frame as a scroll drag the reader back to the request point.
        if (
          el.scrollTop !==
          (this.expectedProgrammaticScrollTop ?? this.prevScrollTop)
        ) {
          this.prevScrollHeight = el.scrollHeight;
          this.prevScrollTop = el.scrollTop;
          this.capturePrependAnchor(el);
          this.prependAnchorGeneration++;
          this.expectedProgrammaticScrollTop = null;
        }
        // Keep the viewport on what the user was reading, through the strip and the final prepend.
        this.pendingPrepend = this.loadingOlder();
        this.lastId = msgs[msgs.length - 1]?.id ?? this.lastId;
        const prevHeight = this.prevScrollHeight;
        const prevTop = this.prevScrollTop;
        const anchorId = this.prependAnchorId;
        const anchorOffset = this.prependAnchorOffset;
        const anchorGeneration = this.prependAnchorGeneration;
        this.prependAnchorActive = true;
        // Correct as soon as the strip/prepend renders, before another scroll event can
        // capture its displaced geometry as the reader's intended position.
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
      if (
        !newestChanged &&
        firstBefore !== null &&
        firstBefore !== ids[0] &&
        !ids.includes(firstBefore)
      ) {
        this.keepPlaceAfterTrim(el, ids);
      }
      // Untracked so this effect keeps firing only on messages().
      const stickToBottom =
        (newestChanged &&
          (untracked(() => this.atBottomSig()) || !!latest?.isOwn)) ||
        // Content appeared or vanished above the rows: a pinned reader stays pinned.
        (chromeToggled && untracked(() => this.atBottomSig())) ||
        this.backfilling;

      requestAnimationFrame(() => {
        if (stickToBottom) {
          this.writeScrollTop(el, el.scrollHeight);
        }

        const notFull = el.scrollHeight <= el.clientHeight + 1;
        const oldestId = this.oldestEventId();
        const prependedOlder = oldestId !== this.lastBackfillOldestId;
        if (
          notFull &&
          settled &&
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
        } else if (!chromeToggled) {
          // A skeleton/error-only re-run must not cancel an in-flight backfill.
          this.backfilling = false;
        }
      });
    });

    // Scroll to an externally-requested event (search / reply / pinned-panel jump). Untracked so
    // it fires only on a NEW request, not on timeline/height changes (which would yank the
    // viewport back); jumpToNonce re-fires a repeat to the same id. The target is expanded
    // first, so the row measures and scrolls at its full height.
    effect(() => {
      this.jumpToNonce();
      const id = this.jumpToId();
      if (id) {
        untracked(() => this.jumpToRequested(id));
      }
    });

    // An effect, not a computed: turning the flag off must also release the loads the gate holds,
    // and the gate is plain state that scroll events read without change detection.
    effect(() => this.mediaGate.setEnabled(this.deferMediaWhileScrolling()));

    // Turning "Blank rows while scrolling fast" off mounts every row and returns to the fixed estimate.
    effect(() => {
      if (this.flingPlaceholders()) return;
      untracked(() => {
        this.fling.end();
        const el = this.scrollEl()?.nativeElement;
        if (el) this.shiftEstimate(el, ESTIMATED_ROW_HEIGHT_PX);
      });
    });

    // Keep the observed rendered rows in sync with the window.
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
      this.mediaGate.connect(el);
      if (typeof ResizeObserver === 'undefined') {
        return; // jsdom / SSR — degrades to render-all via estimate heights.
      }
      this.ro = new ResizeObserver((entries) => this.onRowsResized(entries));
      this.watchScrollerHeight(
        (height, scrollTop) => {
          this.viewportH.set(height);
          this.scrollTop.set(scrollTop);
        },
        // The keyboard or composer pin is the list's own write, like `writeScrollTop`.
        (delta) => this.scrollActivity.shifted(delta),
      );
      this.watchScrollerWidth();
      this.reconcileObserved(this.rowHosts());
    });

    this.destroyRef.onDestroy(() => {
      this.ro?.disconnect();
      if (this.scrollIdle !== null) clearTimeout(this.scrollIdle);
      if (this.jumpIdle !== null) clearTimeout(this.jumpIdle);
    });
  }

  protected override resetOnRoomChange(): void {
    super.resetOnRoomChange();
    this.lastId = '';
    this.lastFirstRowId = null;
    this.lastBackfillOldestId = null;
    this.backfillRounds = 0;
    this.pendingPrepend = false;
    this.prependAnchorActive = false;
    this.prependAnchorGeneration++;
    this.expectedProgrammaticScrollTop = null;
    this.atBottomSig.set(true);
    // Forget the old room's measured heights and scroll position: the new room starts from the top.
    this.measured.clear();
    this.bodyOverflow.clear();
    this.scrollActivity.reset();
    this.fling.end();
    this.jumping = false;
    if (this.jumpIdle !== null) clearTimeout(this.jumpIdle);
    this.jumpIdle = null;
    this.rowEstimate.set(ESTIMATED_ROW_HEIGHT_PX);
    this.scrollTop.set(0);
    this.heightVersion.update((v) => v + 1);
  }

  /**
   * Older rows were trimmed above the reader while nothing arrived below (history released while
   * the window was hidden). Keeping the same distance from the end keeps the reader in place;
   * left alone, a reader just above the bottom would be moved by the browser clamping the
   * shorter list. Measured heights of the trimmed rows go too.
   */
  private keepPlaceAfterTrim(el: HTMLElement, ids: readonly string[]): void {
    const fromEnd = el.scrollHeight - el.scrollTop;
    const kept = new Set(ids);
    for (const id of [...this.measured.keys()]) {
      if (!kept.has(id)) this.measured.delete(id);
    }
    untracked(() =>
      afterNextRender(
        () => {
          if (this.destroyRef.destroyed) return;
          this.writeScrollTop(el, Math.max(0, el.scrollHeight - fromEnd));
        },
        { injector: this.injector },
      ),
    );
  }

  /** Auto-load older history once the user scrolls near the top. */
  onScroll(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    this.markScrolling();
    // How fast the reader moves the list. The list's own writes are taken out as made
    // (`writeScrollTop`), so this is the reader's movement alone.
    this.scrollActivity.moved(el.scrollTop, performance.now());
    if (this.jumping) {
      this.armJumpEnd(); // the jump is still animating
    } else {
      this.fling.moved(this.scrollActivity.speed);
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
      // A later user scroll starts a new read position; the prepend lock must not keep correcting it.
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
      // A reader can move while an earlier automatic backfill is in flight. Transfer its restore
      // point even inside the near-bottom threshold: only an exact bottom pin has no offset to preserve.
      this.prevScrollHeight = el.scrollHeight;
      this.prevScrollTop = el.scrollTop;
      this.capturePrependAnchor(el);
      this.pendingPrepend = true;
      this.backfilling = false;
      return;
    }
    if (
      !this.settled() ||
      this.pendingPrepend ||
      this.loadingOlder() ||
      !this.canLoadOlder()
    ) {
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
   * Note the scroll for the rows, and settle it once still for {@link SCROLL_IDLE_MS}, so the row
   * under the pointer then mounts its toolbar ({@link TimelineScrollActivity}). A plain timer, not
   * a signal: it changes no template state and must not schedule change detection per scroll event.
   */
  private markScrolling(): void {
    this.scrollActivity.start();
    if (this.scrollIdle !== null) {
      clearTimeout(this.scrollIdle);
    }
    this.scrollIdle = setTimeout(() => {
      this.scrollIdle = null;
      this.scrollActivity.settle();
      this.fling.end();
    }, SCROLL_IDLE_MS);
  }

  /**
   * Start a jump: end any fling and, with blank rows on, start none until the jump has been still
   * for the idle window (its own timer, so a jump that scrolls nothing ends too). With the flag
   * off this is the plain `fling.end()` no-op and the scroll activity is left alone.
   */
  private beginJump(): void {
    this.fling.end();
    if (!this.flingPlaceholders()) return;
    this.jumping = true;
    this.armJumpEnd();
  }

  private armJumpEnd(): void {
    if (this.jumpIdle !== null) clearTimeout(this.jumpIdle);
    this.jumpIdle = setTimeout(() => {
      this.jumpIdle = null;
      this.jumping = false;
    }, SCROLL_IDLE_MS);
  }

  /** Jump back to the newest message (the jump-to-latest pill). */
  scrollToLatest(): void {
    this.cancelPendingJump();
    this.beginJump();
    const el = this.scrollEl()?.nativeElement;
    if (!el) {
      return;
    }
    // This explicit destination supersedes an in-flight history restore and any queued measurement correction.
    this.pendingPrepend = false;
    this.prependAnchorActive = false;
    this.prependAnchorGeneration++;
    this.expectedProgrammaticScrollTop = null;
    // Pin the window to the bottom, then scroll once it has re-rendered the newest rows (spacer heights shift).
    this.atBottomSig.set(true);
    requestAnimationFrame(() => this.writeScrollTop(el, el.scrollHeight));
  }

  /**
   * Record the first rendered `.msg` reaching into the viewport and its offset from the top, so
   * scroll can be restored to it after older history prepends (see the anchoring effect).
   */
  private capturePrependAnchor(el: HTMLElement): void {
    this.prependAnchorId = '';
    const top = el.getBoundingClientRect().top;
    // A fling's placeholders stand where their rows are: they anchor as well as the rows.
    for (const m of Array.from(
      el.querySelectorAll('.msg, [data-placeholder-mid]'),
    )) {
      const rect = m.getBoundingClientRect();
      if (rect.bottom > top) {
        this.prependAnchorId =
          m.getAttribute('data-mid') ??
          m.getAttribute('data-placeholder-mid') ??
          '';
        this.prependAnchorOffset = rect.top - top;
        return;
      }
    }
  }

  /**
   * Content offset of the row region (first `.vpad` spacer) from the scroll origin: the `.scroll`
   * padding plus any `.load-older` banner. `offsetOf()` measures from that region while
   * `scrollTop` is physical, so this bridges the two coordinate systems.
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
   * Observe the `.msg` box of every rendered row, dropping rows that left the window. Observing a
   * fresh element fires an immediate callback with its size, which is how new rows get measured.
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

  /** Record measured row heights and keep the read position stable. */
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
    // How much the rendered rows grew in this batch. A first measurement changes no layout (the
    // row already drew at that height); only the estimate behind the prefix sums changes.
    let grown = 0;
    const resized: Element[] = [];
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
      if (prior !== undefined) grown += newH - prior;
      resized.push(entry.target);
      changed = true;
      const idx = idList.indexOf(mid);
      if (idx >= 0) {
        // `prior` is the pre-update height (the estimate for a first measurement).
        changes.push({
          index: idx,
          prior: prior ?? this.rowEstimate(),
          next: newH,
        });
      }
    }
    if (!changed) {
      return;
    }
    // A jump made while rows were unmeasured (a linked message, as the list mounts) aimed at
    // estimated heights, and the first real measurements cut that smooth scroll short. Re-aim
    // once the corrections below have landed; bounded by the same window as a width change.
    afterNextRender(() => this.reapplyRecentJump(), {
      injector: this.injector,
    });
    // A reader exactly at the bottom before this batch (newest message expanding behind Show more,
    // a late image) stays there. That wins over a history anchor, which would outlive its restore
    // until the reader scrolls, and ends it. Only an exact pin: near the bottom keeps the anchored row.
    if (
      atBottom &&
      this.prependAnchorActive &&
      !this.pendingPrepend &&
      el.scrollHeight - grown - st - el.clientHeight < 1
    ) {
      this.prependAnchorActive = false;
      this.prependAnchorGeneration++;
      this.expectedProgrammaticScrollTop = null;
    }
    if (this.prependAnchorActive) {
      // ResizeObserver runs after the prepend restore and can replace estimated spacer heights
      // with real ones. Correct from the rendered anchor after each batch so the row keeps its position.
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
        this.revealFocusIn(resized);
      });
      this.heightVersion.update((v) => v + 1);
      return;
    }
    if (atBottom) {
      // Stay pinned to the newest message as measured heights settle.
      this.writeScrollTop(el, el.scrollHeight);
    } else {
      // While scrolled up, a change to a row ABOVE the fold shoves the read position (native
      // anchoring is off): a real reflow or the first estimate-to-real measurement of an overscan
      // row entering from the top. Compensate in scrollTop's coordinate space (past padding + banner).
      const delta = scrollCompensation(
        changes,
        prefixSnapshot,
        st,
        this.rowsRegionTop(el),
      );
      if (delta !== 0) {
        this.writeScrollTop(el, Math.max(0, st + delta));
      }
    }
    this.revealFocusIn(resized);
    this.heightVersion.update((v) => v + 1);
    if (!atBottom && this.flingPlaceholders()) this.adaptEstimate(el);
  }

  /**
   * With "Blank rows while scrolling fast" on, count unmeasured rows at the room's average measured
   * row. A fling never measures the rows it passes (placeholders), so at a fixed 64 px a long room
   * would come out far shorter than it is and every fling would cover more of it.
   */
  private adaptEstimate(el: HTMLElement): void {
    if (this.measured.size < MIN_MEASURED_FOR_ESTIMATE) return;
    let sum = 0;
    for (const height of this.measured.values()) sum += height;
    const average = Math.round(sum / this.measured.size);
    if (Math.abs(average - this.rowEstimate()) >= ESTIMATE_STEP_PX) {
      this.shiftEstimate(el, average);
    }
  }

  /**
   * Count unmeasured rows at `next` px, keeping the reader in place: each unmeasured row wholly above
   * the viewport changes height by the difference, so the position moves by that times their number.
   * The move is made after the render that resizes the spacers; before it the scroller is still its
   * old height and the browser would clamp a position near the bottom.
   */
  private shiftEstimate(el: HTMLElement, next: number): void {
    const prev = this.rowEstimate();
    if (next === prev) return;
    const st = el.scrollTop;
    const regionTop = this.rowsRegionTop(el);
    const prefix = this.prefix();
    const ids = this.ids();
    let above = 0;
    for (let i = 0; i < ids.length && regionTop + prefix[i + 1] <= st; i++) {
      if (!this.measured.has(ids[i])) above++;
    }
    this.rowEstimate.set(next);
    if (above === 0 || untracked(() => this.atBottomSig())) return;
    const delta = (next - prev) * above;
    untracked(() =>
      afterNextRender(
        () => {
          // The reader may have reached the newest message since: they stay there.
          if (
            this.destroyRef.destroyed ||
            untracked(() => this.atBottomSig())
          ) {
            return;
          }
          this.writeScrollTop(el, Math.max(0, el.scrollTop + delta));
        },
        { injector: this.injector },
      ),
    );
  }

  /**
   * Set the scroll position from the list's own code (pin, correction, restore, jump), telling the
   * scroll activity at once so the move never reads as the reader's. The keyboard/composer pin
   * (`observeScrollerHeight`) reports its write the same way.
   *
   * Known exceptions, which the speed estimate sees as movement: smooth `scrollIntoView` calls
   * (`scrollToJumpTarget`, `revealFocusIn`, a row's Show less), whose animation has no single
   * write to take out, and the mobile action sheet's viewport writes (`MessageSheetViewportSession`),
   * which run while a modal sheet covers the list.
   */
  private writeScrollTop(el: HTMLElement, top: number): void {
    const before = el.scrollTop;
    el.scrollTop = top;
    this.scrollActivity.shifted(el.scrollTop - before);
    this.scrollTop.set(el.scrollTop);
  }

  /**
   * Keep keyboard focus inside a message body in view when its row just changed height, after the
   * corrections above have moved the list. Tabbing to a link past a Show more cut expands the body
   * (`MessageRowComponent.expandBodyForFocus`); the browser scrolled to the link while still
   * clipped, and the pin, compensation or restore for the taller row decides where it ends up.
   * Only focus in the body (`.msg__clamp`): the Show more button sits after the body, and following
   * it would skip the text it revealed (and fight the row-top reveal on Show less). Keyboard focus
   * only (`:focus-visible`): a pointer user is already looking at what they clicked.
   */
  private revealFocusIn(rows: readonly Element[]): void {
    const active = rows[0]?.ownerDocument.activeElement;
    if (
      active &&
      active.matches(':focus-visible') &&
      active.closest('.msg__clamp') &&
      rows.some((row) => row !== active && row.contains(active))
    ) {
      active.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
    }
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
    // A reader at the bottom stays there: a restore queued before a live message pinned the list
    // (or before the reader reached the bottom) would nudge the newest message up. History landing
    // above a reader moves them off the bottom, so a real restore still runs.
    if (
      untracked(() => this.atBottomSig()) &&
      el.scrollHeight - el.scrollTop - el.clientHeight < 1
    ) {
      return;
    }
    const idx = this.ids().indexOf(anchorId);
    const anchor = Array.from(
      el.querySelectorAll<HTMLElement>(
        '.msg[data-mid], [data-placeholder-mid]',
      ),
    ).find(
      (row) =>
        (row.getAttribute('data-mid') ??
          row.getAttribute('data-placeholder-mid')) === anchorId,
    );
    let top: number;
    if (anchor) {
      const currentOffset =
        anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
      top = Math.max(0, el.scrollTop + currentOffset - anchorOffset);
    } else if (idx >= 0) {
      top = Math.max(
        0,
        this.rowsRegionTop(el) + offsetOf(this.prefix(), idx) - anchorOffset,
      );
    } else {
      top = el.scrollHeight - prevHeight + prevTop;
    }
    this.writeScrollTop(el, top);
    this.expectedProgrammaticScrollTop = el.scrollTop;
    // A recent jump wins over the anchor: the page the jump's own scroll asked for keeps the anchored
    // row in place, which can leave a tall target half-hidden at the top. Re-aim; a no-op once old or the reader moved.
    this.reapplyRecentJump();
  }

  /**
   * Scroll a message into view (reply-preview click or search jump). A target windowed out of the
   * DOM is first scrolled to near its computed offset so the window renders it, then aimed at
   * precisely: centred, or by its top when taller than the scroller. A no-op when not loaded.
   */
  jumpTo(messageId: string, options?: JumpOptions): void {
    messageId = this.revealEvent(messageId);
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
    // A jump ends a fling and starts none while it scrolls. A target still shown as a placeholder
    // has no `data-mid` yet, so it takes the path below and is revealed after the render that mounts it.
    this.beginJump();
    // The jump is the reader's new position. A correction queued for the history restore before it
    // (a date jump pages history in right before jumping) would scroll back and cancel the smooth scroll.
    this.prependAnchorActive = false;
    this.prependAnchorGeneration++;
    this.expectedProgrammaticScrollTop = null;
    this.atBottomSig.set(false);
    // Only a row in the CURRENT window counts as rendered. A scroll written just before the jump
    // (a history restore as a date jump's last page lands) has moved the window while the DOM holds
    // the old rows; smooth-scrolling to one chases an element the next render removes, and the first
    // measurement write then cancels the scroll mid-list.
    const { startIndex, endIndex } = this.windowResult();
    const existing =
      idx >= startIndex && idx <= endIndex
        ? el.querySelector(`[data-mid="${messageId}"]`)
        : null;
    if (existing) {
      if (options?.afterRender) {
        // The row was just expanded: aim at its full height, in one scroll.
        afterNextRender(() => this.revealRow(el, messageId), {
          injector: this.injector,
        });
      } else {
        scrollToJumpTarget(existing, el);
        this.flash(existing);
      }
      return;
    }
    this.writeScrollTop(
      el,
      Math.max(
        0,
        this.rowsRegionTop(el) +
          offsetOf(this.prefix(), idx) -
          el.clientHeight / 2,
      ),
    );
    afterNextRender(() => this.revealRow(el, messageId), {
      injector: this.injector,
    });
  }

  /** Bring a rendered row into view (centred, or top-aligned when taller than the scroller) and flash it. */
  private revealRow(el: HTMLElement, messageId: string): void {
    this.beginJump();
    const target = el.querySelector(`[data-mid="${messageId}"]`);
    if (target) scrollToJumpTarget(target, el);
    this.flash(target);
  }
}
