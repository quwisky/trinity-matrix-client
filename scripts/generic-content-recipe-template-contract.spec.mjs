import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import ts from 'typescript';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

const source = `
import { Component } from '@angular/core';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  AvatarComponent,
  BannerComponent,
  EmptyStateComponent,
  TrnBadge,
  TrnProgressComponent,
  TrnSpinnerComponent,
  TrnTooltip,
} from '@trinity/components/generic-content';

@Component({
  imports: [
    AvatarComponent,
    BannerComponent,
    EmptyStateComponent,
    TrnBadge,
    TrnIconComponent,
    TrnProgressComponent,
    TrnSpinnerComponent,
    TrnTooltip,
  ],
  template: \`
    <trn-icon name="lock" size="lg" variant="muted" />
    <trn-avatar name="Ada" initial="A" size="xl" />
    <trn-avatar name="Ada" initial="A" size="sm" [exactSize]="64" />
    <span trnBadge variant="neutral" size="sm">Neutral</span>
    <trn-banner variant="accent">Attention</trn-banner>
    <trn-empty-state variant="danger" layout="line" body="Failed" />
    <trn-progress variant="success" size="md" [value]="40" />
    <trn-progress variant="accent" size="sm" [value]="null" />
    <trn-spinner variant="accent" size="lg" />
    <trn-spinner />
    <button trnTooltip="Members" position="right">Members</button>
  \`,
})
export class ValidGenericContentRecipeHost {}

@Component({ imports: [TrnIconComponent], template: \`<trn-icon name="lock" size="3xl" />\` })
export class InvalidIconSizeHost {}
@Component({ imports: [TrnIconComponent], template: \`<trn-icon name="lock" variant="primary" />\` })
export class InvalidIconVariantHost {}
@Component({ imports: [AvatarComponent], template: \`<trn-avatar size="3xl" />\` })
export class InvalidAvatarSizeHost {}
@Component({ imports: [TrnBadge], template: \`<span trnBadge variant="danger">No</span>\` })
export class InvalidBadgeVariantHost {}
@Component({ imports: [TrnBadge], template: \`<span trnBadge size="lg">No</span>\` })
export class InvalidBadgeSizeHost {}
@Component({ imports: [BannerComponent], template: \`<trn-banner variant="danger">No</trn-banner>\` })
export class InvalidBannerVariantHost {}
@Component({ imports: [EmptyStateComponent], template: \`<trn-empty-state variant="accent" />\` })
export class InvalidEmptyStateVariantHost {}
@Component({ imports: [EmptyStateComponent], template: \`<trn-empty-state layout="md" />\` })
export class InvalidEmptyStateLayoutHost {}
@Component({ imports: [TrnProgressComponent], template: \`<trn-progress variant="neutral" />\` })
export class InvalidProgressVariantHost {}
@Component({ imports: [TrnProgressComponent], template: \`<trn-progress size="lg" />\` })
export class InvalidProgressSizeHost {}
@Component({ imports: [TrnSpinnerComponent], template: \`<trn-spinner variant="success" />\` })
export class InvalidSpinnerVariantHost {}
@Component({ imports: [TrnSpinnerComponent], template: \`<trn-spinner size="xl" />\` })
export class InvalidSpinnerSizeHost {}
@Component({ imports: [TrnTooltip], template: \`<button trnTooltip="No" position="above">No</button>\` })
export class InvalidTooltipPositionHost {}

@Component({
  imports: [AvatarComponent, BannerComponent, EmptyStateComponent, TrnBadge, TrnIconComponent],
  template: \`
    <trn-icon name="lock" size="1.25rem" />
    <trn-avatar name="Ada" [size]="36" />
    <span trnBadge variant="default">Old badge</span>
    <trn-banner [tone]="'accent'">Old banner</trn-banner>
    <trn-empty-state [tone]="'danger'" [size]="'line'" />
  \`,
})
export class InvalidLegacyGenericContentHost {}
`;

function compileTemplateContract() {
  const { options } = readConfiguration(
    join(workspaceRoot, 'tsconfig.base.json'),
  );
  options.noEmit = true;
  const fixture = join(
    workspaceRoot,
    'generic-content-recipe-template.fixture.ts',
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

describe('generic content recipe strict-template contract', () => {
  it('accepts canonical inputs while rejecting unsupported or retired values', () => {
    const errors = compileTemplateContract();
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors.map(({ code }) => code)).toEqual([
      ...Array(16).fill(2322),
      ...Array(3).fill(-998002),
    ]);
    for (const unsupported of [
      '3xl',
      'primary',
      'danger',
      'lg',
      'accent',
      'md',
      'neutral',
      'success',
      'xl',
      'above',
      '1.25rem',
      'default',
      'tone',
      'size',
    ]) {
      expect(messages, unsupported).toEqual(
        expect.arrayContaining([expect.stringContaining(unsupported)]),
      );
    }
  });
});
