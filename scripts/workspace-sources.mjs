import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';

export const workspaceRoot = join(import.meta.dirname, '..');

/** Read a workspace-relative file as UTF-8 text. */
export const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/** Parse `.github/workflows/<name>` (a fresh object per call, safe to mutate). */
export const workflow = (name) => parse(read(`.github/workflows/${name}`));

/** File names under `.github/workflows`, sorted. */
export const workflows = () =>
  readdirSync(join(workspaceRoot, '.github/workflows')).sort();

const applicationSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
});

/** Sorted app and library TypeScript without specs and spec harnesses. */
export const productionSources = applicationSources
  .filter(
    (file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec-harness.ts'),
  )
  .sort();

/** Like `productionSources` but spec harnesses stay in the sweep (ownership freezes). */
export const sourcesWithHarnesses = applicationSources
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

/** Names of the non-private, non-protected methods declared by `className` in `file`. */
export function publicMethods(file, className) {
  const parsed = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = parsed.statements.find(
    (statement) =>
      ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!declaration || !ts.isClassDeclaration(declaration)) return [];
  return declaration.members
    .filter(ts.isMethodDeclaration)
    .filter(
      (member) =>
        !member.modifiers?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword,
        ),
    )
    .map((member) => member.name.getText(parsed));
}
