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
 * The timeline beside these handles is a custom virtual scroller with per-row measured heights
 * and two `ResizeObserver`s, and every width change re-wraps every row. A signal write per
 * `pointermove` would put an Angular render, a re-measure and a prefix-sum rebuild between
 * frames on the hottest surface in the app.
 *
 * So the gesture writes ONE CSS custom property on the shell element and nothing else. On
 * release the final value is committed once, to the store and from there to the persisted
 * config. (`MessageListBase` re-applies a recent jump across those width changes, which keeps
 * the reader's row under their eye during a drag.)
 *
 * ## Keyboard
 *
 * A `separator` with `aria-valuenow` is operable with the arrow keys: a pointer drag is the
 * one interaction a keyboard user cannot emulate. Home/End go to the bounds. Keyboard steps
 * commit immediately; there is no gesture to end.
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
   * The CSS custom property the drag writes, e.g. `--shell-sidebar-w`. Named by the caller,
   * whose stylesheet reads it.
   */
  readonly cssVariable = input.required<string>();

  /**
   * The pane whose rendered width is this separator's live position.
   *
   * Optional because the right-panel handle has no live outer-shell clamp. The room list does:
   * its preferred width can be 560px while flexbox renders 448px, so interaction starts from
   * the latter without overwriting the former merely because the window narrowed.
   */
  readonly paneSelector = input<string>();

  /**
   * Which direction growing goes. The sidebar handle grows the pane to its LEFT as the pointer
   * moves right; the right-panel handle grows the pane to its RIGHT, so its delta is inverted.
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
   * The element carrying the custom property, resolved once when the gesture starts. Not
   * looked up during teardown: the handle may already be detached, and `closest` would answer
   * `null` just when the override has to come off.
   */
  private shellEl: HTMLElement | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.syncRenderedValue();
      const pane = this.renderedPane();
      if (pane && typeof ResizeObserver !== 'undefined') {
        this.paneObserver = new ResizeObserver(() => {
          // A pointer drag stays outside Angular's render loop; ARIA is reconciled once the
          // gesture lands.
          if (!this.dragging) {
            this.syncRenderedValue();
          }
        });
        this.paneObserver.observe(pane);
      }
    });

    // A gesture can outlive the handle: the right-hand one sits in the slot's `@if` and Escape
    // closes the slot from a document listener, so it can be destroyed mid-drag with
    // `onPointerUp` never reached. The inline override would then stay on the shell for good,
    // and the binding would stop reaching the layout.
    destroyRef.onDestroy(() => {
      this.paneObserver?.disconnect();
      if (this.dragging) {
        // Nothing is committed, so restore the width the binding still holds. Removing the
        // property would fall through to the stylesheet default, which is neither the persisted
        // width nor what Angular thinks it has written.
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
    // preventDefault also suppresses the focus the press would have given, and this control
    // needs focus so the keyboard can finish what the pointer started.
    this.host.nativeElement.focus();
    this.dragging = true;
    this.startX = event.clientX;
    this.startValue = this.currentRenderedValue();
    this.renderedValue.set(this.startValue);
    this.latest = this.startValue;
    this.shellEl = this.host.nativeElement.closest('[data-shell-root]');
    // Pointer capture: a fast drag that leaves the 4px handle keeps sending moves here, and
    // `pointerup` arrives even when the pointer is released outside the window.
    this.host.nativeElement.setPointerCapture(event.pointerId);
    this.host.nativeElement.addEventListener('pointermove', this.onPointerMove);
    this.host.nativeElement.addEventListener('pointerup', this.onPointerUp);
    this.host.nativeElement.addEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * An arrow property, not a method: the listeners are added and removed by reference, so
   * they need one stable function object.
   */
  private readonly onPointerMove = (event: PointerEvent): void => {
    const delta = event.clientX - this.startX;
    this.latest = this.clamp(
      this.startValue + (this.invert() ? -delta : delta),
    );
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
    // Leave the property where the drag put it: the host BINDS this same inline property, so
    // the commit arrives as a binding write to the value already there. Removing it first would
    // snap the pane to the stylesheet's `var()` fallback until Angular renders (a race the
    // pane-resize e2e catches).
    this.committed.emit(width);
    this.syncRenderedValue();
  };

  /**
   * Unwind the drag: listeners off, gesture state cleared. Separate from {@link onPointerUp}
   * because teardown also runs when the handle is destroyed mid-gesture, with no event and
   * nothing to commit.
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
