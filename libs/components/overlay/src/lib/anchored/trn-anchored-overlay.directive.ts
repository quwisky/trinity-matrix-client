import {
  Directive,
  DOCUMENT,
  DestroyRef,
  Injector,
  TemplateRef,
  ViewContainerRef,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
  type EmbeddedViewRef,
} from '@angular/core';
import { Overlay, type OverlayRef } from '@angular/cdk/overlay';
import { DomPortal, TemplatePortal, type Portal } from '@angular/cdk/portal';
import { createMenuPosition } from '@spartan-ng/brain/core';
import type {
  TrnOverlayAlign,
  TrnOverlaySide,
} from '../position/trn-overlay-position';

/** Which side of the anchor the layer sits on. */
export type TrnAnchoredSide = TrnOverlaySide;
/** Where along that side it lines up. */
export type TrnAnchoredAlign = TrnOverlayAlign;

/** The longest delay `setTimeout` honours; a longer one fires almost at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A floating layer positioned against an element, rendered into CDK's overlay container so no
 * `overflow: hidden` ancestor clips it. It flips at the viewport edge and follows the anchor
 * when an ancestor scrolls.
 *
 * The host owns the open state through `open`, because a layer may have no trigger at all (a
 * suggestion menu opens because of what was typed). What it deliberately leaves to the host:
 *
 * - **Escape.** The host's own Escape ladder (cancel edit, cancel reply, close picker) must run
 *   first, so the layer never swallows the key.
 * - **Backdrop.** There is none: it would steal the click that puts the caret back in the text
 *   field. An outside pointer press closes the layer instead.
 * - **Labelling.** No `role`, and nothing written to the anchor's `aria-expanded` or
 *   `aria-controls`: a picker, a listbox and a menu need different roles, and the host already
 *   manages `aria-controls` and `aria-activedescendant` against its field.
 * - **Stacking.** It competes on z-index, not in the top layer, because
 *   `provideTrnOverlayDefaults()` turns off CDK's `usePopover` so overlays stop covering the
 *   toaster. A layer that must sit above another overlay has to say so in CSS.
 */
@Directive({
  selector: 'ng-template[trnAnchoredOverlay]',
})
export class TrnAnchoredOverlayDirective {
  private readonly overlay = inject(Overlay);
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  /**
   * The element the layer is positioned against.
   *
   * Required AND `| undefined`: the binding must be given, but a `#ref` on a sibling is
   * undefined on the pass that creates it. Nothing opens until it resolves.
   */
  readonly anchor = input.required<HTMLElement | undefined>({
    alias: 'trnAnchoredOverlay',
  });

  /**
   * Whether the layer is showing.
   *
   * A `model`, so an outside press can write the close back to the host's own signal.
   */
  readonly open = model(false);

  readonly side = input<TrnAnchoredSide>('top');
  readonly align = input<TrnAnchoredAlign>('end');

  /**
   * Make the layer exactly as wide as its anchor, for a list that stands in for the field it
   * completes. Off by default: a picker keeps its own width.
   */
  readonly matchAnchorWidth = input(false);

  /**
   * Whether a press outside the layer closes it.
   *
   * Turn it off for a layer whose openness is DERIVED (a `computed`): the write-back has no
   * flag to land in, so the layer would disappear while the host still believes it is showing
   * and answers Enter against a row nobody can see.
   */
  readonly closeOnOutsidePress = input(true);

  /**
   * How long, in milliseconds, to keep the layer's view alive after it closes; 0 rebuilds it
   * on every open.
   *
   * For a large layer that is reopened often. Closed, the kept view is parked outside the
   * document with change detection paused, but it still holds its memory, so it is released
   * once it has stayed closed this long.
   *
   * State carries over a reopen within the window (a search, a tab), which would be wrong for
   * a layer that must start fresh, so it is off by default. Scroll position does not carry
   * over (a scroll container taken out of the document restarts at the top), and work the
   * content does once at creation does not run again: content that needs it on every open
   * reads {@link shown}.
   *
   * Zero, negative or non-numeric means off; anything past what `setTimeout` can wait (about
   * 24 days) waits that long. Turning it off while a view is kept releases that view.
   */
  readonly retainFor = input(0);

  /**
   * Whose layer this is, for a kept view: when it changes, the kept view is released (at once
   * if the layer is closed, else when it closes), so the next open builds a fresh one. The
   * composer passes its account, so a search typed under one account never shows, or is sent
   * to a provider, under the next.
   */
  readonly retainKey = input<unknown>(undefined);

  private readonly shownCount = signal(0);
  /**
   * How many times the layer has been shown, counting the first. A kept view is not created
   * again on a reopen, so content that must act on every open reacts to this changing. Content
   * can inject the directive: it is the template's own.
   */
  readonly shown = this.shownCount.asReadonly();

  private ref: OverlayRef | null = null;
  /** The kept view and the element its nodes live in, parked in a fragment while closed. */
  private retained: {
    readonly view: EmbeddedViewRef<unknown>;
    readonly holder: HTMLElement;
  } | null = null;
  /** Pending release of the kept view, armed when the layer closes. */
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** {@link retainKey} changed while the layer was open: release the view when it closes. */
  private releaseOnClose = false;

  constructor() {
    // Only whether there is a layer, and what it is anchored to, re-create it: re-creating
    // destroys the view inside, and an emoji picker would lose its search text and focus.
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

    // Where it sits is answered in place: a flipping `side` or a signal-driven
    // `matchAnchorWidth` moves the layer rather than replacing it.
    effect(() => {
      this.side();
      this.align();
      this.matchAnchorWidth();
      untracked(() => this.reposition());
    });

    // Retention turned off, or the layer changing hands, while a view is kept.
    effect(() => {
      const off = this.retainMs() === 0;
      untracked(() => {
        if (off) {
          this.releaseIfClosed();
        }
      });
    });
    let firstKey = true;
    effect(() => {
      this.retainKey();
      untracked(() => {
        if (firstKey) {
          firstKey = false;
          return;
        }
        this.releaseIfClosed();
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.close();
      this.release();
    });
  }

  private attach(anchor: HTMLElement): void {
    const ref = this.overlay.create({
      // `createMenuPosition` returns the primary position AND its mirror, so a layer near the
      // viewport edge flips to the other side instead of being pushed half off it.
      positionStrategy: this.positionStrategy(anchor),
      // Reposition, not close: an ancestor scrolling is not a decision to dismiss.
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      ...(this.matchAnchorWidth()
        ? { width: anchor.getBoundingClientRect().width }
        : {}),
    });
    this.shownCount.update((count) => count + 1);
    ref.attach(this.portal());
    // No backdrop (see the class note). Written back through the model so the host's signal
    // agrees with what is on screen.
    ref.outsidePointerEvents().subscribe((event) => {
      if (!this.closeOnOutsidePress()) {
        return;
      }
      // A press on the ANCHOR is not an outside press. A trigger for this layer usually lives
      // there, and closing here would race that trigger's own click handler: the layer either
      // reopens at once or ends up gone while the trigger still says `aria-expanded="true"`.
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
  /**
   * Keep the layer with its anchor when the anchor changes SHAPE.
   *
   * CDK recomputes a connected position only on scroll, and reads `width` once into the
   * config, so an anchor that grows in place (an auto-growing textarea, a pane drag) would
   * leave the layer behind.
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
  /**
   * The anchor moved or changed size: re-read it and re-run the position we already have.
   *
   * Separate from {@link reposition} because this is a hot path (a pane drag fires the
   * observer at animation frequency) and `updatePositionStrategy` rebuilds the strategy where
   * `updatePosition` reuses it.
   */
  private remeasure(): void {
    const ref = this.ref;
    const anchor = this.anchor();
    if (!ref || !anchor) {
      return;
    }
    // Both directions: `updateSize` is the only thing that clears a width CDK was given, so
    // skipping it when matching is off would leave the layer pinned at the last measured width.
    ref.updateSize({
      width: this.matchAnchorWidth()
        ? anchor.getBoundingClientRect().width
        : undefined,
    });
    ref.updatePosition();
  }

  /**
  /**
   * The requested side or alignment changed: swap the strategy, keeping the layer. Rare, so
   * rebuilding the strategy beats re-creating the view inside.
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

  /** The layer's content: rebuilt each time, or the kept view while {@link retainFor} allows. */
  private portal(): Portal<unknown> {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (this.retainMs() === 0) {
      return new TemplatePortal(
        this.template,
        this.viewContainer,
        undefined,
        this.injector,
      );
    }
    if (!this.retained) {
      const view = this.viewContainer.createEmbeddedView(
        this.template,
        undefined,
        { injector: this.injector },
      );
      // The holder lays out as if the view's nodes were the pane's own children. It is parked
      // in a fragment so a DomPortal has a place to return it to when the pane goes away.
      const holder = this.document.createElement('div');
      holder.style.display = 'contents';
      this.document.createDocumentFragment().append(holder);
      holder.append(...view.rootNodes);
      this.retained = { view, holder };
    } else {
      this.retained.view.reattach();
    }
    return new DomPortal(this.retained.holder);
  }

  private close(): void {
    this.ref?.dispose();
    this.ref = null;
    if (!this.retained) {
      return;
    }
    if (this.releaseOnClose || this.retainMs() === 0) {
      this.release();
      return;
    }
    // Disposing returned the holder to its fragment; nothing in it needs checking until the
    // next open, and nothing in it is kept once it has stayed closed long enough.
    this.retained.view.detach();
    if (this.releaseTimer === null) {
      this.releaseTimer = setTimeout(() => this.release(), this.retainMs());
    }
  }

  /** {@link retainFor} as a delay `setTimeout` keeps; 0 when retention is off. */
  private retainMs(): number {
    const ms = this.retainFor();
    // `!(ms > 0)` rather than `ms <= 0`, so NaN is off too.
    return !(ms > 0) ? 0 : Math.min(ms, MAX_TIMEOUT_MS);
  }

  /** Release the kept view now if the layer is closed, else once it closes. */
  private releaseIfClosed(): void {
    if (!this.retained) {
      return;
    }
    if (this.ref) {
      this.releaseOnClose = true;
    } else {
      this.release();
    }
  }

  /** Destroy the kept view, if any; the next open builds a fresh one. */
  private release(): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.releaseOnClose = false;
    this.retained?.view.destroy();
    this.retained = null;
  }
}
