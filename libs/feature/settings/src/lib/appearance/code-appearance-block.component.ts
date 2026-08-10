import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HlmInput } from '@trinity/helm/input';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/select';
import {
  CodeHighlightSettingsService,
  MAX_HIGHLIGHT_LINES_CEILING,
  ThemeService,
  type CodeLineMode,
  type CodeScale,
} from '@trinity/platform-native';

/**
 * How code inside messages is displayed, as its own block on the Appearance page.
 *
 * Split out rather than appended: the page's template was already at the size this repo
 * refactors at (.claude/rules/code-quality.md), and code display is a coherent group of its
 * own rather than another loose control among the mode and format pickers.
 *
 * The highlighting limit is a draft signal plus a computed message rather than a Signal
 * Form, matching {@link PushGatewayBlockComponent} and the two pickers above it: there is
 * one field and no submit, so a form would be machinery around a single number. What it
 * does need — and the reason the draft is a string — is a commit that is NOT per keystroke.
 * Applying this preference re-projects every message in the open room, so typing `250` must
 * not apply `2`, then `25`, then `250`.
 */
@Component({
  selector: 'trn-code-appearance-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './code-appearance-block.component.html',
  imports: [HlmInput, TrnSelectComponent],
})
export class CodeAppearanceBlockComponent {
  private readonly codeHighlight = inject(CodeHighlightSettingsService);

  readonly theme = inject(ThemeService);

  /** The largest limit the field accepts, for the message and the `max` attribute. */
  readonly maxLines = MAX_HIGHLIGHT_LINES_CEILING;

  /**
   * The choices, in the shape the wrapper takes. A stable field rather than an inline
   * arrow, which would be a new reference every change detection — the wrapper takes
   * `options` as an input, so a fresh array each pass would re-render the list.
   */
  readonly codeScaleOptions: readonly TrnSelectOption<string>[] =
    this.theme.codeScales.map((scale) => ({
      value: scale.id,
      label: scale.label,
      testId: `code-scale-${scale.id}`,
    }));
  readonly codeLineOptions: readonly TrnSelectOption<string>[] =
    this.theme.codeLineModes.map((mode) => ({
      value: mode.id,
      label: mode.label,
      testId: `code-lines-${mode.id}`,
    }));

  /**
   * What is in the field. A string, not a number, because that is what an `<input>` holds:
   * "" and "12." are both states a number model cannot represent, and both need a message
   * rather than a silent coercion to 0 — which is the value that means "no limit".
   */
  readonly linesDraft = signal(String(this.codeHighlight.maxHighlightLines()));

  /** The applied limit, so the hint can describe what is actually in force. */
  readonly appliedLines = this.codeHighlight.maxHighlightLines;

  /** Why the draft would be refused, or null when it is a limit we can apply. */
  readonly errorText = computed<string | null>(() => {
    const draft = this.linesDraft().trim();
    if (!draft) {
      return `Enter a number of lines, or 0 for no limit.`;
    }
    const lines = Number(draft);
    if (!Number.isFinite(lines) || !Number.isInteger(lines)) {
      return `Enter a whole number of lines.`;
    }
    if (lines < 0) {
      return `Enter 0 or more lines. 0 means no limit.`;
    }
    if (lines > this.maxLines) {
      return `Enter at most ${this.maxLines} lines, or 0 for no limit.`;
    }
    return null;
  });

  /** Apply + persist how large code is. */
  onCodeScaleChange(value: string | null | undefined): void {
    if (this.theme.codeScales.some((scale) => scale.id === value)) {
      this.theme.setCodeScale(value as CodeScale);
    }
  }

  /** Apply + persist when blocks show line numbers. */
  onCodeLinesChange(value: string | null | undefined): void {
    if (this.theme.codeLineModes.some((mode) => mode.id === value)) {
      this.theme.setCodeLines(value as CodeLineMode);
    }
  }

  /** Track what has been typed, without applying it. */
  onHighlightLinesInput(value: string): void {
    this.linesDraft.set(value);
  }

  /**
   * Apply + persist the limit, on a settled value — `change` fires on blur, on Enter and on
   * the steppers, never mid-keystroke. A draft the field would refuse is left alone rather
   * than reverted, so the message stays next to what the user typed.
   */
  commitHighlightLines(): void {
    if (this.errorText()) {
      return;
    }
    this.codeHighlight.setMaxHighlightLines(Number(this.linesDraft().trim()));
  }
}
