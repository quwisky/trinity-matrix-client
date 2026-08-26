import type { MessageLongPressContext } from '../message-row/message-row.component';

/** Visual gap between the acted-on message and the sheet edge. */
const SHEET_GAP_PX = 8;
/** Keep enough of a compact sheet to expose a useful control plus its scroll affordance. */
const MIN_SHEET_HEIGHT_PX = 88;
const SCROLLER_SELECTOR = '[data-message-scroller]';

/**
 * One action sheet's temporary relationship with the timeline behind it.
 *
 * The modal correctly blocks user scrolling, but its fixed overlay does not participate in
 * timeline layout. This session adds only the measured occluded band as tail range, moves
 * the pressed row above the exact sheet invocation, then restores the row's original visual
 * position on close. It owns every DOM mutation it makes and is safe to release repeatedly.
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

    // Anchor-relative restoration survives a resize or newly-measured virtual rows. A saved
    // raw scrollTop would replay stale geometry and land somewhere else in both cases.
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
      // Component queries settle with the dialog render. A bounded retry handles a frame in
      // which CDK has attached the pane but Angular has not populated the sheet view yet.
      if (++this.surfaceAttempts < 3) {
        this.schedule(() => this.position());
      }
      return;
    }
    this.surface = surface;

    const scrollerRect = this.scroller!.getBoundingClientRect();
    const anchorRect = this.anchor.getBoundingClientRect();
    let surfaceRect = surface.getBoundingClientRect();

    // A scrollable sheet may shrink to leave a normal message fully visible. Very tall
    // messages cannot satisfy that invariant without reducing the sheet to nothing; they
    // keep a useful minimum sheet and preserve the exact slice the reader pressed instead.
    const fitHeight =
      surfaceRect.bottom -
      (scrollerRect.top + anchorRect.height + SHEET_GAP_PX);
    if (fitHeight < surfaceRect.height) {
      this.originalSurfaceMaxHeight = surface.style.maxHeight;
      surface.style.maxHeight = `${Math.max(MIN_SHEET_HEIGHT_PX, fitHeight)}px`;
      this.surfaceHeightChanged = true;
      surfaceRect = surface.getBoundingClientRect();
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
      this.scroller!.scrollTop = Math.max(0, this.scroller!.scrollTop + delta);
    }

    // Layout clamping and virtual-window re-rendering happen after the first write. One
    // invocation-scoped correction is enough; every read below revalidates connectivity.
    this.schedule(() => this.correct());
  }

  private correct(): void {
    if (!this.valid() || !this.surface?.isConnected) {
      return;
    }
    const delta = this.requiredScrollDelta(
      this.anchor.getBoundingClientRect(),
      this.scroller!.getBoundingClientRect(),
      this.surface.getBoundingClientRect(),
    );
    if (delta !== 0) {
      this.scroller!.scrollTop = Math.max(0, this.scroller!.scrollTop + delta);
    }
  }

  private requiredScrollDelta(
    anchor: DOMRect,
    scroller: DOMRect,
    surface: DOMRect,
  ): number {
    const visibleTop = scroller.top;
    const visibleBottom = Math.max(
      visibleTop,
      Math.min(scroller.bottom, surface.top - SHEET_GAP_PX),
    );
    const visibleHeight = visibleBottom - visibleTop;

    if (anchor.height <= visibleHeight) {
      if (anchor.bottom > visibleBottom) {
        return anchor.bottom - visibleBottom;
      }
      if (anchor.top < visibleTop) {
        return anchor.top - visibleTop;
      }
      return 0;
    }

    // Literal whole-row visibility is geometrically impossible. Keep the point that won
    // the long press inside the unobscured band so the reader retains the context they chose.
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
