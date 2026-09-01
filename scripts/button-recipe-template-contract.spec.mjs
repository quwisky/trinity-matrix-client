import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import ts from 'typescript';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

const source = `
import { Component } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';

@Component({
  imports: [TrnButton],
  template: \`
    <button trnBtn variant="primary" size="md">Primary</button>
    <button trnBtn variant="danger" size="md">Danger</button>
    <button trnBtn variant="primary" presentation="ghost" shape="icon" size="md">Icon</button>
    <button trnBtn variant="primary" shape="icon" size="default">Mixed migration icon</button>
    <button trnBtn variant="default" size="default">Legacy default</button>
    <button trnBtn variant="destructive" size="icon">Legacy icon</button>
  \`,
})
export class ValidButtonRecipeHost {}

@Component({
  imports: [TrnButton],
  template: \`<button trnBtn variant="success">Unsupported variant</button>\`,
})
export class InvalidButtonVariantHost {}

@Component({
  imports: [TrnButton],
  template: \`<button trnBtn size="xl">Unsupported size</button>\`,
})
export class InvalidButtonSizeHost {}
`;

function compileTemplateContract() {
  const { options } = readConfiguration(
    join(workspaceRoot, 'tsconfig.base.json'),
  );
  options.noEmit = true;
  const fixture = join(workspaceRoot, 'button-recipe-template.fixture.ts');
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

describe('button recipe strict-template contract', () => {
  it('accepts the component subset and rejects unsupported global values', () => {
    const errors = compileTemplateContract();
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );

    expect(errors.map(({ code }) => code)).toEqual([2322, 2322]);
    expect(messages).toEqual([
      expect.stringContaining('"success"'),
      expect.stringContaining('"xl"'),
    ]);
  });
});
