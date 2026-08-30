import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';

/**
 * The "there is nothing here" panel: an optional icon, a line or two of text, and somewhere to
 * put the action that would fix it.
 *
 * Fourteen surfaces had written this by hand — a channel sidebar with nothing in it, a thread
 * list, a pinned-messages panel, a search with no hits — each with its own scoped rule for the
 * same centred, muted paragraph. They agreed on the idea and disagreed on every number, so the
 * padding and the type drifted apart surface by surface. This is that one panel, and the rules
 * go with it.
 *
 * ## Neither half is required
 *
 * Several call sites are a bare sentence with no heading ("No threads in this channel yet."),
 * and a few are a heading over a spinner. So {@link title} and {@link body} are both optional
 * and either may stand alone.
 *
 * ## Projected content wins over `body`
 *
 * The default slot takes precedence when both are given, because at least one site needs
 * markup rather than a string: the quick switcher shows a spinner in the same place while a
 * directory lookup is in flight. A string input alone could not express that.
 *
 * ## It brings no list semantics
 *
 * Three call sites sit inside a `<ul>`, where the only valid child is an `<li>`. The list item
 * stays at the call site and this goes inside it — the component must not guess, because a
 * `<li>` rendered into a `<div>` parent is as wrong as the other way round.
 *
 * Whatever you write on the element reaches the DOM: `data-testid` and `aria-live` need no
 * input of their own.
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
  // A block of its own, and it says so here rather than in a stylesheet: a wrapper with no
  // host display is inline, which silently drops its padding — but only where the parent is
  // not itself flex or grid, so it looks random rather than broken.
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

  /**
   * How the text reads. `danger` is for the ones that are a failure rather than an absence —
   * the channel sidebar's "Couldn't load rooms" sits in the same place as its empty line.
   */
  readonly tone = input<'muted' | 'danger'>('muted');

  /**
   * How much room it takes.
   *
   * The fifteen rules this replaces are not one size, which only adoption revealed: four are
   * centred panels at 24px (the timeline, a thread, the quick switcher, in-room search), and
   * the rest are lines inside a list — 8px in the two sidebars and the reactions dialog, 12px
   * in the three that sit inside a `<ul>`. A single size would have grown the compact ones
   * roughly fourfold in a 280px column.
   *
   * Two, not three: 8px and 12px are near enough to consolidate, and consolidating drift is
   * the point of the component. 24px against 32px is not — that is a panel's worth.
   */
  readonly size = input<'panel' | 'line' | 'hero'>('panel');

  /**
   * A short glyph in a circle above the text — `#` for a room, an initial for a person.
   *
   * Its own input rather than {@link icon} because it is not an icon: the one site that has
   * one puts a literal `#` in a 68px disc, and the registry has no glyph for "a room in the
   * abstract". Rendered at any size, though only the hero has ever wanted it.
   */
  readonly badge = input<string>();

  /**
   * What element the title is.
   *
   * `p` by default, because most of these panels sit inside a section that already has its
   * heading. The hero is the exception and says so at the call site: it is the only content
   * on the pane, and its `<h2>` is deliberate — `trn-page-header` owns the page's single
   * `<h1>`, so promoting this to one would give the document two.
   */
  readonly titleAs = input<'p' | 'h2'>('p');

  /**
   * Whole class strings, never a static `class` beside a `[class]` binding.
   *
   * `page-header` — the model this component follows for styling — puts the entire recipe in
   * its computed, and nothing else in the workspace mixes the two forms. Kept as full literal
   * strings rather than assembled from fragments, so the Tailwind classes stay statically
   * scannable; that is what decides whether they are generated at all.
   *
   * `text-13` at every size, which is a NORMALISATION rather than a preservation: the fifteen
   * rules this replaced ran 12px, 13px, 14px and — for the four that set no size at all and so
   * inherited the document's — 16px. Nine of the fifteen therefore move. The visible ones are
   * those four panels, which come down 16 to 13; that is deliberate and is in the changelog,
   * because "one component" is worth little if it still renders four sizes.
   *
   * `empty:hidden` is load-bearing rather than tidiness: with neither `body` set nor content
   * projected, this paragraph holds only an anchor, and without the rule it would still
   * contribute a line box under a heading that should be the last thing on the panel.
   *
   * `text-danger`, never `text-destructive`: the latter is a fill/tint token whose dark value
   * is a near-black maroon, so using it as a foreground makes the error unreadable in exactly
   * the theme where an error matters most.
   */
  protected readonly bodyClass = computed(() =>
    this.tone() === 'danger'
      ? 'text-13 text-balance text-danger empty:hidden'
      : 'text-13 text-balance text-muted-foreground empty:hidden',
  );

  /**
   * The outer column's own padding, which is the whole of what {@link size} decides.
   *
   * `py-6` for a panel — 24px, matching the four sites that already used it. Worth naming:
   * the first version of this component shipped `py-8`, which matched none of the fifteen and
   * would have changed every one of them.
   */
  protected readonly layoutClass = computed(() => {
    switch (this.size()) {
      case 'line':
        return 'flex flex-col items-center gap-1 px-2 py-2 text-center';
      case 'hero':
        // `max-w-[420px] mx-auto` is the measure the hero already had. It does NOT centre
        // itself in the pane — that is the container's job, the same way `.chat-empty` was a
        // separate flex wrapper around `.hero`.
        return 'mx-auto flex max-w-[420px] flex-col items-center gap-2 px-6 py-6 text-center';
      default:
        return 'flex flex-col items-center gap-2 px-4 py-6 text-center';
    }
  });

  /** The title's type. A hero's is the pane's own headline; the rest are a label. */
  protected readonly titleClass = computed(() =>
    this.size() === 'hero'
      ? 'text-[22px] font-bold text-balance text-foreground'
      : 'text-sm font-semibold text-balance text-foreground',
  );

  /** `empty:hidden` so a panel with no action contributes neither the row nor its margin. */
  protected readonly actionsClass =
    'empty-state__actions mt-1 flex items-center gap-2 empty:hidden';
}
