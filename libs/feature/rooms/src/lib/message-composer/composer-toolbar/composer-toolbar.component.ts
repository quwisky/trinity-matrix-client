import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { type FormatAction } from '@trinity/util/matrix';
import { TrnIconComponent, type TrnIconName } from '@trinity/components/icon';

/** One toolbar button: the action it applies, its icon and its label. */
interface ToolbarAction {
  action: FormatAction;
  icon: TrnIconName;
  label: string;
}

/**
 * Actions offered on a roomy layout, in order. The rest live behind the overflow — chosen by
 * how often they are reached for, not by how well they demo.
 */
const PRIMARY: readonly ToolbarAction[] = [
  { action: 'bold', icon: 'bold', label: 'Bold' },
  { action: 'italic', icon: 'italic', label: 'Italic' },
  { action: 'link', icon: 'link', label: 'Link' },
  { action: 'code', icon: 'code', label: 'Inline code' },
];

/** On a phone the composer competes with the keyboard, so only the two most-used stay out. */
const PRIMARY_NARROW: readonly ToolbarAction[] = PRIMARY.slice(0, 2);

const SECONDARY: readonly ToolbarAction[] = [
  { action: 'strike', icon: 'strikethrough', label: 'Strikethrough' },
  { action: 'codeblock', icon: 'square-code', label: 'Code block' },
  { action: 'quote', icon: 'text-quote', label: 'Quote' },
  { action: 'list', icon: 'list', label: 'Bulleted list' },
  { action: 'tasklist', icon: 'list-todo', label: 'Task list' },
];

/**
 * Formatting affordances above the composer input: the common actions as buttons, the rest
 * behind an overflow, and a preview toggle.
 *
 * Presentational — it injects nothing and holds no state. The viewport question is the
 * parent's (it owns the media query and passes {@link narrow} down), which is the same
 * division `sidebar-user-panel` uses.
 */
@Component({
  selector: 'trn-composer-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnIconComponent,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuTrigger,
    HlmTooltip,
  ],
  templateUrl: './composer-toolbar.component.html',
  styleUrl: './composer-toolbar.component.scss',
})
export class ComposerToolbarComponent {
  /** True on the narrow single-pane layout, where fewer buttons stay outside the overflow. */
  readonly narrow = input(false);
  /** Whether the composer is currently showing the preview rather than the input. */
  readonly previewing = input(false);
  /** Disables every action (an upload in flight owns the composer). */
  readonly disabled = input(false);

  /** A formatting action was chosen, from a button or from the overflow. */
  readonly format = output<FormatAction>();
  /** The preview button was pressed. */
  readonly togglePreview = output<void>();

  /**
   * Whether the formatting actions are unavailable. Previewing counts: the textarea is hidden,
   * so there is no visible selection to format and no way to see what changed — the edit would
   * land silently behind the preview. The preview button itself stays live, or there would be
   * no way back.
   */
  readonly formatDisabled = computed(
    () => this.disabled() || this.previewing(),
  );

  /** The buttons rendered outright, which depends only on the width. */
  readonly primary = computed(() => (this.narrow() ? PRIMARY_NARROW : PRIMARY));

  /**
   * Everything not rendered outright. Computed rather than a constant so nothing can appear
   * twice or go missing when the layout changes — the overflow is defined as the remainder.
   */
  readonly overflow = computed(() => {
    const shown = new Set(this.primary().map((entry) => entry.action));
    return [...PRIMARY, ...SECONDARY].filter(
      (entry) => !shown.has(entry.action),
    );
  });
}
