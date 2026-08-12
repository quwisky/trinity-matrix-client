import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  TrnSelect,
  TrnSelectContent,
  TrnSelectItem,
  TrnSelectPortal,
  TrnSelectTrigger,
  TrnSelectValue,
} from '@trinity/kit/select';
import {
  ThemeService,
  TRINITY_CODE_LINE_MODES,
  TRINITY_CODE_SCALES,
  type CodeLineMode,
  type CodeScale,
} from '@trinity/platform-native';

/**
 * How code inside messages is displayed, as its own block on the Appearance page.
 *
 * Split out rather than appended: the page's template was already at the size this repo
 * refactors at (.claude/rules/code-quality.md), and code display is a coherent group of its
 * own rather than another loose control among the mode and format pickers.
 */
@Component({
  selector: 'trn-code-appearance-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './code-appearance-block.component.html',
  imports: [
    TrnSelect,
    TrnSelectTrigger,
    TrnSelectValue,
    TrnSelectContent,
    TrnSelectPortal,
    TrnSelectItem,
  ],
})
export class CodeAppearanceBlockComponent {
  readonly theme = inject(ThemeService);

  /**
   * Label for a code-scale id. `trn-select` renders the collapsed trigger from the bound
   * VALUE rather than the chosen option's markup, so without this the control would read
   * "larger" instead of "Larger". A stable field, not an inline arrow, which would be a new
   * reference every change detection.
   */
  readonly codeScaleLabel = (scale: string): string =>
    TRINITY_CODE_SCALES.find((entry) => entry.id === scale)?.label ?? scale;

  /** Apply + persist how large code is. */
  onCodeScaleChange(value: string | null | undefined): void {
    if (this.theme.codeScales.some((scale) => scale.id === value)) {
      this.theme.setCodeScale(value as CodeScale);
    }
  }

  /** Label for a line-number mode id, for the same reason as {@link codeScaleLabel}. */
  readonly codeLineLabel = (mode: string): string =>
    TRINITY_CODE_LINE_MODES.find((entry) => entry.id === mode)?.label ?? mode;

  /** Apply + persist when blocks show line numbers. */
  onCodeLinesChange(value: string | null | undefined): void {
    if (this.theme.codeLineModes.some((mode) => mode.id === value)) {
      this.theme.setCodeLines(value as CodeLineMode);
    }
  }
}
