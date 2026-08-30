import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const productionSources = globSync(
  ['apps/**/*.ts', 'libs/**/*.ts', 'electron/**/*.ts'],
  { cwd: workspaceRoot },
)
  .filter(
    (file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec-harness.ts'),
  )
  .sort();

const source = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/** Parse real static, side-effect, re-export, and dynamic imports without comment/string decoys. */
function importedModules(contents, fileName = 'source.ts') {
  const parsed = ts.createSourceFile(
    fileName,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const modules = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return modules;
}

const importing = (pattern, candidates = productionSources) =>
  candidates.filter((file) =>
    importedModules(source(file), file).some((module) => pattern.test(module)),
  );

describe('final architecture boundaries', () => {
  it('contains Capacitor and native-plugin packages in platform-native', () => {
    const outsidePlatform = productionSources.filter(
      (file) => !file.startsWith('libs/platform-native/'),
    );
    expect(
      importing(
        /^(?:@capacitor\/|@aparajita\/capacitor-|@capawesome\/capacitor-)/,
        outsidePlatform,
      ),
    ).toEqual([]);
  });

  it('keeps Router out of product data-access, kernels, and utilities', () => {
    const contained = productionSources.filter((file) =>
      /^(?:libs\/(?:data-access|runtime|util)\/)/.test(file),
    );
    expect(importing(/^@angular\/router$/, contained)).toEqual([]);
  });

  it('keeps Matrix SDK imports out of applications, features, and UI', () => {
    const consumers = productionSources.filter((file) =>
      /^(?:apps\/|libs\/(?:application|components|feature|runtime|spartan)\/)/.test(
        file,
      ),
    );
    expect(importing(/^matrix-js-sdk(?:\/.*)?$/, consumers)).toEqual([]);
  });

  it('does not restore contracted compatibility entrypoints or message adapters', () => {
    const allProduction = productionSources.map(source).join('\n');
    const paths = source('tsconfig.base.json');

    expect(paths).not.toContain('@trinity/platform-native/qr-code');
    expect(allProduction).not.toMatch(/\bsafeBuildLegacyMessageView\b/);
    expect(allProduction).not.toMatch(/\bbuildLegacyMessageView\b/);
    expect(allProduction).not.toMatch(/\bLegacyMessageView\b/);
  });

  it('recognizes import forms while ignoring comments and string decoys', () => {
    expect(
      importedModules(`
        // import '@capacitor/camera';
        const decoy = "import('@angular/router')";
        import '@capacitor/preferences';
        export { Router } from '@angular/router';
        void import('matrix-js-sdk/lib/client');
      `),
    ).toEqual([
      '@capacitor/preferences',
      '@angular/router',
      'matrix-js-sdk/lib/client',
    ]);
  });
});
