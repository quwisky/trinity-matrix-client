import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

const source = `
import { Component } from '@angular/core';
import {
  PageHeaderComponent,
  TrnCardImports,
} from '@trinity/components/navigation-layout';

@Component({
  imports: [
    PageHeaderComponent,
    TrnCardImports,
        ],
  template: \`
    <trn-page-header title="Page" variant="neutral" layout="page" />
    <trn-page-header title="Toolbar" variant="neutral" layout="toolbar" />
    <section trnCard variant="muted" size="sm">
      <h2>Card</h2>
    </section>
  \`,
})
export class ValidNavigationLayoutRecipeHost {}

@Component({
  imports: [PageHeaderComponent],
  template: \`<trn-page-header variant="danger" layout="chat" />\`,
})
export class InvalidHeaderHost {}

@Component({
  imports: [TrnCardImports],
  template: \`<section trnCard variant="accent" size="lg"></section>\`,
})
export class InvalidCardHost {}

@Component({
  imports: [PageHeaderComponent],
  template: \`<trn-page-header variant="chat" />\`,
})
export class InvalidLegacyNavigationHost {}
`;

function compileTemplateContract() {
  const { options } = readConfiguration(
    join(workspaceRoot, 'tsconfig.base.json'),
  );
  options.noEmit = true;
  const fixture = join(
    workspaceRoot,
    'navigation-layout-recipe-template.fixture.ts',
  );
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

describe('navigation and layout recipe strict-template contract', () => {
  it('accepts canonical inputs while rejecting unsupported or retired values', () => {
    const errors = compileTemplateContract();
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors.map(({ code }) => code)).toEqual(Array(5).fill(2322));
    for (const unsupported of ['danger', 'chat', 'accent', 'lg']) {
      expect(messages, unsupported).toEqual(
        expect.arrayContaining([expect.stringContaining(unsupported)]),
      );
    }
  });

  it('keeps behavior vendors and recipe-library types private', () => {
    const entrypoint = readFileSync(
      join(workspaceRoot, 'libs/components/navigation-layout/src/index.ts'),
      'utf8',
    );

    expect(entrypoint).not.toMatch(
      /@trinity\/helm|@spartan-ng|VariantProps|ClassValue/u,
    );
  });
});
