import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  TrnIconComponent,
  type TrnIconName,
  type TrnVariant,
} from '@trinity/components/foundations';

export type TrnEmptyStateVariant = Extract<TrnVariant, 'muted' | 'danger'>;
export type TrnEmptyStateLayout = 'panel' | 'line' | 'hero';

/**
 * The "there is nothing here" panel: an optional icon, a line or two of text, and somewhere to
 * put the action that would fix it.
 *
 * {@link title} and {@link body} are both optional and either may stand alone. Projected content
 * wins over `body` (a call site needs markup, such as a spinner, in the same place).
 *
 * It brings no list semantics: inside a `<ul>` the `<li>` stays at the call site and this goes
 * inside it. Attributes written on the element reach the DOM (`data-testid`, `aria-live`).
 *
 * @example
 * ```html
 * <trn-empty-state
 *   icon="message-square"
 *   title="No threads yet"
 *   body="Reply in a thread to start one."
 *   data-testid="threads-empty"
 * >
 *   <button trnEmptyStateActions trnBtn size="sm">Start one</button>
 * </trn-empty-state>
 * ```
 */
@Component({
  selector: 'trn-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Block host: an inline host silently drops its padding unless the parent is flex or grid.
  host: { class: 'block' },
  imports: [TrnIconComponent],
  templateUrl: './empty-state.component.html',
})
export class EmptyStateComponent {
  /** An icon above the text. Omit it where the panel is a single quiet sentence. */
  readonly icon = input<TrnIconName>();

  /** The heading. Optional — plenty of these are a body line with nothing over it. */
  readonly title = input<string>();

  /** The explanation. Ignored when content is projected into the default slot. */
  readonly body = input<string>();

  /** How the text reads. `danger` is for a failure rather than an absence. */
  readonly variant = input<TrnEmptyStateVariant>('muted');

  /**
   * How much room it takes: `panel` is a centred 24px panel, `line` a compact 8px line inside a
   * list or sidebar, `hero` the sole content of a pane.
   */
  readonly layout = input<TrnEmptyStateLayout>('panel');

  /**
   * A short glyph in a circle above the text (`#` for a room, an initial for a person).
   *
   * Its own input rather than {@link icon}: it is a literal glyph, not a registry icon.
   */
  readonly badge = input<string>();

  /**
   * What element the title is. `p` by default; the hero uses `h2` because `trn-page-header` owns
   * the page's single `<h1>`.
   */
  readonly titleAs = input<'p' | 'h2'>('p');

  /**
   * Whole class strings, never a static `class` beside a `[class]` binding, and full literals
   * so Tailwind can scan them statically.
   *
   * `empty:hidden` is load-bearing: with neither `body` set nor content projected, the paragraph
   * would still contribute a line box under the heading.
   *
   * `text-danger`, never `text-destructive`: the latter is a fill/tint token whose dark value is
   * a near-black maroon, which makes an error unreadable as a foreground in the dark theme.
   */
  protected readonly bodyClass = computed(() =>
    this.variant() === 'danger'
      ? 'text-13 text-balance wrap-anywhere text-danger empty:hidden'
      : 'text-13 text-balance wrap-anywhere text-muted-foreground empty:hidden',
  );

  /** The outer column's own padding, which is the whole of what {@link layout} decides. */
  protected readonly layoutClass = computed(() => {
    switch (this.layout()) {
      case 'line':
        return 'flex flex-col items-center gap-1 px-2 py-2 text-center';
      case 'hero':
        // Does NOT centre itself in the pane; that is the container's job.
        return 'mx-auto flex max-w-[420px] flex-col items-center gap-2 px-6 py-6 text-center';
      default:
        return 'flex flex-col items-center gap-2 px-4 py-6 text-center';
    }
  });

  /** The title's type. A hero's is the pane's own headline; the rest are a label. */
  protected readonly titleClass = computed(() =>
    this.layout() === 'hero'
      ? 'text-[22px] font-bold text-balance text-foreground'
      : 'text-sm font-semibold text-balance text-foreground',
  );

  /** `empty:hidden` so a panel with no action contributes neither the row nor its margin. */
  protected readonly actionsClass =
    'empty-state__actions mt-1 flex items-center gap-2 empty:hidden';
}
