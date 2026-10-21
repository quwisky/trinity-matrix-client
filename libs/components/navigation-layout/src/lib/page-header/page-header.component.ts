import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  trnPageHeaderRecipe,
  trnPageHeaderTitleRecipe,
  type TrnPageHeaderLayout,
  type TrnPageHeaderVariant,
} from './trn-page-header-recipe';

export type {
  TrnPageHeaderLayout,
  TrnPageHeaderVariant,
} from './trn-page-header-recipe';

/**
 * The shared routed-page header shell. Renders exactly one native `<header>` and one `<h1>`.
 *  - `layout="page"` (default): the standard settings / crypto / home header (`min-h-14`,
 *    page spacing).
 *  - `layout="toolbar"`: tighter spacing.
 *  Neither pads the top safe area: the application frame does, above every routed page.
 *  - `variant="neutral|accent"`: the surface treatment, independent of geometry.
 *
 * Everything caller-specific is projected, so this shell imports nothing from helm or the
 * feature libs; projected nodes keep their origin component's style encapsulation.
 *
 * The `<h1>` is always rendered by the shell (the `title` string, else the `[trnHeaderTitle]`
 * slot), so a page never ends up with a heading nested inside another heading. Projected title
 * content must stay heading-free (inline spans and icons only).
 *
 * ```html
 * <trn-page-header title="Settings">
 *   <button trnHeaderLeading trnBtn variant="primary" presentation="ghost"
 *           shape="icon" size="md"
 *           trnTooltip="Back" aria-label="Back" (click)="goBack()">
 *     <trn-icon name="arrow-left" />
 *   </button>
 * </trn-page-header>
 * ```
 */
@Component({
  selector: 'trn-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // display:contents: the rendered <header> is the real flex child of the page column.
  host: { class: 'contents' },
  templateUrl: './page-header.component.html',
})
export class PageHeaderComponent {
  /** Semantic treatment. */
  readonly variant = input<TrnPageHeaderVariant>('neutral');

  /** Standard routed-page geometry or compact toolbar geometry. */
  readonly layout = input<TrnPageHeaderLayout>('page');

  /** Plain-text title. Omit to project a complex title into `[trnHeaderTitle]`. */
  readonly title = input<string>();

  /** The recipe targets the rendered native header, not the box-less host. */
  protected readonly headerClass = computed(() =>
    trnPageHeaderRecipe(this.variant(), this.layout()),
  );

  /**
   * The accent variant paints the attention surface in both layouts (its fill outranks the
   * toolbar background), so it declares that context: `trnBtn` reads
   * `data-trn-surface="attention"` and inverts its solid fill, which would match the header.
   */
  protected readonly surface = computed(() =>
    this.variant() === 'accent' ? 'attention' : null,
  );

  /** Classes for the single `<h1>`; the toolbar recipe is a flex row that truncates the title. */
  protected readonly titleClass = computed(() =>
    trnPageHeaderTitleRecipe(this.layout()),
  );
}
