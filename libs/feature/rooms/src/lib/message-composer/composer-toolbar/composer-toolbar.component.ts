import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { TrnSeparatorDirective } from '@trinity/components/separator';
import {
  TrnToggleGroupComponent,
  TrnToggleGroupItemDirective,
} from '@trinity/components/toggle-group';
import { TrnTooltip } from '@trinity/components/tooltip';
import { type FormatAction } from '@trinity/util/matrix';
import { TrnIconComponent, type TrnIconName } from '@trinity/components/icon';

/** One toolbar button: the action it applies, its icon and its label. */
interface ToolbarAction {
  action: FormatAction;
  icon: TrnIconName;
  label: string;
}

/**
 * All nine actions, in three groups divided by a rule.
 *
 * Grouped by what they do to the text rather than by how often they are reached for: marks
 * that wrap a selection, blocks that reshape a whole line, and the two that make a list. The
 * previous split was "four out here, five behind a kebab", which is a statement about screen
 * space rather than about formatting — and the kebab is gone, so the grouping can say
 * something true instead.
 */
const GROUPS: readonly (readonly ToolbarAction[])[] = [
  [
    { action: 'bold', icon: 'bold', label: 'Bold' },
    { action: 'italic', icon: 'italic', label: 'Italic' },
    { action: 'strike', icon: 'strikethrough', label: 'Strikethrough' },
  ],
  [
    { action: 'code', icon: 'code', label: 'Inline code' },
    { action: 'codeblock', icon: 'square-code', label: 'Code block' },
    { action: 'quote', icon: 'text-quote', label: 'Quote' },
  ],
  [
    { action: 'link', icon: 'link', label: 'Link' },
    { action: 'list', icon: 'list', label: 'Bulleted list' },
    { action: 'tasklist', icon: 'list-todo', label: 'Task list' },
  ],
];

/**
 * The formatting bar: nine actions, a pin, and the preview toggle.
 *
 * Presentational — it injects nothing and holds no state. Whether it is on screen at all is
 * the composer's question, and so is what "pinned" means; this renders what it is given.
 *
 * ## No overflow any more
 *
 * There used to be four buttons and a kebab holding the other five, narrowed to two buttons
 * below `md`. That existed because the bar was always there and had to earn its row. A bar
 * that appears when you select something can afford to show everything it can do, and a
 * formatting action hidden behind a menu is one nobody discovers. `data-testid="format-more"`
 * is gone; every `format-<action>` hook is unchanged.
 *
 * ## One toolbar, keyboard-wise
 *
 * The nine sit in a `trn-toggle-group`, which is what makes them one tab stop with arrow keys
 * between them rather than nine stops. That is the group's whole contribution here — see the
 * note on {@link applied} for the part that is deliberately NOT used.
 */
@Component({
  selector: 'trn-composer-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnIconComponent,
    TrnToggleGroupComponent,
    TrnToggleGroupItemDirective,
    TrnSeparatorDirective,
    TrnTooltip,
  ],
  templateUrl: './composer-toolbar.component.html',
  styleUrl: './composer-toolbar.component.scss',
})
export class ComposerToolbarComponent {
  /** Whether the composer is currently showing the preview rather than the input. */
  readonly previewing = input(false);
  /** Disables every action (an upload in flight owns the composer). */
  readonly disabled = input(false);
  /** Whether the bar is pinned open rather than raised by the current selection. */
  readonly pinned = input(false);

  /** A formatting action was chosen. */
  readonly format = output<FormatAction>();
  /** The preview button was pressed. */
  readonly togglePreview = output<void>();
  /** The pin was pressed; the new state is the opposite of {@link pinned}. */
  readonly togglePinned = output<void>();

  readonly groups = GROUPS;

  /**
   * Whether the formatting actions are unavailable. Previewing counts: the textarea is hidden,
   * so there is no visible selection to format and no way to see what changed — the edit would
   * land silently behind the preview. The preview button itself stays live, or there would be
   * no way back.
   */
  readonly formatDisabled = computed(
    () => this.disabled() || this.previewing(),
  );

  /**
   * What the toggle group holds as "selected": nothing, ever.
   *
   * `BrnToggleGroupItem` stamps `aria-pressed` from the group's value, and a formatting action
   * is a one-shot COMMAND rather than a selection — pressing Bold does not put the toolbar in
   * a bold state, it wraps some text. Left to accumulate, Bold would read as pressed for the
   * rest of the session; #180 calls that out as the trap in building on this primitive.
   *
   * The honest alternative is deriving the value from the marks around the caret, which is
   * what Discord and Slack do and what would make `aria-pressed` mean something. It needs mark
   * detection the composer does not have, and #180 sanctions either answer — so the value is
   * pinned empty here and the derived version is a separate piece of work, not something to
   * half-do inside a layout change.
   */
  // `string[]`, not `readonly string[]`: the kit's `ToggleValue<T>` is `T | T[] | null`, and a
  // readonly array is not assignable to it. Template type-checking is what says so, which the
  // spec typecheck target does not do — `pnpm build` is the gate that catches this.
  protected readonly applied = signal<string[]>([]);

  /**
   * Apply an action, then put the group back to holding nothing.
   *
   * A NEW empty array each time, and that is the mechanism rather than an accident:
   * `BrnToggleGroupItem` binds `(click)="toggle()"` on its own host, so the item flips itself
   * whatever this component thinks — and a binding re-set to the same array by reference would
   * not fire, leaving Bold pressed for the rest of the session.
   */
  protected apply(action: FormatAction): void {
    this.format.emit(action);
    this.applied.set([]);
  }
}
