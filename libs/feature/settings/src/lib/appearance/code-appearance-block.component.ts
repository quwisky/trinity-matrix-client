import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SettingsGroupComponent } from '../shared/settings-group/settings-group.component';
import {
  AppearancePreferenceFieldComponent,
  type AppearancePreferenceField,
} from './appearance-preference-field/appearance-preference-field.component';

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
  imports: [AppearancePreferenceFieldComponent, SettingsGroupComponent],
})
export class CodeAppearanceBlockComponent {
  readonly codeSizeField = {
    axis: 'codeSize',
    headingId: 'appearance-code-size-heading',
    testId: 'code-scale-select',
    optionTestIdPrefix: 'code-scale',
  } as const satisfies AppearancePreferenceField;
  readonly codeLinePresentationField = {
    axis: 'codeLinePresentation',
    headingId: 'appearance-code-lines-heading',
    testId: 'code-lines-select',
    optionTestIdPrefix: 'code-lines',
  } as const satisfies AppearancePreferenceField;
}
