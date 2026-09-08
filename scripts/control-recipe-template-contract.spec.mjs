import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

const withoutHtmlComments = (source) => source.replace(/<!--[\s\S]*?-->/gu, '');
const withoutCodeComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/.*$/gmu, '$1');

const source = `
import { Component } from '@angular/core';
import {
  TrnCheckboxComponent,
  TrnRadioGroupComponent,
  TrnSwitchComponent,
  TrnToggleDirective,
  TrnToggleGroupComponent,
  TrnToggleGroupItemDirective,
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
    TrnToggleDirective,
    TrnToggleGroupComponent,
    TrnToggleGroupItemDirective,
  ],
  template: \`
    <trn-checkbox variant="neutral" size="sm" invalid />
    <trn-switch variant="accent" size="md" />
    <trn-radio-group layout="segmented" variant="accent" size="md" [options]="options" />
    <button trnToggle variant="neutral" presentation="outline" size="lg">Toggle</button>
    <trn-toggle-group variant="accent" presentation="plain" size="sm" arrangement="joined">
      <button trnToggleGroupItem value="all">All</button>
    </trn-toggle-group>
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
  imports: [TrnToggleDirective],
  template: \`<button trnToggle variant="danger" presentation="solid" size="xl">Toggle</button>\`,
})
export class InvalidToggleHost {}

@Component({
  imports: [TrnToggleGroupComponent],
  template: \`<trn-toggle-group arrangement="packed" orientation="diagonal" />\`,
})
export class InvalidToggleGroupHost {}

@Component({
  imports: [TrnRadioGroupComponent, TrnToggleGroupComponent],
  template: \`
    <trn-radio-group variant="segmented" [options]="options" />
    <trn-toggle-group variant="outline" size="default" />
  \`,
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
    expect(errors.map(({ code }) => code)).toEqual(Array(15).fill(2322));

    for (const unsupported of [
      'danger',
      'warning',
      'grid',
      'solid',
      'xl',
      'packed',
      'diagonal',
      'segmented',
      'outline',
      'default',
    ]) {
      expect(messages, unsupported).toEqual(
        expect.arrayContaining([expect.stringContaining(`"${unsupported}"`)]),
      );
    }
  });

  it('composes toggle-group behavior without Helm visual classes', () => {
    const sources = [
      'libs/components/controls/src/lib/toggle-group/trn-toggle-group.component.ts',
      'libs/components/controls/src/lib/toggle-group/trn-toggle-group-item.directive.ts',
    ].map((file) =>
      withoutCodeComments(readFileSync(join(workspaceRoot, file), 'utf8')),
    );
    const imports = sources.flatMap((file) =>
      [...file.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(
        ([, specifier]) => specifier,
      ),
    );

    expect(imports.length).toBeGreaterThan(0);
    expect(
      sources.every((file) =>
        file.includes("from '@spartan-ng/brain/toggle-group'"),
      ),
    ).toBe(true);
    expect(imports).not.toContain('@trinity/helm/toggle-group');
  });

  it('keeps catalog toggle consumers free of appearance overrides', () => {
    const template = readFileSync(
      join(
        workspaceRoot,
        'libs/components/controls/src/lib/control-recipe-matrix.stories.ts',
      ),
      'utf8',
    );
    const controlTags = [
      ...withoutHtmlComments(template).matchAll(/<button\b[^>]*>/gu),
    ]
      .map(([tag]) => tag)
      .filter((tag) => /\b(?:trnToggle|trnToggleGroupItem)\b/u.test(tag));

    expect(controlTags.some((tag) => /\btrnToggleGroupItem\b/u.test(tag))).toBe(
      true,
    );
    expect(controlTags.some((tag) => /\btrnToggle\b/u.test(tag))).toBe(true);
    for (const tag of controlTags) {
      expect(tag).not.toMatch(/\btrnIconButton\b/u);
      expect(tag).not.toMatch(/(?:\bclass|\bstyle|\[class|\[style)\s*[=.]/u);
    }
  });
});
