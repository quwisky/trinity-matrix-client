import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

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
    <trn-checkbox variant="neutral" size="sm" invalid />
    <trn-switch variant="accent" size="md" />
    <trn-radio-group layout="segmented" variant="accent" size="md" [options]="options" />
  \`,
})
export class ValidControlRecipeHost {
  protected readonly options = OPTIONS;
}

@Component({
  imports: [TrnCheckboxComponent],
  template: \`<trn-checkbox variant="danger" size="lg" />\`,
})
export class InvalidCheckboxHost {}

@Component({
  imports: [TrnSwitchComponent],
  template: \`<trn-switch variant="warning" size="lg" />\`,
})
export class InvalidSwitchHost {}

@Component({
  imports: [TrnRadioGroupComponent],
  template: \`<trn-radio-group layout="grid" variant="danger" size="lg" [options]="options" />\`,
})
export class InvalidRadioHost {
  protected readonly options = OPTIONS;
}

@Component({
  imports: [TrnRadioGroupComponent],
  template: \`<trn-radio-group variant="segmented" [options]="options" />\`,
})
export class InvalidLegacyControlHost {
  protected readonly options = OPTIONS;
}
`;

function compileTemplateContract() {
  const { options } = readConfiguration(
    join(workspaceRoot, 'tsconfig.base.json'),
  );
  options.noEmit = true;
  const fixture = join(workspaceRoot, 'control-recipe-template.fixture.ts');
  const host = ts.createCompilerHost(options, true);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) => fileName === fixture || fileExists(fileName);
  host.readFile = (fileName) =>
    fileName === fixture ? source : readFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    fileName === fixture
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );

  const program = new NgtscProgram([fixture], options, host);
  return [
    ...program.getTsOptionDiagnostics(),
    ...program.getTsSyntacticDiagnostics(),
    ...program.getTsSemanticDiagnostics(),
    ...program.getNgOptionDiagnostics(),
    ...program.getNgStructuralDiagnostics(),
    ...program.getNgSemanticDiagnostics(),
  ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

describe('control recipe strict-template contract', () => {
  it('accepts canonical values and rejects unsupported or retired recipes', () => {
    const errors = compileTemplateContract();
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors.map(({ code }) => code)).toEqual(Array(8).fill(2322));

    for (const unsupported of ['danger', 'warning', 'grid', 'segmented']) {
      expect(messages, unsupported).toEqual(
        expect.arrayContaining([expect.stringContaining(`"${unsupported}"`)]),
      );
    }
  });
});
