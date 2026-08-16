import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/select';
import {
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
 */
@Component({
  selector: 'trn-code-appearance-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './code-appearance-block.component.html',
  imports: [TrnSelectComponent],
})
export class CodeAppearanceBlockComponent {
  readonly theme = inject(ThemeService);

  /**
   * Label for a code-scale id. The select renders the collapsed trigger from the bound
   * VALUE rather than the chosen option's markup, so without this the control would read
   * "larger" instead of "Larger". A stable field, not an inline arrow, which would be a new
   * reference every change detection.
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

  /** Apply + persist how large code is. */
  onCodeScaleChange(value: string | null | undefined): void {
    if (this.theme.codeScales.some((scale) => scale.id === value)) {
      this.theme.setCodeScale(value as CodeScale);
    }
  }

  /** Label for a line-number mode id, for the same reason as {@link codeScaleLabel}. */

  /** Apply + persist when blocks show line numbers. */
  onCodeLinesChange(value: string | null | undefined): void {
    if (this.theme.codeLineModes.some((mode) => mode.id === value)) {
      this.theme.setCodeLines(value as CodeLineMode);
    }
  }
}
