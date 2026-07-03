import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/**
 * The shared routed-page header shell. Renders exactly one native `<header>` and
 * exactly one `<h1>`, with two layouts selected by `variant`:
 *  - `page` (default): the standard settings / crypto / home header
 *    (`safe-top`, `min-h-14`, transparent, sits on the page's content surface).
 *  - `chat`: the rooms toolbar — tighter spacing, no `safe-top` (the rooms
 *    `.main` column already pads the safe-area top), and the chat background.
 *
 * Everything caller-specific is projected, so this shell imports nothing from
 * helm or the feature libs: consumers supply `hlmBtn` / `hlmTooltip` / `ng-icon`
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
 *   <button trnHeaderLeading hlmBtn variant="ghost" size="icon"
 *           hlmTooltip="Back" aria-label="Back" (click)="goBack()">
 *     <ng-icon name="lucideArrowLeft" />
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
  template: `
    <header [class]="headerClass()">
      <ng-content select="[trnHeaderLeading]" />
      <!-- The single, always-rendered page heading. Body is a plain string
           (title input) or fully projected (e.g. the rooms room-name title). -->
      <h1 [class]="titleClass()">
        @if (title(); as t) {
          {{ t }}
        } @else {
          <ng-content select="[trnHeaderTitle]" />
        }
      </h1>
      <ng-content select="[trnHeaderActions]" />
    </header>
  `,
})
export class PageHeaderComponent {
  /** Layout recipe: the standard page header, or the rooms chat toolbar. */
  readonly variant = input<'page' | 'chat'>('page');

  /** Plain-text title. Omit to project a complex title into `[trnHeaderTitle]`. */
  readonly title = input<string>();

  /** Host classes for the `<header>` — verbatim recipes, kept as full literal
   * strings so the Tailwind classes stay statically scannable. The chat recipe
   * sets the toolbar background and text color on the header (as the old scoped
   * `.chat-toolbar` rule did), so both the heading and the resting ghost icon
   * buttons — which have no color of their own — inherit `--trinity-text-bright`. */
  protected readonly headerClass = computed(() =>
    this.variant() === 'chat'
      ? 'flex h-14 shrink-0 items-center gap-1 border-b border-solid border-border px-2 bg-[var(--trinity-chat)] text-[var(--trinity-text-bright)]'
      : 'safe-top flex min-h-14 shrink-0 items-center gap-2 border-b border-solid border-border px-3',
  );

  /** Classes for the single `<h1>`. The chat recipe is a flex row so a `#`hash +
   * name + lock icon sit inline and truncate; its color is inherited from the
   * header (matching the pre-migration markup, where the h1 had no color class). */
  protected readonly titleClass = computed(() =>
    this.variant() === 'chat'
      ? 'flex min-w-0 flex-1 items-center gap-1 px-1 text-base font-semibold'
      : 'flex-1 truncate text-base font-semibold',
  );
}
