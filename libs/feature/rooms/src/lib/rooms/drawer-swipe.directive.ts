import { Directive, ElementRef, inject, input, output } from '@angular/core';
import { prefersReducedMotion } from '@trinity/util/ui';

/**
 * Swipe the right-hand drawer open, and swipe it away again.
 *
 * ## What this is, and is not, for
 *
 * Only the layout below the `members` breakpoint has a drawer: there the right-hand slot is a
 * fixed overlay over the timeline. Above it the slot is a column sharing the row, and there is
 * nothing to swipe.
 *
 * The room list is deliberately NOT handled here. Below `md` it is not a drawer at all — it is
 * a separate page keyed off the open room, which lives in the URL, so "swipe back to the room
 * list" is the platform's own back gesture: Android routes it to `backButton` and iOS has it
 * since `MainViewController` enabled it. Re-implementing that in JavaScript would compete with
 * a gesture the OS already does better.
 *
 * ## Why the drag writes CSS
 *
 * The same reason `PaneHandleComponent` does. The finger is dragging a surface laid over the
 * timeline — a custom virtual scroller with per-row measured heights and two `ResizeObserver`s
 * — and a signal write per `pointermove` would put an Angular render between every frame of a
 * gesture. So the drag writes one custom property and nothing else; the slot's own state is
 * written once, at the end, when the gesture has decided.
 *
 * The property only has a consumer in the CLOSING direction: an opening swipe is measured
 * before the slot holds anything, so there is no drawer on screen to translate and it arrives
 * at the end of the gesture instead of tracking the finger. Recorded on the rule that reads
 * it, in `rooms.page.scss`.
 *
 * ## Deciding
 *
 * Distance OR speed, because both are things people mean. A slow deliberate drag past the
 * halfway point is a decision; so is a quick flick that never gets there. Requiring distance
 * alone makes flicking feel broken, and speed alone makes a careful drag impossible to abort.
 */

/** How far in from the right edge a closing gesture may start, in px. */
/**
 * Exported so the message swipe can pin that its own dead zone is never narrower than this.
 * The two constants have to move together — a swipe arming inside the drawer's opening zone
 * would put both gestures on the same finger.
 */
export const EDGE_ZONE_PX = 24;

/** A drag must beat one of these to commit: this fraction of the drawer, or this speed. */
const COMMIT_FRACTION = 0.4;
const COMMIT_VELOCITY_PX_PER_MS = 0.5;

/**
 * Vertical slop before a gesture is abandoned as a scroll.
 *
 * The drawer's own content scrolls vertically, so a finger that starts sideways and turns
 * downward is reading, not dismissing.
 */
const VERTICAL_SLOP_PX = 12;

@Directive({
  selector: '[trnDrawerSwipe]',
  host: {
    '(pointerdown)': 'onPointerDown($event)',
  },
})
export class DrawerSwipeDirective {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Whether the drawer is currently showing — decides which gesture is available. */
  readonly drawerOpen = input.required<boolean>();

  /** Whether this layout HAS a drawer at all. False above the `members` breakpoint. */
  readonly drawerEnabled = input.required<boolean>();

  /** The drawer's width in px, so a fractional threshold means something. */
  readonly drawerWidth = input.required<number>();

  /** A completed open gesture. */
  readonly opened = output<void>();
  /** A completed close gesture. */
  readonly closed = output<void>();

  private tracking = false;
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private startedAt = 0;
  private latest = 0;

  onPointerDown(event: PointerEvent): void {
    if (!this.drawerEnabled() || event.pointerType === 'mouse') {
      return; // a mouse has the button; this is the touch affordance
    }
    const fromEdge =
      window.innerWidth - event.clientX <= EDGE_ZONE_PX && !this.drawerOpen();
    const onDrawer = this.drawerOpen();
    if (!fromEdge && !onDrawer) {
      return;
    }
    this.tracking = true;
    this.pointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.startedAt = event.timeStamp;
    this.latest = 0;
    // Captured, for the same two reasons `PaneHandleComponent` captures: a drag that leaves
    // this element keeps reporting here rather than to whatever it crossed, and `pointerup`
    // arrives unconditionally. Without it a gesture released outside the host — sideways into
    // the sidebar column, which is a sibling between `md` and `members` — never completes,
    // and the drawer is left translated mid-drag until the next press.
    //
    // Capture also binds the gesture to ONE pointer, which the `pointerId` guards below
    // finish: a second finger landing mid-drag must not be read as the same swipe.
    this.host.nativeElement.setPointerCapture?.(event.pointerId);
    this.host.nativeElement.addEventListener('pointermove', this.onPointerMove);
    this.host.nativeElement.addEventListener('pointerup', this.onPointerUp);
    this.host.nativeElement.addEventListener(
      'pointercancel',
      this.onPointerCancel,
    );
  }

  /**
   * Arrow properties, not methods: these are added and removed by reference, and a bare method
   * would be a new function object each time and so could never be removed.
   */
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.tracking || event.pointerId !== this.pointerId) {
      return;
    }
    if (Math.abs(event.clientY - this.startY) > VERTICAL_SLOP_PX) {
      // Turned into a scroll. Abandon rather than fight it — the drawer's content scrolls.
      this.cancel();
      return;
    }
    this.track(event);
    this.paint(this.latest);
  };

  /** How far the gesture has travelled in the direction that means something. */
  private track(event: PointerEvent): void {
    const delta = event.clientX - this.startX;
    // Opening drags LEFT (negative) from the right edge; closing drags RIGHT (positive).
    this.latest = this.drawerOpen() ? Math.max(0, delta) : Math.max(0, -delta);
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.tracking || event.pointerId !== this.pointerId) {
      return;
    }
    // The release point is the final position, not just the last move: a fast gesture can end
    // with the pointer well past wherever the last `pointermove` was delivered, and judging it
    // on the stale figure reads a decisive swipe as a hesitant one.
    this.track(event);
    const elapsed = Math.max(1, event.timeStamp - this.startedAt);
    const velocity = this.latest / elapsed;
    const committed =
      this.latest >= this.drawerWidth() * COMMIT_FRACTION ||
      velocity >= COMMIT_VELOCITY_PX_PER_MS;
    const wasOpen = this.drawerOpen();
    this.cancel();

    if (!committed) {
      return; // snapped back; nothing changed
    }
    if (wasOpen) {
      this.closed.emit();
    } else {
      this.opened.emit();
    }
  };

  private readonly onPointerCancel = (): void => this.cancel();

  /** Stop tracking and hand the layout back to CSS. */
  private cancel(): void {
    if (this.pointerId !== null) {
      this.host.nativeElement.releasePointerCapture?.(this.pointerId);
      this.pointerId = null;
    }
    this.tracking = false;
    this.paint(null);
    this.host.nativeElement.removeEventListener(
      'pointermove',
      this.onPointerMove,
    );
    this.host.nativeElement.removeEventListener('pointerup', this.onPointerUp);
    this.host.nativeElement.removeEventListener(
      'pointercancel',
      this.onPointerCancel,
    );
  }

  /**
   * The whole gesture, as one custom property on the shell.
   *
   * Skipped entirely under `prefers-reduced-motion`: someone who asked for less movement did
   * not ask for a surface that tracks their finger. The gesture still WORKS — the commit below
   * is unaffected — it simply arrives without the drag following it, which is the same bargain
   * the reduced-motion reset makes everywhere else.
   */
  private paint(px: number | null): void {
    if (prefersReducedMotion()) {
      return;
    }
    const shell = this.host.nativeElement.closest('[data-shell-root]');
    if (!(shell instanceof HTMLElement)) {
      return;
    }
    if (px === null) {
      shell.style.removeProperty('--drawer-drag');
      return;
    }
    shell.style.setProperty('--drawer-drag', `${px}px`);
  }
}
