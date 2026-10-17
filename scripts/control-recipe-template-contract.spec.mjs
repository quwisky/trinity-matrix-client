import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileStrictTemplate } from './strict-template-compile.mjs';

const source = `
import { Component } from '@angular/core';
import {
  TrnCheckboxComponent,
  TrnRadioGroupComponent,
  TrnSwitchComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';

const OPTIONS: readonly TrnRadioOption<string>[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
];

@Component({
  imports: [
    TrnCheckboxComponent,
    TrnRadioGroupComponent,
    TrnSwitchComponent,
        ],
  template: \`
    <trn-checkbox invalid />
    <trn-switch />
    <trn-radio-group layout="segmented" [options]="options" />
  \`,
})
export class ValidControlRecipeHost {
  protected readonly options = OPTIONS;
}

@Component({
  imports: [TrnRadioGroupComponent],
  template: \`<trn-radio-group layout="grid" [options]="options" />\`,
})
export class InvalidRadioHost {
  protected readonly options = OPTIONS;
}
`;

describe('control recipe strict-template contract', () => {
  it('accepts canonical values and rejects unsupported or retired recipes', () => {
    const errors = compileStrictTemplate(
      source,
      'control-recipe-template.fixture.ts',
    );
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors.map(({ code }) => code)).toEqual(Array(1).fill(2322));

    for (const unsupported of ['grid']) {
      expect(messages, unsupported).toEqual(
        expect.arrayContaining([expect.stringContaining(`"${unsupported}"`)]),
      );
    }
  });
});
