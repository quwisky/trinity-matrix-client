import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const implementation = 'libs/feature/rooms/src/lib/rooms/workspace.service.ts';
const expectedLegacyCallers = [];

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

function callsLegacyOpen(file, contents) {
  const parsed = ts.createSourceFile(
    file,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  const serviceNames = new Set(['WorkspaceService']);
  const bindings = new Set();

  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const element of imports.elements) {
      if ((element.propertyName ?? element.name).text === 'WorkspaceService') {
        serviceNames.add(element.name.text);
      }
    }
  }

  function isWorkspaceType(type) {
    return (
      type &&
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      serviceNames.has(type.typeName.text)
    );
  }

  function isWorkspaceInjection(initializer) {
    return (
      initializer &&
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === 'inject' &&
      (initializer.arguments.some(
        (argument) =>
          ts.isIdentifier(argument) && serviceNames.has(argument.text),
      ) ||
        initializer.typeArguments?.some(isWorkspaceType))
    );
  }

  function collectBindings(node) {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      (isWorkspaceType(node.type) || isWorkspaceInjection(node.initializer))
    ) {
      bindings.add(node.name.text);
    }
    ts.forEachChild(node, collectBindings);
  }
  collectBindings(parsed);

  let found = false;
  function findOpen(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'open'
    ) {
      const receiver = node.expression.expression;
      found =
        (ts.isIdentifier(receiver) && bindings.has(receiver.text)) ||
        (ts.isPropertyAccessExpression(receiver) &&
          receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
          bindings.has(receiver.name.text));
    }
    if (!found) ts.forEachChild(node, findOpen);
  }
  findOpen(parsed);
  return found;
}

/**
 * Freeze the expand-migrate-contract boundary introduced by #366.
 *
 * Room-shell, search, notification activation, and inbound restoration all use semantic
 * intent. Issue #369 removes the now-internal destination implementation. Any external
 * `workspace.open()` call is a regression.
 */
describe('Workspace semantic navigation boundary', () => {
  const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
    cwd: workspaceRoot,
  })
    .filter(
      (file) =>
        file !== implementation &&
        !file.endsWith('.spec.ts') &&
        !file.endsWith('.spec-harness.ts'),
    )
    .sort();

  it('keeps the legacy caller allowlist empty outside Workspace', () => {
    const legacyCallers = productionSources
      .filter((file) => source(file).includes('WorkspaceService'))
      .filter((file) => callsLegacyOpen(file, source(file)));

    expect(legacyCallers).toEqual(expectedLegacyCallers);
  });

  it('recognizes aliased and constructor-injected compatibility calls', () => {
    expect(
      callsLegacyOpen(
        'fixture.ts',
        `import { WorkspaceService as Navigation } from './workspace.service';
         class Consumer {
           constructor(private readonly facade: Navigation) {}
           run() { return this.facade.open(destination, options); }
         }`,
      ),
    ).toBe(true);
    expect(
      callsLegacyOpen(
        'fixture.ts',
        `import { WorkspaceService as Navigation } from './workspace.service';
         const facade = inject(Navigation);
         facade.open(destination, options);`,
      ),
    ).toBe(true);
  });

  it('keeps exact Room-row ownership on the semantic path', () => {
    const row = source(
      'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-list.component.html',
    );
    const routing = source(
      'libs/feature/rooms/src/lib/rooms/account-routing.service.ts',
    );
    const shortcuts = source(
      'libs/feature/rooms/src/lib/rooms/shell-shortcuts.service.ts',
    );

    expect(row).toContain(
      'selectRoom.emit({ roomId: room.id, accountId: room.accountId })',
    );
    expect(routing).toContain(
      "origin: WorkspaceRoomNavigationOrigin = 'room-list'",
    );
    expect(routing).toContain("{ kind: 'room', ...selection, origin }");
    expect(shortcuts).toContain('accountId: room.accountId');
    expect(routing).toContain('this.workspace\n      .navigate(intent)');
    expect(source(implementation)).toContain(
      'export class WorkspaceService implements WorkspaceNavigation',
    );
  });

  it('keeps search and notification activation on the semantic path', () => {
    const shortcuts = source(
      'libs/feature/rooms/src/lib/rooms/shell-shortcuts.service.ts',
    );
    const session = source(
      'libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts',
    );

    expect(shortcuts).toContain('this.workspace.navigate(selection)');
    expect(source(implementation)).not.toContain('openSearchIntent(');
    expect(source(implementation)).toContain("kind: 'restoration'");
    expect(session).toContain('this.workspaceNavigation.navigate(intent)');
    expect(session).not.toContain('encodeRoomSegment');
  });

  it('records the internal legacy seam and its removal owner in the Workspace ADR', () => {
    const adr = source(
      'docs/adr/0004-workspace-authority-and-url-projection.md',
    );

    expect(adr).toContain('zero production callers');
    expect(adr).toContain('#368');
    expect(adr).toContain('#369');
  });
});
