import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileStrictTemplate } from './strict-template-compile.mjs';

const workspaceRoot = join(import.meta.dirname, '..');

function stripComments(sourceText) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText,
  );
  let result = '';
  let copiedThrough = 0;
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    result += sourceText.slice(copiedThrough, scanner.getTokenPos());
    copiedThrough = scanner.getTextPos();
  }
  return result + sourceText.slice(copiedThrough);
}

const source = `
import { Component } from '@angular/core';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';

@Component({
  imports: [
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuTrigger,
    TrnOverlaySurfaceDirective,
  ],
  template: \`
    <section trnOverlaySurface variant="neutral" size="sm" layout="dialog"></section>
    <section trnOverlaySurface variant="accent" size="xl" layout="fullscreen"></section>
    <section trnOverlaySurface variant="neutral" size="2xl" layout="workspace"></section>
    <button [trnDropdownMenuTrigger]="menu" side="top" align="center">Open</button>
    <ng-template #menu>
      <div trnDropdownMenu>
        <button trnDropdownMenuItem variant="danger">Delete</button>
      </div>
    </ng-template>
  \`,
})
export class ValidOverlayRecipeHost {}

@Component({
  imports: [TrnOverlaySurfaceDirective],
  template: \`<section trnOverlaySurface variant="danger" size="xs" layout="drawer"></section>\`,
})
export class InvalidSurfaceHost {}

@Component({
  imports: [TrnDropdownMenuItem],
  template: \`<button trnDropdownMenuItem variant="warning">Unsupported item</button>\`,
})
export class InvalidItemHost {}

@Component({
  imports: [TrnDropdownMenuItem],
  template: \`<button trnDropdownMenuItem variant="destructive">Retired item</button>\`,
})
export class InvalidLegacyItemHost {}

@Component({
  imports: [TrnDropdownMenuTrigger],
  template: \`<button [trnDropdownMenuTrigger]="null" side="diagonal" align="stretch">Unsupported trigger</button>\`,
})
export class InvalidTriggerHost {}
`;

describe('overlay recipe strict-template contract', () => {
  it('accepts canonical inputs while rejecting unsupported or retired values', () => {
    const errors = compileStrictTemplate(
      source,
      'overlay-recipe-template.fixture.ts',
    );
    const messages = errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors.map(({ code }) => code)).toEqual(Array(7).fill(2322));
    for (const value of [
      'danger',
      'xs',
      'drawer',
      'warning',
      'diagonal',
      'stretch',
      'destructive',
    ]) {
      expect(messages).toEqual(
        expect.arrayContaining([expect.stringContaining(value)]),
      );
    }
  });

  it('keeps vendor configuration and recipe-library types private', () => {
    const entrypoint = stripComments(
      readFileSync(
        join(workspaceRoot, 'libs/components/overlay/src/index.ts'),
        'utf8',
      ),
    );
    const dialog = stripComments(
      readFileSync(
        join(
          workspaceRoot,
          'libs/components/overlay/src/lib/dialog/trn-dialog.service.ts',
        ),
        'utf8',
      ),
    );
    const alert = stripComments(
      readFileSync(
        join(
          workspaceRoot,
          'libs/components/overlay/src/lib/alert/trn-alert.service.ts',
        ),
        'utf8',
      ),
    );

    expect(entrypoint).not.toMatch(
      /@trinity\/helm|@spartan-ng|VariantProps|ClassValue|DialogConfig|ComponentType|MenuSide|MenuAlign|ToasterProps/u,
    );
    expect(dialog).not.toMatch(/import[^;\n]*(?:DialogConfig|ComponentType)/u);
    expect(dialog).not.toContain('side?:');
    expect(dialog).toContain('type Type');
    expect(dialog).toContain('openAndWait$');
    expect(dialog).not.toMatch(/\bopenAndWait\s*\(/u);
    expect(alert).toContain('confirm$');
    expect(alert).toContain('prompt$');
    expect(alert).not.toMatch(/\bconfirm\s*\(/u);
    expect(alert).not.toMatch(/\bprompt\s*\(/u);
  });
});
