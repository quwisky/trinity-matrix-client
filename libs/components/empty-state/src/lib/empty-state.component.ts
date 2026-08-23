import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TrnIconComponent, type TrnIconName } from '@trinity/components/icon';

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
 *   <button trnEmptyStateActions hlmBtn size="sm">Start one</button>
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
   * `text-danger`, never `text-destructive`: the latter is a fill/tint token whose dark value
   * is a near-black maroon, so using it as a foreground makes the error unreadable in exactly
   * the theme where an error matters most.
   */
  protected readonly toneClass = computed(() =>
    this.tone() === 'danger' ? 'text-danger' : 'text-muted-foreground',
  );
}
