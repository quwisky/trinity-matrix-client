import {
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';

/**
 * How far in from either viewport edge a message swipe refuses to START.
 *
 * Both competitors are viewport-anchored, and neither can be argued with once it has the
 * gesture: the shell's drawer opens in a 24px band immediately inside a 32px native-history
 * strip, and native recognisers are outside CSS entirely. So the only lever is to refuse to
 * arm through that combined region, measured at `pointerdown` because that is the only moment
 * the decision can be made without having already competed.
 *
 * Wider than the drawer's zone and wider than the platform regions, whose widths Apple and
 * Google do not publish — chosen with margin rather than derived. `message-row.swipe.spec.ts`
 * pins that it is never narrower than the drawer's; a device is what confirms it clears the
 * platform's.
 */
export const SWIPE_DEAD_ZONE_PX = 56;

/** How far a row must travel, as a fraction of its own width, before the action commits. */
const SWIPE_COMMIT_FRACTION = 0.25;

/** How far the pointer may drift vertically before the drag is a scroll instead. */
const SWIPE_VERTICAL_SLOP_PX = 12;

/** Horizontal travel that makes a drag definitely a swipe; the row's long-press slop. */
const SWIPE_SLOP_PX = 10;

/** Which way a row is dragged to act on it, as resolved by whoever renders the row. */
export type SwipeDirection = 'off' | 'left' | 'right';

/**
 * The sideways drag on a message row: arm, follow the finger, commit or spring back.
 *
 * It owns no listeners. The row forwards `pointerdown`/`pointermove`/`pointerup` so the
 * swipe, the long press and the drawer's `stopPropagation` keep one ordering, and calls
 * {@link cancel} when the long press wins. The host element is the box that moves.
 */
@Directive({ selector: '[trnMessageSwipe]' })
export class MessageSwipeDirective {
  private readonly el =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private start: { x: number; y: number; id: number } | null = null;
  /** True once a drag has passed the slop and is definitely this gesture, not a scroll. */
  private swiping = false;

  readonly direction = input<SwipeDirection>('off', {
    alias: 'trnMessageSwipe',
  });
  /** Both outcomes are unavailable on a read-only row — there is no composer to reply into. */
  readonly swipeEnabled = input(true);
  /** A drag that travelled far enough was released. */
  readonly swipe = output<void>();

  constructor() {
    // A row destroyed mid-drag leaves `start` set, and `release` early-returns on a null one,
    // so this is what makes a destroyed row unable to commit. NOT a capture release: the
    // browser drops the capture when the element leaves the document.
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  /** Arm a sideways drag, if every condition holds; whether it armed decides propagation. */
  arm(event: PointerEvent): boolean {
    if (this.direction() === 'off' || !this.swipeEnabled()) {
      return false;
    }
    // Measured at the START, in viewport coordinates, because that is where the competitors
    // live. A drag that begins in the middle and travels INTO an edge is fine: these are
    // edge-start recognisers, so nothing takes it away mid-gesture.
    const width = typeof window === 'undefined' ? 0 : window.innerWidth;
    if (
      event.clientX <= SWIPE_DEAD_ZONE_PX ||
      width - event.clientX <= SWIPE_DEAD_ZONE_PX
    ) {
      return false;
    }
    this.start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    this.swiping = false;
    // Without capture, a drag that drifts off a one-line continuation row never sees its
    // `pointerup` and leaves the row translated with nothing to put it back. The host, not
    // `event.target`: the deepest hit element (a link, an avatar) takes the capture with it.
    // jsdom has no pointer capture at all, hence the optional call.
    this.el.setPointerCapture?.(event.pointerId);
    return true;
  }

  /** Track an armed drag, or abandon it if it turns out to be a scroll. */
  track(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.id) {
      return;
    }
    if (Math.abs(event.clientY - start.y) > SWIPE_VERTICAL_SLOP_PX) {
      this.cancel();
      return;
    }
    const travelled = this.travelled(event);
    // The press → pause → drag case is handled the other way round, by the row's long-press
    // timer calling `cancel()` when it fires.
    if (travelled > SWIPE_SLOP_PX) {
      this.swiping = true;
    }
    this.paint(travelled);
  }

  /** Release an armed drag: commit past the threshold, otherwise put the row back. */
  release(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.id) {
      return;
    }
    const travelled = this.travelled(event);
    // The host is the `.msg` that moves; the component around it has no box of its own.
    const width = this.el.getBoundingClientRect().width;
    const committed =
      this.swiping && width > 0 && travelled >= width * SWIPE_COMMIT_FRACTION;
    this.cancel();
    if (committed) {
      this.swipe.emit();
    }
  }

  /** Disarm, put the row back, and forget the pointer. */
  cancel(): void {
    this.start = null;
    this.swiping = false;
    this.paint(0);
  }

  /** Travel is only counted in the direction asked for; the other way clamps to zero. */
  private travelled(event: PointerEvent): number {
    const delta = event.clientX - (this.start?.x ?? event.clientX);
    return this.direction() === 'left'
      ? Math.max(0, -delta)
      : Math.max(0, delta);
  }

  /**
   * Move the row under the finger.
   *
   * Custom properties written straight to the element per `pointermove`, as the drawer and
   * the pane handle do: a signal write per move on an OnPush row would run change detection
   * over the whole timeline for a value only CSS reads.
   */
  private paint(distance: number): void {
    const msg = this.el;
    if (distance <= 0) {
      msg.style.removeProperty('--swipe-drag');
      msg.style.removeProperty('--swipe-progress');
      msg.classList.remove('msg--swiping', 'msg--swipe-armed');
      return;
    }
    const signed = this.direction() === 'left' ? -distance : distance;
    msg.style.setProperty('--swipe-drag', `${Math.round(signed)}px`);

    // How far along the gesture is, 0 → 1: the affordance grows with the drag rather than
    // snapping on, so a reader can see the action arriving and let go before it does. A
    // property CSS interpolates directly, not a transition chasing the finger.
    const commitAt = msg.getBoundingClientRect().width * SWIPE_COMMIT_FRACTION;
    // Clamped, and the clamp is load-bearing: without it a long drag drives the icon's scale
    // past 1 and on up with the finger, unbounded.
    const progress = commitAt > 0 ? Math.min(1, distance / commitAt) : 0;
    msg.style.setProperty('--swipe-progress', `${progress.toFixed(3)}`);

    // Drives the icon's visibility and the 1:1 follow; the eased spring-back returns when
    // this comes off. Past the threshold, releasing now WILL act.
    msg.classList.add('msg--swiping');
    msg.classList.toggle('msg--swipe-armed', progress >= 1);
  }
}
