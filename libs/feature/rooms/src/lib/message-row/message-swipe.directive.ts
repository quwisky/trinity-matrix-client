import {
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { HapticsService } from '@trinity/platform-native';
import {
  DRAWER_OUTER_EDGE_PX,
  NATIVE_HISTORY_EDGE_PX,
} from '../rooms/drawer-swipe.directive';

/**
 * How far in from the RIGHT viewport edge a message swipe refuses to start, in either direction.
 *
 * The shell's drawer opens in a 24px band inside a 32px native-history strip (WebKit Forward,
 * Android's right-edge Back), and native recognisers are outside CSS, so the only lever is refusing
 * to arm through that region, measured at `pointerdown` because that is the only moment the
 * decision can be made without having already competed. Both directions: the drawer arms on this
 * same `pointerdown` whichever way the finger then goes, and an armed row stops its propagation.
 * `message-row.swipe.spec.ts` pins that it is never narrower than the drawer's.
 */
export const SWIPE_DEAD_ZONE_PX = DRAWER_OUTER_EDGE_PX;

/**
 * How far in from the LEFT viewport edge a RIGHTWARD swipe refuses to start: iOS's Back and
 * Android's left-edge Back are rightward edge pans. The same 32px strip the drawer leaves to native
 * history on the right. A leftward swipe has no competitor at that edge, so it gets no zone there.
 */
export const SWIPE_BACK_EDGE_PX = NATIVE_HISTORY_EDGE_PX;

/**
 * How far a row must travel before releasing it acts. Fixed, not a share of the row: a quarter of
 * a phone-width row was ~90px, too far for a thumb. About one and a half 44px touch targets.
 */
const SWIPE_COMMIT_PX = 64;

/** A quicker release commits short of {@link SWIPE_COMMIT_PX}: average speed, and the least travel that counts. */
const SWIPE_FLICK_PX_PER_MS = 0.4;
const SWIPE_FLICK_MIN_PX = 32;

/**
 * How much more sideways than vertical the opening travel must be to be this gesture. The axis is
 * decided once, as the browser decides its own pan under `touch-action: pan-y`: once a drag opened
 * sideways the browser does not scroll it, so later vertical drift (a thumb's arc) is ignored.
 */
const SWIPE_AXIS_BIAS = 1.2;

/** Travel that decides the axis; the row's long-press slop, so a decided swipe has already cancelled the press. */
export const SWIPE_SLOP_PX = 10;

/** Which way a row is dragged to act on it, as resolved by whoever renders the row. */
export type SwipeDirection = 'off' | 'left' | 'right';

/**
 * The sideways drag on a message row: arm, follow the finger, commit or spring back.
 *
 * It owns no listeners: the row forwards `pointerdown`/`pointermove`/`pointerup` so the swipe, the
 * long press and the drawer's `stopPropagation` keep one ordering, and calls {@link cancel} when
 * the long press wins. The host element is the box that moves.
 */
@Directive({ selector: '[trnMessageSwipe]' })
export class MessageSwipeDirective {
  private readonly el =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly haptics = inject(HapticsService);
  private start: { x: number; y: number; id: number; t: number } | null = null;
  /** True once the opening travel was sideways: this gesture, not a scroll. */
  private swiping = false;

  readonly direction = input<SwipeDirection>('off', {
    alias: 'trnMessageSwipe',
  });
  /** Both outcomes are unavailable on a read-only row: there is no composer to reply into. */
  readonly swipeEnabled = input(true);
  /** A drag that travelled far enough was released. */
  readonly swipe = output<void>();

  constructor() {
    // A row destroyed mid-drag leaves `start` set and `release` early-returns on a null one, so
    // this stops a destroyed row committing. NOT a capture release: the browser drops capture
    // when the element leaves the document.
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  /** Arm a sideways drag, if every condition holds; whether it armed decides propagation. */
  arm(event: PointerEvent): boolean {
    const direction = this.direction();
    if (direction === 'off' || !this.swipeEnabled()) {
      return false;
    }
    // Measured at the START in viewport coordinates, where the competitors live. A drag that
    // begins in the middle and travels INTO an edge is fine: those recognisers are edge-start.
    const width = typeof window === 'undefined' ? 0 : window.innerWidth;
    const leftZone = direction === 'right' ? SWIPE_BACK_EDGE_PX : 0;
    if (
      event.clientX <= leftZone ||
      width - event.clientX <= SWIPE_DEAD_ZONE_PX
    ) {
      return false;
    }
    this.start = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
      t: event.timeStamp,
    };
    this.swiping = false;
    // Without capture, a drag drifting off a one-line continuation row never sees its `pointerup`
    // and leaves the row translated. The host, not `event.target`: the deepest hit element (a link,
    // an avatar) takes the capture with it. jsdom has no pointer capture, hence the optional call.
    this.el.setPointerCapture?.(event.pointerId);
    return true;
  }

  /** Track an armed drag, or abandon it if it opens as a scroll. */
  track(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.id) {
      return;
    }
    if (!this.swiping) {
      const dx = Math.abs(event.clientX - start.x);
      const dy = Math.abs(event.clientY - start.y);
      if (Math.max(dx, dy) <= SWIPE_SLOP_PX) {
        return;
      }
      if (dx <= dy * SWIPE_AXIS_BIAS) {
        this.cancel();
        return;
      }
      // Press, pause, drag is handled the other way round: the row's long-press timer calls `cancel()`.
      this.swiping = true;
    }
    this.paint(this.travelled(event));
  }

  /** Release an armed drag: commit past the distance or on a flick, otherwise put the row back. */
  release(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.id) {
      return;
    }
    // The release point is the final position: a flick can end well past the last `pointermove`.
    const travelled = this.travelled(event);
    const speed = travelled / Math.max(1, event.timeStamp - start.t);
    const committed =
      this.swiping &&
      (travelled >= SWIPE_COMMIT_PX ||
        (travelled >= SWIPE_FLICK_MIN_PX && speed >= SWIPE_FLICK_PX_PER_MS));
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
   * Move the row under the finger. Custom properties are written straight to the element per
   * `pointermove`, as the drawer and pane handle do: a signal write per move on an OnPush row
   * would run change detection over the whole timeline for a value only CSS reads.
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

    // How far along the gesture is, 0 to 1: the affordance grows with the drag so a reader can see
    // the action arriving and let go before it does. A property CSS interpolates, not a transition.
    // The clamp is load-bearing: otherwise a long drag scales the icon unbounded.
    const progress = Math.min(1, distance / SWIPE_COMMIT_PX);
    msg.style.setProperty('--swipe-progress', `${progress.toFixed(3)}`);

    // Drives the icon's visibility and the 1:1 follow; the eased spring-back returns when this
    // comes off. Past the threshold, releasing now WILL act.
    msg.classList.add('msg--swiping');
    const armed = progress >= 1;
    if (armed && !msg.classList.contains('msg--swipe-armed')) {
      this.haptics.thresholdReached();
    }
    msg.classList.toggle('msg--swipe-armed', armed);
  }
}
