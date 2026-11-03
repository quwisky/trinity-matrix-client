import type { MessageLongPressContext } from '../message-row/message-row.component';

/** Visual gap between the acted-on message and the sheet edge. */
const SHEET_GAP_PX = 8;
/**
 * Keep enough of a compact sheet to expose a useful control plus its scroll affordance, at
 * the default text size. See `minSheetHeight` for larger text.
 */
const MIN_SHEET_HEIGHT_PX = 88;
const SCROLLER_SELECTOR = '[data-message-scroller]';

function minSheetHeight(surface: HTMLElement): number {
  // The sheet inherits the root text size, which is what its rem-sized chrome follows.
  const scale = Number.parseFloat(getComputedStyle(surface).fontSize) / 16 || 1;
  // At large text the chrome (grabber, date, reactions) alone fills the floor, so half the
  // screen is the least that still leaves an action row to scroll to.
  return scale > 1
    ? Math.max(MIN_SHEET_HEIGHT_PX * scale, window.innerHeight / 2)
    : MIN_SHEET_HEIGHT_PX;
}

/** How far the sheet's entrance still has to travel. */
function remainingSlide(surface: HTMLElement): number {
  const { transform } = getComputedStyle(surface);
  return transform.startsWith('matrix')
    ? new DOMMatrixReadOnly(transform).m42
    : 0;
}

/** Where the sheet will rest, which is what its height and the tail range must be sized for. */
function restingBox(
  surface: HTMLElement,
): Pick<DOMRect, 'top' | 'bottom' | 'height'> {
  const { top, bottom, height } = surface.getBoundingClientRect();
  const slide = remainingSlide(surface);
  return { top: top - slide, bottom: bottom - slide, height };
}

/**
 * One action sheet's temporary relationship with the timeline behind it. The modal's fixed
 * overlay does not take part in timeline layout, so this session freezes user scrolling, adds
 * the measured occluded band as tail range, moves the pressed row above the sheet, and restores
 * the row's original visual position on close. It owns every DOM mutation it makes and is safe
 * to release repeatedly.
 */
export class MessageSheetViewportSession {
  private readonly anchor: HTMLElement;
  private readonly scroller: HTMLElement | null;
  private readonly initialAnchorTop: number;
  private readonly pressOffset: number;
  private readonly spacer: HTMLElement;
  private active = false;
  private frameId: number | null = null;
  private surface: HTMLElement | null = null;
  private originalSurfaceMaxHeight = '';
  private originalOverflowY = '';
  private surfaceHeightChanged = false;
  private surfaceAttempts = 0;

  constructor(
    context: MessageLongPressContext,
    private readonly resolveSurface: () => HTMLElement | null,
  ) {
    this.anchor = context.anchor;
    this.scroller = context.anchor.closest<HTMLElement>(SCROLLER_SELECTOR);
    const anchorRect = context.anchor.getBoundingClientRect();
    this.initialAnchorTop = anchorRect.top;
    this.pressOffset = Math.max(
      0,
      Math.min(anchorRect.height, context.clientY - anchorRect.top),
    );
    this.spacer = document.createElement('div');
    this.spacer.setAttribute('data-message-sheet-clearance', '');
    this.spacer.setAttribute('aria-hidden', 'true');
    this.spacer.style.flex = '0 0 auto';
    this.spacer.style.pointerEvents = 'none';
  }

  /** Position after CDK has rendered this invocation's surface. */
  start(): void {
    if (this.active || !this.scroller) {
      return;
    }
    this.active = true;
    // The press that opened the sheet may still be down. If its finger moves, iOS gives it the
    // scroll view, which overwrites every write here and drags the row under the sheet.
    this.originalOverflowY = this.scroller.style.overflowY;
    this.scroller.style.overflowY = 'hidden';
    this.schedule(() => this.position());
  }

  /** Remove the temporary range and put the same row back where the reader pressed it. */
  release(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }

    this.spacer.remove();
    if (this.scroller) {
      this.scroller.style.overflowY = this.originalOverflowY;
    }
    if (this.surfaceHeightChanged && this.surface) {
      this.surface.style.maxHeight = this.originalSurfaceMaxHeight;
    }

    const scroller = this.scroller;
    if (
      !scroller?.isConnected ||
      !this.anchor.isConnected ||
      !scroller.contains(this.anchor)
    ) {
      return;
    }

    // Anchor-relative restoration survives a resize or newly-measured virtual rows; a saved
    // raw scrollTop would replay stale geometry.
    const currentTop = this.anchor.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollTop + currentTop - this.initialAnchorTop,
    );
  }

  private position(): void {
    if (!this.valid()) {
      return;
    }
    const surface = this.resolveSurface();
    if (!surface?.isConnected) {
      // A bounded retry covers a frame where CDK has attached the pane but Angular has not
      // populated the sheet view yet.
      if (++this.surfaceAttempts < 3) {
        this.schedule(() => this.position());
      }
      return;
    }
    this.surface = surface;

    const scrollerRect = this.scroller!.getBoundingClientRect();
    const anchorRect = this.anchor.getBoundingClientRect();
    let surfaceRect = restingBox(surface);

    // A scrollable sheet may shrink to leave a normal message fully visible. A very tall
    // message cannot, without reducing the sheet to nothing; it keeps a minimum sheet and
    // preserves the slice the reader pressed.
    const fitHeight =
      surfaceRect.bottom -
      (scrollerRect.top + anchorRect.height + SHEET_GAP_PX);
    if (fitHeight < surfaceRect.height) {
      this.originalSurfaceMaxHeight = surface.style.maxHeight;
      surface.style.maxHeight = `${Math.max(minSheetHeight(surface), fitHeight)}px`;
      this.surfaceHeightChanged = true;
      surfaceRect = restingBox(surface);
    }

    const delta = this.requiredScrollDelta(
      anchorRect,
      scrollerRect,
      surfaceRect,
    );
    if (delta > 0) {
      const clearance = Math.max(
        0,
        scrollerRect.bottom - surfaceRect.top + SHEET_GAP_PX,
      );
      this.spacer.style.height = `${clearance}px`;
      this.scroller!.append(this.spacer);
    }

    this.schedule(() => this.follow());
  }

  /**
   * While the sheet slides, only its edge moves the row, and no further than the row must go at
   * rest: scrolling there at once would jump the timeline ahead of the sheet. The write that lands
   * the row can flip the list's window, so it gets one more look a frame later, and only one: the
   * rounding `requiredScrollDelta` allows could otherwise keep it correcting. Every read here
   * revalidates connectivity.
   */
  private follow(lastLook = false): void {
    if (!this.valid() || !this.surface?.isConnected) {
      return;
    }
    const anchor = this.anchor.getBoundingClientRect();
    const sliding = remainingSlide(this.surface) !== 0;
    const toRest = this.requiredScrollDelta(
      anchor,
      this.scroller!.getBoundingClientRect(),
      restingBox(this.surface),
    );
    const edge = this.surface.getBoundingClientRect().top - SHEET_GAP_PX;
    const delta = sliding
      ? Math.min(Math.max(0, toRest), Math.max(0, anchor.bottom - edge))
      : toRest;
    if (delta !== 0) {
      this.scroller!.scrollTop = Math.max(0, this.scroller!.scrollTop + delta);
    }
    if (sliding) {
      this.schedule(() => this.follow());
    } else if (delta !== 0 && !lastLook) {
      this.schedule(() => this.follow(true));
    }
  }

  private requiredScrollDelta(
    anchor: DOMRect,
    scroller: DOMRect,
    surface: Pick<DOMRect, 'top'>,
  ): number {
    const visibleTop = scroller.top;
    const visibleBottom = Math.max(
      visibleTop,
      Math.min(scroller.bottom, surface.top - SHEET_GAP_PX),
    );
    const visibleHeight = visibleBottom - visibleTop;

    // A sheet shrunk to fit leaves exactly the row's height, and a sliding sheet's resting top
    // is only good to a fraction of a pixel.
    if (anchor.height <= visibleHeight + 1) {
      if (anchor.bottom > visibleBottom) {
        return anchor.bottom - visibleBottom;
      }
      if (anchor.top < visibleTop) {
        return anchor.top - visibleTop;
      }
      return 0;
    }

    // Whole-row visibility is impossible; keep the long-pressed point inside the unobscured band.
    const pressY = anchor.top + this.pressOffset;
    if (pressY > visibleBottom) {
      return pressY - visibleBottom;
    }
    if (pressY < visibleTop) {
      return pressY - visibleTop;
    }
    return 0;
  }

  private valid(): boolean {
    return !!(
      this.active &&
      this.scroller?.isConnected &&
      this.anchor.isConnected &&
      this.scroller.contains(this.anchor)
    );
  }

  private schedule(callback: () => void): void {
    if (!this.active) {
      return;
    }
    this.frameId = requestAnimationFrame(() => {
      this.frameId = null;
      callback();
    });
  }
}
