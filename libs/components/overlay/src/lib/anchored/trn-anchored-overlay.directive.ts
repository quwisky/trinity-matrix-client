import {
  Directive,
  DestroyRef,
  Injector,
  TemplateRef,
  ViewContainerRef,
  effect,
  inject,
  input,
  model,
  untracked,
} from '@angular/core';
import { Overlay, type OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import { createMenuPosition } from '@spartan-ng/brain/core';

/** Which side of the anchor the layer sits on. */
export type TrnAnchoredSide = 'top' | 'bottom' | 'left' | 'right';
/** Where along that side it lines up. */
export type TrnAnchoredAlign = 'start' | 'center' | 'end';

/**
 * A floating layer positioned against an element, rendered outside the DOM it belongs to.
 *
 * ## What this is for
 *
 * The alternative — and what the composer does today — is `position: absolute` inside the
 * thing the layer belongs to, which works right up until that thing has a
 * `overflow: hidden` ancestor, and then the layer is clipped by a box nobody was thinking
 * about. The composer's emoji picker, GIF grid and two suggestion menus are all pinned at
 * `bottom: calc(100% + 4px)` inside `.composer`, which is why `.composer` has to stay
 * `position: relative` and why the formatting toolbar has to live *inside* the composer just
 * to avoid being covered.
 *
 * Rendering into CDK's overlay container removes both constraints, and gives the layer the
 * two behaviours a floating thing needs and hand-rolled absolute positioning never has:
 * it flips to the other side rather than going off-screen, and it follows the anchor when an
 * ancestor scrolls.
 *
 * ## Why a template rather than a trigger
 *
 * CDK's own menus and this workspace's dropdown menu are TRIGGER-driven: a directive on a
 * button owns the open state. That is the wrong shape here — the composer's layers are opened
 * from four different places, their open state already lives in signals the component owns,
 * and one of them (a suggestion menu) has no trigger at all: it appears because of what was
 * typed. So `open` is a `model` the host drives, and the directive positions and renders.
 *
 * ## What it deliberately does not do
 *
 * **It does not take Escape.** A composer already has an Escape ladder — cancel the edit,
 * cancel the reply, close the picker, in that order — and a layer that swallowed the key
 * before that ladder ran would break it. Closing on Escape is the host's to decide, with the
 * context to decide it.
 *
 * **It has no backdrop.** A backdrop would steal the first click, which for a picker beside a
 * text field is usually the click that puts the caret back. An outside pointer press closes
 * it instead, and that click lands where it was aimed.
 *
 * **It is a z-index citizen, not a top-layer one.** `provideTrnOverlayDefaults()` turns off
 * CDK's `usePopover` app-wide so overlays stop covering the toaster, so this competes on
 * z-index like everything else. A layer that must sit above another overlay has to say so in
 * CSS; it will not be lifted for free.
 */
@Directive({
  selector: 'ng-template[trnAnchoredOverlay]',
})
export class TrnAnchoredOverlayDirective {
  private readonly overlay = inject(Overlay);
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly injector = inject(Injector);

  /** The element the layer is positioned against. */
  readonly anchor = input.required<HTMLElement | undefined>({
    alias: 'trnAnchoredOverlay',
  });

  /**
   * Whether the layer is showing.
   *
   * A `model`, so the directive can close it: an outside press has to be able to put the
   * host's own signal back, or the host would render an open layer that is no longer there.
   */
  readonly open = model(false);

  readonly side = input<TrnAnchoredSide>('top');
  readonly align = input<TrnAnchoredAlign>('end');

  /**
   * Make the layer exactly as wide as its anchor.
   *
   * For a suggestion list that stands in for the field it completes, which reads as part of
   * the field rather than as a popover beside it. Off by default: a picker has its own
   * width and stretching it to the composer would be wrong.
   */
  readonly matchAnchorWidth = input(false);

  private ref: OverlayRef | null = null;

  constructor() {
    effect(() => {
      const open = this.open();
      const anchor = this.anchor();
      const side = this.side();
      const align = this.align();
      const matchWidth = this.matchAnchorWidth();
      untracked(() => {
        this.close();
        if (open && anchor) {
          this.attach(anchor, side, align, matchWidth);
        }
      });
    });
    inject(DestroyRef).onDestroy(() => this.close());
  }

  private attach(
    anchor: HTMLElement,
    side: TrnAnchoredSide,
    align: TrnAnchoredAlign,
    matchWidth: boolean,
  ): void {
    const ref = this.overlay.create({
      // `createMenuPosition` rather than a hand-rolled ConnectedPosition[]: it returns the
      // primary position AND its mirror, which is what makes a layer near the viewport edge
      // flip to the other side instead of being pushed half off it. The kit's dropdown menu
      // positions itself with the same helper.
      positionStrategy: this.overlay
        .position()
        .flexibleConnectedTo(anchor)
        .withPositions(createMenuPosition(align, side))
        .withViewportMargin(8),
      // Reposition, not close: an ancestor scrolling is not a decision to dismiss, and the
      // composer's layers sit above a timeline that scrolls constantly.
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      ...(matchWidth ? { width: anchor.getBoundingClientRect().width } : {}),
    });
    ref.attach(
      new TemplatePortal(
        this.template,
        this.viewContainer,
        undefined,
        this.injector,
      ),
    );
    // `outsidePointerEvents`, not a backdrop — see the class note. Written back through the
    // model so the host's own signal agrees with what is on screen.
    ref
      .outsidePointerEvents()
      .subscribe(() => untracked(() => this.open.set(false)));
    this.ref = ref;
  }

  private close(): void {
    this.ref?.dispose();
    this.ref = null;
  }
}
