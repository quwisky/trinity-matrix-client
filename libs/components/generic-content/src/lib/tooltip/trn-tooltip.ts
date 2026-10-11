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
 * Brain already ignores touch taps, but it treats every programmatic focus as keyboard
 * intent, so focus restored to a trigger after a touch-closed sheet or dialog opened a tooltip
 * that stayed until the next interaction. Brain has no hook to filter focus and its `delay`
 * method is private, so a focus without a ring switches the tooltip off through the public
 * `mutableTooltipDisabled` signal; Brain checks it when the show delay elapses. Blur or a
 * pointer entering switches it back on, so hover is unaffected and Tab focus is evaluated anew.
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
    '(pointerenter)': 'restore()',
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
  private readonly tooltip = inject(BrnTooltip, { self: true });
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected suppressUnlessFocusVisible(): void {
    this.tooltip.mutableTooltipDisabled.set(!this.isFocusVisible());
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
