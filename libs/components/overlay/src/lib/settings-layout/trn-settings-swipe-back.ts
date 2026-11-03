import {
  DestroyRef,
  Directive,
  ElementRef,
  effect,
  inject,
  input,
  output,
} from '@angular/core';

/** A swipe back starts this close (px) to the leading edge of the layout. */
const EDGE_PX = 24;
/** A touch must travel this far (px) before it is judged a swipe back or not. */
const CLAIM_SLOP = 6;
/** A drag must beat one of these to commit: this fraction of the page, or this speed. */
const COMMIT_FRACTION = 0.4;
/** px per ms */
const FLING_VELOCITY = 0.5;
/** A fling must also travel this far (px), so a twitch never goes back. */
const FLING_MIN_DISTANCE = 24;
/** Controls and surfaces that keep their own drag, as in `TrnSheetDrag`. */
const OWN_GESTURE =
  'input, textarea, select, [contenteditable], [role="slider"], canvas, pre, code, [data-trn-sheet-no-drag]';

/**
 * Swipe a compact settings section back to its directory, from the leading edge. The section
 * follows the finger over the directory, which shifts underneath as the page slide draws it,
 * then commits past a threshold or springs back.
 *
 * It is for a layout in a dialog: WebKit's own history swipe is off while one is open. The
 * routed page leaves the swipe to the platform. The drag writes styles, not signals, so no
 * render runs per frame; a sheet's downward drag lets a sideways touch go, and this lets a
 * downward one go, so the two never both claim a touch.
 */
@Directive({ selector: '[trnSettingsSwipeBack]' })
export class TrnSettingsSwipeBack {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private stop: (() => void) | null = null;
  private settling: Animation[] = [];

  /** A section is open in a compact layout, so there is a directory to go back to. */
  readonly enabled = input(false, { alias: 'trnSettingsSwipeBack' });
  /** The section page that follows the finger. */
  readonly page = input.required<HTMLElement>({
    alias: 'trnSettingsSwipeBackPage',
  });
  /** The directory underneath. */
  readonly under = input.required<HTMLElement>({
    alias: 'trnSettingsSwipeBackUnder',
  });
  /** A committed swipe; the page has already left, so Back draws no slide of its own. */
  readonly swiped = output<void>();

  constructor() {
    const start = (event: TouchEvent) => this.begin(event);
    this.host.addEventListener('touchstart', start, { passive: true });
    // A committed page stays where the finger left it until the section has closed.
    effect(() => {
      if (!this.enabled()) this.reset();
    });
    inject(DestroyRef).onDestroy(() => {
      this.stop?.();
      this.host.removeEventListener('touchstart', start);
    });
  }

  private begin(event: TouchEvent): void {
    const touch = event.touches[0];
    if (
      !this.enabled() ||
      this.settling.length > 0 ||
      event.touches.length !== 1 ||
      !touch ||
      touch.clientX - this.host.getBoundingClientRect().left > EDGE_PX ||
      !this.canSwipe(event.target as Element | null)
    ) {
      return;
    }
    this.stop?.();
    const { clientX: x0, clientY: y0 } = touch;
    const width = this.page().getBoundingClientRect().width || 1;
    let claimed = false;
    let decided = false;
    let lastX = x0;

    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      lastX = t.clientX;
      if (!decided) {
        const dx = t.clientX - x0;
        const dy = t.clientY - y0;
        if (Math.hypot(dx, dy) < CLAIM_SLOP) return;
        decided = true;
        if (dx <= 0 || Math.abs(dy) >= dx || !e.cancelable) return finish();
        claimed = true;
        this.host.setAttribute('data-pane-swipe', '');
      }
      e.preventDefault();
      this.paint(Math.max(0, t.clientX - x0), width);
    };
    const end = (e: TouchEvent) => {
      const wasClaimed = claimed;
      finish();
      if (!wasClaimed) return;
      const dx = Math.max(0, lastX - x0);
      const velocity = dx / Math.max(1, e.timeStamp - event.timeStamp);
      const commit =
        e.type !== 'touchcancel' &&
        (dx > width * COMMIT_FRACTION ||
          (dx > FLING_MIN_DISTANCE && velocity > FLING_VELOCITY));
      this.settle(commit);
    };
    const options = { passive: false } as const;
    const finish = () => {
      this.host.removeEventListener('touchmove', move);
      this.host.removeEventListener('touchend', end);
      this.host.removeEventListener('touchcancel', end);
      this.stop = null;
    };
    this.host.addEventListener('touchmove', move, options);
    this.host.addEventListener('touchend', end);
    this.host.addEventListener('touchcancel', end);
    this.stop = finish;
  }

  /** The page under the finger; Reduce Motion keeps it still until the swipe is decided. */
  private paint(px: number, width: number): void {
    if (reducedMotion()) return;
    this.page().style.transform = `translateX(${px}px)`;
    this.under().style.transform = `translateX(${(Math.min(px / width, 1) - 1) * 30}%)`;
  }

  /** Finish the page's travel, with the page slide's timing, from wherever the finger left it. */
  private settle(commit: boolean): void {
    const duration =
      Number.parseFloat(
        getComputedStyle(this.host).getPropertyValue('--trinity-duration-base'),
      ) || 0;
    const options: KeyframeAnimationOptions = {
      duration: reducedMotion() ? 0 : duration,
      easing: getComputedStyle(this.host)
        .getPropertyValue('--trinity-ease-standard')
        .trim(),
      fill: 'forwards',
    };
    const travel = (element: HTMLElement, to: string): Animation =>
      element.animate(
        [{ transform: element.style.transform || 'none' }, { transform: to }],
        options,
      );
    this.settling = [
      travel(this.page(), commit ? 'translateX(100%)' : 'translateX(0)'),
      travel(this.under(), commit ? 'translateX(0)' : 'translateX(-30%)'),
    ];
    void Promise.all(this.settling.map((a) => a.finished)).then(
      () => (commit ? this.swiped.emit() : this.reset()),
      // Cancelled by a reset: the section closed some other way first.
      () => undefined,
    );
  }

  private reset(): void {
    const settling = this.settling;
    this.settling = [];
    for (const animation of settling) animation.cancel();
    this.host.removeAttribute('data-pane-swipe');
    this.page().style.removeProperty('transform');
    this.under().style.removeProperty('transform');
  }

  /** Nothing under the finger owns a sideways drag of its own. */
  private canSwipe(target: Element | null): boolean {
    if (!target || target.closest(OWN_GESTURE)) return false;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return false;
    for (let el: Element | null = target; el && el !== this.host;) {
      const style = getComputedStyle(el);
      if (
        /^(none|pan-x)$/.test(style.touchAction) ||
        (el.scrollWidth > el.clientWidth && /auto|scroll/.test(style.overflowX))
      ) {
        return false;
      }
      el = el.parentElement;
    }
    return true;
  }
}

function reducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
