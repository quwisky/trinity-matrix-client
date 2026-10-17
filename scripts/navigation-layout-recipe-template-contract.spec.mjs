import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileStrictTemplate } from './strict-template-compile.mjs';

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

describe('navigation and layout recipe strict-template contract', () => {
  it('accepts canonical inputs while rejecting unsupported or retired values', () => {
    const errors = compileStrictTemplate(
      source,
      'navigation-layout-recipe-template.fixture.ts',
    );
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
