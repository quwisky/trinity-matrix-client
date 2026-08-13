import { Directive } from '@angular/core';
import { HlmTextarea } from '@trinity/helm/textarea';

/**
 * Trinity's multi-line input.
 *
 * Two call sites, both of the awkward kind an element wrapper would break: one is read from
 * TypeScript through a template reference (`#ta`) as a real `HTMLTextAreaElement`, and both
 * bind a spread of native attributes and eight event handlers. So: an attribute directive.
 *
 * `aria-describedby` needs no re-publishing here for the same reason as {@link TrnInput} —
 * the kit's entry publishes it and that reaches this element.
 */
@Directive({
  selector: '[trnTextarea]',
  hostDirectives: [{ directive: HlmTextarea, inputs: [], outputs: [] }],
})
export class TrnTextarea {}
