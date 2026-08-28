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
import { SettingsFieldRowDirective } from '../shared/settings-field-row.directive';
import { SettingsGroupComponent } from '../shared/settings-group/settings-group.component';

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
    TrnSelectComponent,
    SettingsFieldRowDirective,
    SettingsGroupComponent,
  ],
})
export class CodeAppearanceBlockComponent {
  readonly theme = inject(ThemeService);

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
}
