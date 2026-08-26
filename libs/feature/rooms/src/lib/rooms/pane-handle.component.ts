import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

/**
 * The draggable divider between two panes.
 *
 * ## Why the drag writes CSS and not a signal
 *
 * The timeline beside these handles is a custom virtual scroller: it keeps per-row measured
 * heights and prefix sums, and runs two `ResizeObserver`s over them. Every width change
 * re-wraps every row to a new height, so a signal write per `pointermove` would put an
 * Angular render, a re-measure and a prefix-sum rebuild between one frame and the next — on
 * the hottest surface in the app, sixty times a second, while the user is holding the mouse
 * down. #179 records that as the risk for this work.
 *
 * So the gesture writes ONE CSS custom property on the shell element and nothing else. The
 * browser reflows, as it would for any resize; Angular is not involved and no component
 * re-renders. On release the final value is committed once — to the store, and from there to
 * the persisted config. The list still re-measures, but once, at the end, exactly as it does
 * for any other width change. (`MessageListBase` re-applies a recent jump across those
 * changes, which is what keeps the reader's row under their eye throughout a drag.)
 *
 * ## Keyboard
 *
 * A `separator` with `aria-valuenow` is operable with the arrow keys, which is not a
 * courtesy: a pointer drag is the one interaction a keyboard user cannot emulate, and a pane
 * they cannot resize is a pane stuck wherever the last mouse left it. Home/End go to the
 * bounds so a badly-dragged layout is one key from recoverable. Keyboard steps commit
 * immediately — there is no gesture to end.
 */

/** Pixels per arrow press, and per shifted arrow press. */
const STEP_PX = 16;
const COARSE_STEP_PX = 64;

@Component({
  selector: 'trn-pane-handle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    '[attr.aria-label]': 'label()',
    '[attr.aria-valuenow]': 'announcedValue()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'announcedMax()',
    '[class.pane-handle--dragging]': 'dragging',
    class: 'pane-handle',
    '(pointerdown)': 'onPointerDown($event)',
    '(keydown)': 'onKeyDown($event)',
  },
})
export class PaneHandleComponent {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Preferred width of the pane this handle sizes, in px. */
  readonly value = input.required<number>();
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  /** What this separates, for assistive tech — "Room list width", say. */
  readonly label = input.required<string>();

  /**
   * The CSS custom property the drag writes, e.g. `--shell-sidebar-w`.
   *
   * Named by the caller because the handle does not know which pane it is sizing — and it is
   * the caller's stylesheet that reads it.
   */
  readonly cssVariable = input.required<string>();

  /**
   * The pane whose rendered width is this separator's live position.
   *
   * Optional because the right-panel handle has no live outer-shell clamp today. The room
   * list does: its preferred width can be 560px while flexbox temporarily renders 448px, so
   * pointer and keyboard interaction must start from the latter without overwriting the
   * former merely because the window narrowed.
   */
  readonly paneSelector = input<string>();

  /**
   * Which direction growing goes. The sidebar handle grows the pane to its LEFT as the
   * pointer moves right; the right-panel handle grows the pane to its RIGHT, so its delta is
   * inverted. Without this the right-hand pane shrinks when you drag it wider.
   */
  readonly invert = input(false);

  /** The committed width, once the gesture ends or a key is pressed. */
  readonly committed = output<number>();

  protected dragging = false;
  private readonly renderedValue = signal<number | null>(null);
  protected readonly announcedValue = computed(
    () => this.renderedValue() ?? this.value(),
  );
  protected readonly announcedMax = computed(() => {
    const rendered = this.renderedValue();
    return rendered !== null && this.value() > rendered ? rendered : this.max();
  });

  private startX = 0;
  private startValue = 0;
  private latest = 0;
  private paneObserver: ResizeObserver | null = null;
  /**
   * The element carrying the custom property, resolved once when the gesture starts.
   *
   * Not looked up per event, and deliberately not looked up during teardown: `closest` walks
   * the DOM, and by the time a destroy hook runs the handle may already be detached — which
   * would answer `null` at exactly the moment the override has to come off.
   */
  private shellEl: HTMLElement | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.syncRenderedValue();
      const pane = this.renderedPane();
      if (pane && typeof ResizeObserver !== 'undefined') {
        this.paneObserver = new ResizeObserver(() => {
          // A pointer drag deliberately stays outside Angular's render loop. ARIA matched
          // the starting edge before it began and is reconciled once the gesture lands.
          if (!this.dragging) {
            this.syncRenderedValue();
          }
        });
        this.paneObserver.observe(pane);
      }
    });

    // A gesture can outlive the handle: the right-hand one lives inside the slot's `@if`, and
    // Escape closes the slot from a document listener — so it is destroyed mid-drag with the
    // pointer still down and `onPointerUp` never reached. The inline override would then be
    // left on the shell for good, which is exactly the state that rule warns about: the
    // binding stops reaching the layout and a change from the settings editor does nothing.
    destroyRef.onDestroy(() => {
      this.paneObserver?.disconnect();
      if (this.dragging) {
        // Nothing is committed, so put the property back to the width the binding still
        // holds. REMOVING it would be worse than leaving the drag's value: the stylesheet
        // falls through to its own default, which is not the user's persisted width and not
        // what Angular thinks it has written either.
        this.shellEl?.style.setProperty(
          this.cssVariable(),
          `${this.value()}px`,
        );
        this.endGesture();
      }
    });
  }

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return; // a right-click on a divider is not a drag
    }
    event.preventDefault(); // stop the browser starting a text selection instead
    // preventDefault also suppresses the focus the press would have given, and this is the
    // one control whose whole point is that the keyboard can finish what the pointer started.
    this.host.nativeElement.focus();
    this.dragging = true;
    this.startX = event.clientX;
    this.startValue = this.currentRenderedValue();
    this.renderedValue.set(this.startValue);
    this.latest = this.startValue;
    this.shellEl = this.host.nativeElement.closest('[data-shell-root]');
    // Pointer capture, so a fast drag that leaves the 4px handle keeps sending moves here
    // rather than to whatever it flew over. It also gives us `pointerup` unconditionally,
    // including when the pointer is released outside the window.
    this.host.nativeElement.setPointerCapture(event.pointerId);
    this.host.nativeElement.addEventListener('pointermove', this.onPointerMove);
    this.host.nativeElement.addEventListener('pointerup', this.onPointerUp);
    this.host.nativeElement.addEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * Bound as an arrow property, not a method: these are added and removed by reference on the
   * host element, and a bare method would be a different function object each time and so
   * could never be removed.
   */
  private readonly onPointerMove = (event: PointerEvent): void => {
    const delta = event.clientX - this.startX;
    this.latest = this.clamp(
      this.startValue + (this.invert() ? -delta : delta),
    );
    // The whole gesture, in one line: a style write on an ancestor. No signal, no change
    // detection, no component re-render.
    const width = this.preservesPreferredGrowth(this.latest, this.startValue)
      ? this.value()
      : this.latest;
    this.shellEl?.style.setProperty(this.cssVariable(), `${width}px`);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.host.nativeElement.releasePointerCapture?.(event.pointerId);
    const width = this.latest;
    const shell = this.shellEl;
    const preservePreference = this.preservesPreferredGrowth(
      width,
      this.startValue,
    );
    this.endGesture();
    if (preservePreference) {
      shell?.style.setProperty(this.cssVariable(), `${this.value()}px`);
      this.syncRenderedValue();
      return;
    }
    // The property is left where the drag put it, deliberately. It is not a competing
    // declaration to be cleaned up: the host BINDS this same inline property, so the commit
    // below arrives as an ordinary binding write to the very value already there. Removing
    // it first would drop the pane to the stylesheet's `var()` fallback for however long
    // Angular takes to render — a visible snap back to the default on every release, and a
    // race the pane-resize e2e catches from time to time.
    this.committed.emit(width);
    this.syncRenderedValue();
  };

  /**
   * Unwind the drag: listeners off, gesture state cleared.
   *
   * Separate from {@link onPointerUp} because teardown also has to run when the handle is
   * destroyed mid-gesture, where there is no event and nothing to commit.
   */
  private endGesture(): void {
    this.dragging = false;
    this.host.nativeElement.removeEventListener(
      'pointermove',
      this.onPointerMove,
    );
    this.host.nativeElement.removeEventListener('pointerup', this.onPointerUp);
    this.host.nativeElement.removeEventListener(
      'pointercancel',
      this.onPointerUp,
    );
    this.shellEl = null;
  }

  onKeyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? COARSE_STEP_PX : STEP_PX;
    const current = this.currentRenderedValue();
    const next = this.fromKey(event.key, step, current);
    if (next === null) {
      return;
    }
    event.preventDefault(); // arrows would otherwise scroll the pane behind the handle
    this.renderedValue.set(current);
    if (this.preservesPreferredGrowth(next, current)) {
      return;
    }
    this.committed.emit(this.clamp(next));
  }

  private fromKey(key: string, step: number, current: number): number | null {
    const grow = this.invert() ? -step : step;
    switch (key) {
      case 'ArrowLeft':
        return current - grow;
      case 'ArrowRight':
        return current + grow;
      case 'Home':
        return this.min();
      case 'End':
        return this.max();
      default:
        return null;
    }
  }

  private clamp(px: number): number {
    return Math.min(this.max(), Math.max(this.min(), Math.round(px)));
  }

  private renderedPane(): HTMLElement | null {
    const selector = this.paneSelector();
    return selector
      ? (this.host.nativeElement.parentElement?.querySelector<HTMLElement>(
          selector,
        ) ?? null)
      : null;
  }

  private currentRenderedValue(): number {
    const width = this.renderedPane()?.getBoundingClientRect().width ?? 0;
    return width > 0 ? Math.round(width) : this.value();
  }

  private syncRenderedValue(): void {
    if (this.paneSelector()) {
      this.renderedValue.set(this.currentRenderedValue());
    }
  }

  private preservesPreferredGrowth(next: number, rendered: number): boolean {
    return this.value() > rendered && next >= rendered;
  }
}
