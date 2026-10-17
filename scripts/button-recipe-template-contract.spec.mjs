import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileStrictTemplate } from './strict-template-compile.mjs';

const source = `
import { Component } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';

@Component({
  imports: [TrnButton],
  template: \`
    <button trnBtn variant="primary" size="md">Primary</button>
    <button trnBtn variant="danger" size="md">Danger</button>
    <button trnBtn variant="primary" presentation="ghost" shape="icon" size="md">Icon</button>
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

@Component({
  imports: [TrnButton],
  template: \`
    <button trnBtn variant="default" size="default">Old default</button>
    <button trnBtn variant="destructive" size="icon">Old danger</button>
    <button trnBtn variant="ghost">Old presentation</button>
  \`,
})
export class InvalidLegacyButtonHost {}
`;

describe('button recipe strict-template contract', () => {
  it('accepts canonical inputs and rejects unsupported or retired values', () => {
    const errors = compileStrictTemplate(
      source,
      'button-recipe-template.fixture.ts',
    );
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors.map(({ code }) => code)).toEqual(Array(7).fill(2322));
    for (const unsupported of [
      'success',
      'xl',
      'default',
      'destructive',
      'icon',
      'ghost',
    ]) {
      expect(messages, unsupported).toEqual(
        expect.arrayContaining([expect.stringContaining(`"${unsupported}"`)]),
      );
    }
  });
});
