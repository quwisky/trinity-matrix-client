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
import type {
  TrnOverlayAlign,
  TrnOverlaySide,
} from '../position/trn-overlay-position';

/** Which side of the anchor the layer sits on. */
export type TrnAnchoredSide = TrnOverlaySide;
/** Where along that side it lines up. */
export type TrnAnchoredAlign = TrnOverlayAlign;

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
 * **It labels nothing.** No `role` on the layer, and nothing is written to the anchor's
 * `aria-expanded` or `aria-controls`. A picker, a listbox and a menu want three different
 * roles, and the composer's suggestion menus already manage `aria-controls` and
 * `aria-activedescendant` against their textarea — a primitive guessing here would have to be
 * argued with. Naming the layer and announcing its expanded state belong to the host.
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

  /**
   * The element the layer is positioned against.
   *
   * Required AND `| undefined`, which reads as a contradiction and is not one: the binding
   * has to be given, but the usual thing to give it is a `#ref` on a sibling element, and a
   * template reference is undefined on the pass that creates it. Nothing opens until it
   * resolves, which is the honest behaviour rather than a crash on the first render.
   */
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

  /**
   * Whether a press outside the layer closes it.
   *
   * On for the layers a person opens and closes — a picker, a menu. Off for one whose
   * openness is DERIVED: the composer's suggestion menus are open exactly when the current
   * query has matches (`computed(() => this.matches().length > 0)`), so there is no flag for
   * the write-back to land in. Bound one-way against a computed, a self-closing layer
   * disappears while its host still believes it is showing — and the host is the one
   * answering Enter and pointing `aria-activedescendant` at a row nobody can see.
   */
  readonly closeOnOutsidePress = input(true);

  private ref: OverlayRef | null = null;

  constructor() {
    // WHETHER there is a layer, and what it is anchored to. Only these two re-create it,
    // because re-creating destroys the view inside — an emoji picker would lose the text
    // typed into its search field and the focus that was in it.
    effect(() => {
      const open = this.open();
      const anchor = this.anchor();
      untracked(() => {
        this.close();
        if (open && anchor) {
          this.attach(anchor);
        }
      });
    });

    // WHERE it sits, which is a different question and is answered in place. A `side` that
    // flips with the viewport, or a `matchAnchorWidth` that comes from a signal, moves the
    // layer rather than replacing it.
    effect(() => {
      this.side();
      this.align();
      this.matchAnchorWidth();
      untracked(() => this.reposition());
    });

    inject(DestroyRef).onDestroy(() => this.close());
  }

  private attach(anchor: HTMLElement): void {
    const ref = this.overlay.create({
      // `createMenuPosition` rather than a hand-rolled ConnectedPosition[]: it returns the
      // primary position AND its mirror, which is what makes a layer near the viewport edge
      // flip to the other side instead of being pushed half off it. The kit's dropdown menu
      // positions itself with the same helper.
      positionStrategy: this.positionStrategy(anchor),
      // Reposition, not close: an ancestor scrolling is not a decision to dismiss, and the
      // composer's layers sit above a timeline that scrolls constantly.
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      ...(this.matchAnchorWidth()
        ? { width: anchor.getBoundingClientRect().width }
        : {}),
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
    ref.outsidePointerEvents().subscribe((event) => {
      if (!this.closeOnOutsidePress()) {
        return;
      }
      // A press on the ANCHOR is not an outside press, whatever CDK thinks. The anchor is
      // where a trigger for this layer lives — the composer's emoji button sits in the row the
      // picker is anchored to — and closing here would race that button's own click handler:
      // one of them wins, and the layer either reopens immediately or ends up gone while its
      // trigger still says `aria-expanded="true"`. CDK's own overlay triggers exclude their
      // origin for the same reason.
      const target = event.target;
      if (target instanceof Node && anchor.contains(target)) {
        return;
      }
      this.open.set(false);
    });
    this.ref = ref;
    this.followResizes(ref, anchor);
  }

  /**
   * Keep the layer with its anchor when the anchor changes SHAPE.
   *
   * CDK recomputes a connected position on scroll and on nothing else — there is no observer
   * on the origin — and `width` is read once into the config. So an anchor that grows in
   * place takes the layer with it in neither respect, and absolute positioning, which this
   * replaces, tracked both for free. It is not hypothetical for the first consumer: the
   * composer's textarea auto-grows as you type, so a suggestion menu above it comes unstuck
   * the moment the input wraps to a second line — measured at 162px of overlap — and a pane
   * drag changes its width under an already-open layer.
   */
  private followResizes(ref: OverlayRef, anchor: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const watcher = new ResizeObserver(() => this.remeasure());
    watcher.observe(anchor);
    ref.detachments().subscribe(() => watcher.disconnect());
  }

  /**
   * The anchor moved or changed size: re-read it and re-run the position we already have.
   *
   * Separate from {@link reposition} because this one is on a hot path — a pane drag fires
   * the observer at animation frequency — and `updatePositionStrategy` disposes and rebuilds
   * the strategy each time, where `updatePosition` reuses it.
   */
  private remeasure(): void {
    const ref = this.ref;
    const anchor = this.anchor();
    if (!ref || !anchor) {
      return;
    }
    // Both directions, not just the setting one: `updateSize` is the only thing that clears
    // a width CDK has already been given, so skipping the call when matching is off would
    // leave a layer pinned at whatever the anchor measured last — the setting turns off and
    // nothing happens.
    ref.updateSize({
      width: this.matchAnchorWidth()
        ? anchor.getBoundingClientRect().width
        : undefined,
    });
    ref.updatePosition();
  }

  /**
   * The requested side or alignment changed: swap the strategy, keeping the layer.
   *
   * Rare — a responsive `side`, or a `matchAnchorWidth` driven by a signal — so the cost of
   * rebuilding the strategy is the right trade against re-creating the view inside.
   */
  private reposition(): void {
    const anchor = this.anchor();
    if (!this.ref || !anchor) {
      return;
    }
    this.ref.updatePositionStrategy(this.positionStrategy(anchor));
    this.remeasure();
  }

  private positionStrategy(anchor: HTMLElement) {
    return this.overlay
      .position()
      .flexibleConnectedTo(anchor)
      .withPositions(createMenuPosition(this.align(), this.side()))
      .withViewportMargin(8);
  }

  private close(): void {
    this.ref?.dispose();
    this.ref = null;
  }
}
