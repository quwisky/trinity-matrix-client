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
 * The shared routed-page header shell. Renders exactly one native `<header>` and
 * exactly one `<h1>`. Semantic treatment and structure are separate axes:
 *  - `layout="page"` (default): the standard settings / crypto / home header
 *    (`safe-top`, `min-h-14`, and page spacing).
 *  - `layout="toolbar"`: tighter spacing and no `safe-top` (the rooms
 *    `.main` column already pads the safe-area top).
 *  - `variant="neutral|accent"`: the semantic surface treatment independent
 *    of that geometry.
 *
 * Everything caller-specific is projected, so this shell imports nothing from
 * helm or the feature libs: consumers supply `hlmBtn` / `trnTooltip` / `<trn-icon>`
 * in the projected content, and projected nodes keep their origin component's
 * style encapsulation (so e.g. rooms' scoped `.title-hash` / `.title-lock` still
 * apply to a projected title).
 *
 * The `<h1>` is always rendered by the shell — its body is the `title` string
 * when provided, else the `[trnHeaderTitle]` slot — so a page never ends up with
 * a heading nested inside another heading. Projected title content must stay
 * heading-free (inline spans + icons only).
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
  // display:contents => the rendered <header> is the real flex child of the page
  // column; the trn-page-header host adds no box of its own.
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

  /** Classes for the single `<h1>`. The toolbar recipe is a flex row so a `#`hash +
   * name + lock icon sit inline and truncate; its color is inherited from the
   * header (matching the pre-migration markup, where the h1 had no color class). */
  protected readonly titleClass = computed(() =>
    trnPageHeaderTitleRecipe(this.layout()),
  );
}
