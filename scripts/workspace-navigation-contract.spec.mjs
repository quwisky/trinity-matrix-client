import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const applicationRoot = 'libs/application/workspace/src/lib';
const featureRoot = 'libs/feature/rooms/src/lib/rooms';

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

function exists(file) {
  return existsSync(join(workspaceRoot, file));
}

function publicMethods(file, className) {
  const parsed = ts.createSourceFile(
    file,
    source(file),
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

function methodSource(file, className, methodName) {
  const parsed = ts.createSourceFile(
    file,
    source(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = parsed.statements.find(
    (statement) =>
      ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!declaration || !ts.isClassDeclaration(declaration)) {
    throw new Error(`${className} is missing from ${file}`);
  }
  const method = declaration.members.find(
    (member) =>
      ts.isMethodDeclaration(member) &&
      member.name.getText(parsed) === methodName,
  );
  if (!method || !ts.isMethodDeclaration(method)) {
    throw new Error(`${className}.${methodName} is missing from ${file}`);
  }
  return method.getText(parsed);
}

/** Freeze the completed #366-#369 expand-migrate-contract boundary. */
describe('Workspace semantic navigation boundary', () => {
  it('keeps one application-owned semantic command and no feature implementation', () => {
    const service = source(
      `${applicationRoot}/workspace-navigation.service.ts`,
    );

    expect(service).toContain('export class WorkspaceNavigationService');
    expect(
      publicMethods(
        `${applicationRoot}/workspace-navigation.service.ts`,
        'WorkspaceNavigationService',
      ),
    ).toEqual(['navigate']);
    expect(service).toContain('readonly view =');
    expect(service).not.toContain('register(');
    expect(service).not.toContain('WorkspaceNavigationActivator');
    expect(exists(`${featureRoot}/workspace.service.ts`)).toBe(false);
    expect(exists(`${featureRoot}/workspace-transition.workflow.ts`)).toBe(
      false,
    );
  });

  it('keeps Router access behind the internal Workspace location adapter', () => {
    const applicationSources = globSync(`${applicationRoot}/**/*.ts`, {
      cwd: workspaceRoot,
    }).filter((file) => !file.endsWith('.spec.ts'));
    const routerOwners = applicationSources.filter((file) =>
      source(file).includes("from '@angular/router'"),
    );

    expect(routerOwners).toEqual([
      `${applicationRoot}/workspace-location.adapter.ts`,
    ]);
  });

  it('removes the activation relay and caller-built destination API', () => {
    const publicModels = source(
      `${applicationRoot}/workspace-navigation.models.ts`,
    );
    const providers = source(
      'libs/application/runtime/src/lib/composition/trinity-application.providers.ts',
    );
    const entrypoint = source('libs/application/workspace/src/index.ts');
    const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
      cwd: workspaceRoot,
    }).filter(
      (file) =>
        !file.endsWith('.spec.ts') && !file.endsWith('.spec-harness.ts'),
    );

    expect(publicModels).not.toContain('interface WorkspaceNavigation');
    expect(publicModels).not.toContain('WorkspaceDestination');
    expect(entrypoint).not.toContain('workspace-visit-history.service');
    expect(entrypoint).not.toContain('workspace.models');
    expect(providers).not.toContain('WORKSPACE_NAVIGATION_ACTIVATOR');
    expect(
      exists(
        'libs/application/runtime/src/lib/composition/workspace-navigation.activator.ts',
      ),
    ).toBe(false);
    expect(
      productionSources.filter((file) =>
        source(file).includes('WorkspaceService'),
      ),
    ).toEqual([]);
    expect(
      productionSources
        .filter((file) => !file.startsWith(`${applicationRoot}/`))
        .filter((file) =>
          /Workspace(?:Destination|OpenOptions|OpenOutcome)/u.test(
            source(file),
          ),
        ),
    ).toEqual([]);
  });

  it('keeps Room-shell and notification callers on the semantic service', () => {
    const routing = source(`${featureRoot}/account-routing.service.ts`);
    const shell = source(`${featureRoot}/room-shell-navigation.service.ts`);
    const shortcuts = source(`${featureRoot}/shell-shortcuts.service.ts`);
    const notificationSession = source(
      'libs/application/runtime/src/lib/composition/notification-session.service.ts',
    );
    const back = source(`${applicationRoot}/workspace-back.service.ts`);
    const accountSession =
      'libs/feature/rooms/src/lib/rooms/session-actions.service.ts';

    for (const consumer of [routing, shell, shortcuts, notificationSession]) {
      expect(consumer).toContain('WorkspaceNavigationService');
      expect(consumer).not.toContain('WorkspaceService');
    }
    expect(routing).toContain('this.workspace\n      .navigate(intent)');
    expect(shortcuts).toContain('this.workspace.navigate(selection)');
    expect(notificationSession).toContain('this.navigation.navigate(intent)');
    expect(notificationSession).not.toContain('encodeRoomSegment');
    for (const consumer of [routing, shell, shortcuts, back]) {
      expect(consumer).not.toContain("from '@angular/router'");
    }
    expect(
      methodSource(
        'libs/application/runtime/src/lib/composition/notification-session.service.ts',
        'NotificationSessionService',
        'openIntent',
      ),
    ).not.toContain('this.router');
    expect(
      methodSource(
        `${featureRoot}/room-surface-lifecycle.ts`,
        'RoomSurfaceLifecycle',
        'dismissWorkspaceSurface',
      ),
    ).not.toContain('this.router');
    const switchAccount = methodSource(
      accountSession,
      'SessionActionsService',
      'switchAccount',
    );
    expect(switchAccount).toMatch(/this\.workspace\s*\.navigate/u);
    expect(switchAccount).not.toContain('this.router');
  });

  it('records the contracted boundary in the Workspace ADR', () => {
    const adr = source(
      'docs/adr/0004-workspace-authority-and-url-projection.md',
    );

    expect(adr).toContain('application-owned `WorkspaceNavigationService`');
    expect(adr).toContain('Router stays behind');
    expect(adr).not.toContain('issue #369 deletes');
  });
});
