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
  TrnSeparatorDirective,
  TrnTabPanelComponent,
  TrnTabsComponent,
  type TrnTabOption,
} from '@trinity/components/navigation-layout';

const TABS: readonly TrnTabOption[] = [
  { value: 'general', label: 'General' },
  { value: 'access', label: 'Access' },
];

@Component({
  imports: [
    PageHeaderComponent,
    TrnCardImports,
    TrnSeparatorDirective,
    TrnTabPanelComponent,
    TrnTabsComponent,
  ],
  template: \`
    <trn-page-header title="Page" variant="neutral" layout="page" />
    <trn-page-header title="Toolbar" variant="chat" />
    <trn-tabs tab="general" [tabs]="tabs" variant="accent" presentation="line">
      <trn-tab-panel value="general">General</trn-tab-panel>
      <trn-tab-panel value="access">Access</trn-tab-panel>
    </trn-tabs>
    <trn-tabs tab="general" [tabs]="tabs" variant="default" />
    <section trnCard variant="muted" size="sm">
      <h2 trnCardTitle>Card</h2>
    </section>
    <div trnSeparator variant="accent" orientation="vertical" [decorative]="false"></div>
  \`,
})
export class ValidNavigationLayoutRecipeHost {
  protected readonly tabs = TABS;
}

@Component({
  imports: [TrnTabsComponent],
  template: \`<trn-tabs tab="general" [tabs]="tabs" variant="danger" presentation="segmented" />\`,
})
export class InvalidTabsHost { protected readonly tabs = TABS; }

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
  imports: [TrnSeparatorDirective],
  template: \`<div trnSeparator variant="muted" orientation="diagonal"></div>\`,
})
export class InvalidSeparatorHost {}
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
  it('accepts canonical and compatibility inputs while rejecting unsupported values', () => {
    const errors = compileTemplateContract();
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );

    expect(errors.map(({ code }) => code)).toEqual(Array(8).fill(2322));
    expect(messages).toEqual([
      expect.stringContaining('"danger"'),
      expect.stringContaining('"segmented"'),
      expect.stringContaining('"danger"'),
      expect.stringContaining('"chat"'),
      expect.stringContaining('"accent"'),
      expect.stringContaining('"lg"'),
      expect.stringContaining('"diagonal"'),
      expect.stringContaining('"muted"'),
    ]);
  });

  it('keeps behavior vendors and recipe-library types private', () => {
    const entrypoint = readFileSync(
      join(workspaceRoot, 'libs/components/navigation-layout/src/index.ts'),
      'utf8',
    );
    const separator = readFileSync(
      join(
        workspaceRoot,
        'libs/components/navigation-layout/src/lib/separator/trn-separator.directive.ts',
      ),
      'utf8',
    );
    const panel = readFileSync(
      join(
        workspaceRoot,
        'libs/components/navigation-layout/src/lib/tabs/trn-tab-panel.component.ts',
      ),
      'utf8',
    );

    expect(entrypoint).not.toMatch(
      /@trinity\/helm|@spartan-ng|VariantProps|ClassValue/u,
    );
    expect(separator).toContain("from '@spartan-ng/brain/separator'");
    expect(separator).not.toContain("from '@trinity/helm/separator'");
    expect(panel).toContain('@layer components');
  });
});
