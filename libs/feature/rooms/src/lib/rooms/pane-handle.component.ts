import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
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
    '[attr.aria-valuenow]': 'value()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[class.pane-handle--dragging]': 'dragging',
    class: 'pane-handle',
    '(pointerdown)': 'onPointerDown($event)',
    '(keydown)': 'onKeyDown($event)',
  },
})
export class PaneHandleComponent {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Current width of the pane this handle sizes, in px. */
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
   * Which direction growing goes. The sidebar handle grows the pane to its LEFT as the
   * pointer moves right; the right-panel handle grows the pane to its RIGHT, so its delta is
   * inverted. Without this the right-hand pane shrinks when you drag it wider.
   */
  readonly invert = input(false);

  /** The committed width, once the gesture ends or a key is pressed. */
  readonly committed = output<number>();

  protected dragging = false;

  private startX = 0;
  private startValue = 0;
  private latest = 0;

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return; // a right-click on a divider is not a drag
    }
    event.preventDefault(); // stop the browser starting a text selection instead
    this.dragging = true;
    this.startX = event.clientX;
    this.startValue = this.value();
    this.latest = this.startValue;
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
    this.shell()?.style.setProperty(this.cssVariable(), `${this.latest}px`);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.dragging = false;
    this.host.nativeElement.releasePointerCapture?.(event.pointerId);
    this.host.nativeElement.removeEventListener(
      'pointermove',
      this.onPointerMove,
    );
    this.host.nativeElement.removeEventListener('pointerup', this.onPointerUp);
    this.host.nativeElement.removeEventListener(
      'pointercancel',
      this.onPointerUp,
    );
    // Clear the inline override so the committed value — which arrives as a normal binding —
    // is what the layout reads. Leaving it would make the inline style win forever, and a
    // later change from the settings editor would appear to do nothing.
    this.shell()?.style.removeProperty(this.cssVariable());
    this.committed.emit(this.latest);
  };

  onKeyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? COARSE_STEP_PX : STEP_PX;
    const next = this.fromKey(event.key, step);
    if (next === null) {
      return;
    }
    event.preventDefault(); // arrows would otherwise scroll the pane behind the handle
    this.committed.emit(this.clamp(next));
  }

  private fromKey(key: string, step: number): number | null {
    const grow = this.invert() ? -step : step;
    switch (key) {
      case 'ArrowLeft':
        return this.value() - grow;
      case 'ArrowRight':
        return this.value() + grow;
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

  /** The element carrying the custom property: the shell, not this handle. */
  private shell(): HTMLElement | null {
    return this.host.nativeElement.closest('[data-shell-root]');
  }
}
