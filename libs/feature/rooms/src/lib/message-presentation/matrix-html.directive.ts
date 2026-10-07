import { Directive, input } from '@angular/core';
import { InlineMxcImagesDirective } from '../inline-mxc-images/inline-mxc-images.directive';
import { MatrixLinkDirective } from '../matrix-link/matrix-link.directive';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import { CodeHighlightDirective } from './code-highlight.directive';

/**
 * Renders a sanitized Matrix message body into its host element.
 *
 * Spoiler reveal, `matrix.to` link routing, inline custom emoji and code highlighting all
 * delegate from the container that holds the body, so they travel with it: bind
 * `[trnMatrixHtml]` on that element and handle `(matrixLink)` where permalinks are routed.
 */
@Directive({
  selector: '[trnMatrixHtml]',
  hostDirectives: [
    { directive: SpoilerRevealDirective, inputs: [], outputs: [] },
    { directive: MatrixLinkDirective, inputs: [], outputs: ['matrixLink'] },
    {
      directive: InlineMxcImagesDirective,
      inputs: ['trnInlineMxcImages: trnMatrixHtml'],
      outputs: [],
    },
    {
      directive: CodeHighlightDirective,
      inputs: ['trnCodeHighlight: trnMatrixHtml'],
      outputs: [],
    },
  ],
  host: { '[innerHTML]': 'html()' },
})
export class MatrixHtmlDirective {
  readonly html = input.required<string>({ alias: 'trnMatrixHtml' });
}
