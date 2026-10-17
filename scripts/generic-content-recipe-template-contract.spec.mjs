import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileStrictTemplate } from './strict-template-compile.mjs';

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
@Component({ imports: [TrnBadge], template: \`<span trnBadge variant="info">No</span>\` })
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

describe('generic content recipe strict-template contract', () => {
  it('accepts canonical inputs while rejecting unsupported or retired values', () => {
    const errors = compileStrictTemplate(
      source,
      'generic-content-recipe-template.fixture.ts',
    );
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
      'info',
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
