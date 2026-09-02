import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

const withoutComments = (source) =>
  source
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|\s)\/\/.*$/gmu, '$1');

const source = `
import { Component } from '@angular/core';
import {
  TrnEmojiPickerComponent,
  TrnFieldComponent,
  TrnFieldLabelComponent,
  TrnInput,
  TrnLabel,
  TrnSelectComponent,
  TrnTextarea,
  type TrnSelectOption,
} from '@trinity/components/controls';

const OPTIONS: readonly TrnSelectOption<string>[] = [
  { value: 'one', label: 'One' },
];

@Component({
  imports: [
    TrnEmojiPickerComponent,
    TrnFieldComponent,
    TrnFieldLabelComponent,
    TrnInput,
    TrnLabel,
    TrnSelectComponent,
    TrnTextarea,
  ],
  template: \`
    <trn-field invalid>
      <trn-field-label controlId="name" emphasis="strong" invalid>Name</trn-field-label>
      <input trnInput id="name" size="sm" invalid aria-describedby="name-error" />
      <span id="name-error">Required.</span>
    </trn-field>
    <label trnLabel emphasis="normal" invalid for="topic">Topic</label>
    <textarea trnTextarea id="topic" size="lg"></textarea>
    <trn-select aria-label="Choice" size="md" invalid [options]="options" />
    <trn-emoji-picker size="lg" />
  \`,
})
export class ValidFieldControlHost {
  protected readonly options = OPTIONS;
}

@Component({
  imports: [TrnFieldLabelComponent, TrnInput, TrnLabel, TrnSelectComponent, TrnTextarea, TrnEmojiPickerComponent],
  template: \`
    <trn-field-label controlId="bad" emphasis="muted">Bad label</trn-field-label>
    <trn-field-label controlId="old" variant="eyebrow">Old label</trn-field-label>
    <label trnLabel emphasis="danger">Bad native label</label>
    <input trnInput size="xs" [variant]="'neutral'" [forceInvalid]="true" />
    <textarea trnTextarea size="2xl"></textarea>
    <trn-select size="lg" [triggerClass]="'w-full'" [options]="options" />
    <trn-emoji-picker size="xl" [emojiSize]="28" />
  \`,
})
export class InvalidFieldControlHost {
  protected readonly options = OPTIONS;
}

@Component({
  imports: [TrnInput],
  template: \`<textarea trnInput [invalid]="true"></textarea>\`,
})
export class InvalidElementHost {}
`;

function compileTemplateContract() {
  const { options } = readConfiguration(
    join(workspaceRoot, 'tsconfig.base.json'),
  );
  options.noEmit = true;
  const fixture = join(workspaceRoot, 'field-control-template.fixture.ts');
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

describe('field control strict-template contract', () => {
  it('accepts precise canonical inputs and rejects unrelated or vendor-shaped values', () => {
    const errors = compileTemplateContract();
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors.map(({ code }) => code)).toEqual([
      ...Array(6).fill(2322),
      ...Array(5).fill(-998002),
    ]);

    for (const unsupported of [
      'muted',
      'danger',
      'xs',
      'variant',
      'forceInvalid',
      '2xl',
      'triggerClass',
      'emojiSize',
      'invalid',
    ]) {
      expect(messages, unsupported).toEqual(
        expect.arrayContaining([expect.stringContaining(unsupported)]),
      );
    }
  });

  it('keeps vendor styling inputs private and native element selectors precise', () => {
    const files = [
      'libs/components/controls/src/lib/input/trn-input.ts',
      'libs/components/controls/src/lib/textarea/trn-textarea.ts',
      'libs/components/controls/src/lib/select/trn-select.component.ts',
      'libs/components/controls/src/lib/emoji-picker/trn-emoji-picker/trn-emoji-picker.component.ts',
    ].map((file) =>
      withoutComments(readFileSync(join(workspaceRoot, file), 'utf8')),
    );
    const joined = files.join('\n');

    expect(files[0]).toContain("selector: 'input[trnInput]'");
    expect(files[1]).toContain("selector: 'textarea[trnTextarea]'");
    expect(joined).not.toMatch(
      /readonly\s+(?:triggerClass|emojiSize|forceInvalid)\s*=\s*input/u,
    );

    const productionTemplates =
      readFileSync(
        join(
          workspaceRoot,
          'libs/feature/rooms/src/lib/room-settings/room-settings.component.html',
        ),
        'utf8',
      ) +
      readFileSync(
        join(
          workspaceRoot,
          'libs/feature/rooms/src/lib/space-settings/space-settings.component.html',
        ),
        'utf8',
      );
    expect(withoutComments(productionTemplates)).not.toMatch(
      /<textarea\b[^>]*\btrnInput\b/su,
    );
  });
});
