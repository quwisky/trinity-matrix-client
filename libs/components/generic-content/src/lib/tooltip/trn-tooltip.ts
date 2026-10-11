import { Directive, ElementRef, inject } from '@angular/core';
import {
  BrnTooltip,
  type BrnTooltipPosition,
  provideBrnTooltipDefaultOptions,
} from '@spartan-ng/brain/tooltip';
import {
  DEFAULT_TOOLTIP_CONTENT_CLASSES,
  DEFAULT_TOOLTIP_SVG_CLASS,
  tooltipPositionVariants,
} from '@trinity/helm/tooltip';
import { hlm as trn } from '@trinity/helm/utils';

/**
 * Trinity owns tooltip colour semantics while Helm continues to own geometry and motion.
 * `trn()` removes the kit's conflicting foreground/background utilities, so this remains a
 * composition rather than a copied class list that could drift after a Spartan update.
 */
export const TRN_TOOLTIP_SVG_CLASSES = trn(
  DEFAULT_TOOLTIP_SVG_CLASS,
  'bg-tooltip fill-tooltip',
);
export const TRN_TOOLTIP_CONTENT_CLASSES = trn(
  DEFAULT_TOOLTIP_CONTENT_CLASSES,
  'bg-tooltip text-tooltip-foreground',
);

/**
 * Trinity's tooltip.
 *
 * An attribute directive, and it has to be: it decorates whatever is already there. 29 of the
 * 30 call sites put it on a `<button>` — usually one that also carries `trnButton` and
 * sometimes a dropdown trigger — and one puts it on a `<trn-icon>`. An element wrapper cannot
 * be applied to a component that already exists.
 *
 * **This one composes brain directly rather than the kit directive, which the others do not.**
 * The message input is published by the kit as `hlmTooltip`, and renaming it to `trnTooltip`
 * would mean re-declaring it in this wrapper's `hostDirectives` entry — which throws
 * `NG0311`, because publication chains down to the element but does not make the input
 * re-declarable one level up (the label wrapper proved that). Composing `BrnTooltip` here
 * publishes the name we want in one step.
 *
 * Geometry and motion still come from the kit's imported constants rather than a copied class
 * list, so a `@spartan-ng/cli` re-sync cannot leave a stale duplicate. Trinity's public wrapper
 * then replaces only the colour utilities with its semantic tooltip surface pair.
 *
 * `hideDelay`, `showDelay` and `tooltipDisabled` are not published. Nothing binds them, and
 * their absence is what keeps the timing of a hover-revealed toolbar identical to today —
 * the e2e suite has 14 unhardened hover-then-click sites that a changed delay would turn
 * into interception flakes.
 *
 * That timing is pinned here because Brain 1.5 changed its own defaults from 150/100 to 0/0.
 * Nearly every call site labels an icon-only button in a dense, hover-revealed toolbar; at 0
 * a pointer crossing the row opens a tooltip over the neighbouring action on every pass.
 *
 * **Focus opens a tooltip only when the browser would draw a focus ring (`:focus-visible`).**
 * Our Brain patch ignores touch focus, and programmatic focus while the last input was a touch
 * (until the next key or mouse press). WebKit doesn't focus a tapped button, so focus restored
 * after a tap otherwise reaches Brain as programmatic and matches `:focus-visible`; this was
 * seen in Playwright on macOS WebKit (#1216). Any other programmatic focus is keyboard intent
 * to Brain, so focus restored to a trigger after a sheet or dialog closed could open a tooltip
 * that stayed until the next interaction. Brain has no hook to filter focus and its `delay`
 * method is private, so a focus without a ring switches the tooltip off through the public
 * `mutableTooltipDisabled` signal; Brain checks it when the show delay elapses. Blur or a
 * mouse or pen entering switches it back on, and a focus that lands while one is over the host
 * (hover, then click within the show delay) is left alone, so hover is unaffected and Tab
 * focus is evaluated anew.
 *
 * Known gap: after a dialog close Brain marks the restored focus as visible, so a later hover
 * opens the tooltip and it outlives `pointerleave`. Closing it needs Brain's private `delay`,
 * which this wrapper deliberately does not reach into.
 */
@Directive({
  selector: '[trnTooltip]',
  providers: [
    provideBrnTooltipDefaultOptions({
      showDelay: 150,
      hideDelay: 100,
      svgClasses: TRN_TOOLTIP_SVG_CLASSES,
      tooltipContentClasses: TRN_TOOLTIP_CONTENT_CLASSES,
      arrowClasses: (position: BrnTooltipPosition) =>
        trn(tooltipPositionVariants({ position })),
    }),
  ],
  host: {
    '(focusin)': 'suppressUnlessFocusVisible()',
    '(focusout)': 'restore()',
    '(pointerenter)': 'hoverStart($event)',
    '(pointerleave)': 'hoverEnd($event)',
  },
  hostDirectives: [
    {
      directive: BrnTooltip,
      inputs: ['brnTooltip: trnTooltip', 'position'],
      outputs: [],
    },
  ],
})
export class TrnTooltip {
  private hovered = false;
  private readonly tooltip = inject(BrnTooltip, { self: true });
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected suppressUnlessFocusVisible(): void {
    if (!this.hovered) {
      this.tooltip.mutableTooltipDisabled.set(!this.isFocusVisible());
    }
  }

  protected hoverStart(event: PointerEvent): void {
    if (isHoverPointer(event)) {
      this.hovered = true;
      this.restore();
    }
  }

  protected hoverEnd(event: PointerEvent): void {
    if (isHoverPointer(event)) {
      this.hovered = false;
    }
  }

  protected restore(): void {
    this.tooltip.mutableTooltipDisabled.set(false);
  }

  private isFocusVisible(): boolean {
    try {
      return this.host.matches(':focus-visible');
    } catch {
      // An engine without the selector cannot tell; keep Brain's behaviour.
      return true;
    }
  }
}

function isHoverPointer(event: PointerEvent): boolean {
  return event.pointerType === 'mouse' || event.pointerType === 'pen';
}
