import { Directive } from '@angular/core';
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
import { trn } from '@trinity/components/utils';

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
 * The styling is still the kit's: the three exported constants are imported, not copied, so
 * the tooltip looks identical and a `@spartan-ng/cli` re-sync cannot leave a stale duplicate.
 *
 * `hideDelay`, `showDelay` and `tooltipDisabled` are not published. Nothing binds them, and
 * their absence is what keeps the timing of a hover-revealed toolbar identical to today —
 * the e2e suite has 14 unhardened hover-then-click sites that a changed delay would turn
 * into interception flakes.
 */
@Directive({
  selector: '[trnTooltip]',
  providers: [
    provideBrnTooltipDefaultOptions({
      svgClasses: DEFAULT_TOOLTIP_SVG_CLASS,
      tooltipContentClasses: DEFAULT_TOOLTIP_CONTENT_CLASSES,
      arrowClasses: (position: BrnTooltipPosition) =>
        trn(tooltipPositionVariants({ position })),
    }),
  ],
  hostDirectives: [
    {
      directive: BrnTooltip,
      inputs: ['brnTooltip: trnTooltip', 'position'],
      outputs: [],
    },
  ],
})
export class TrnTooltip {}
