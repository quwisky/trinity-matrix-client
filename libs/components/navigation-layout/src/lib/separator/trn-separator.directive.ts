import { Directive } from '@angular/core';
import { HlmSeparator } from '@trinity/helm/separator';

/**
 * A rule between groups of controls.
 *
 * A directive rather than an element, because the thing it separates is usually a flex or
 * grid child and an extra wrapper would land in that layout. Composed by `hostDirectives`,
 * which is available here precisely because the kit ships a directive rather than a
 * component — the checkbox wrapper next door has to compose by template for want of that.
 *
 * Nothing is listed for re-publication, and `orientation`/`decorative` are still bindable on
 * the host: Angular re-publishes a host directive's inputs one level only, so naming them
 * here throws NG0311 — HlmSeparator does not declare them, it publishes them from BrnSeparator
 * onto this same element, which is exactly where a call site binds them.
 *
 * `decorative` is the interesting one, and its default is upstream's: `true`, so a rule is
 * silent unless asked otherwise and `role` reads `none`. That is right for the common case —
 * most rules are drawn to look like something, not to say something — and it means a caller
 * who wants the rule announced has to say `[decorative]="false"` and think about why. Left
 * where upstream put it rather than inverted here, so a regenerate does not quietly change
 * what every existing call site means.
 */
@Directive({
  selector: '[trnSeparator]',
  hostDirectives: [{ directive: HlmSeparator, inputs: [], outputs: [] }],
})
export class TrnSeparatorDirective {}
