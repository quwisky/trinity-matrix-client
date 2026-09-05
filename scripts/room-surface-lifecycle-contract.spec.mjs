import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const featureRoot = 'libs/feature/rooms/src/lib/rooms';

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
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

/** Freeze the #378/#379 single Room-surface lifecycle boundary. */
describe('Room surface lifecycle boundary', () => {
  const lifecycleFile = `${featureRoot}/room-surface-lifecycle.ts`;

  it('exposes read-only state and one synchronous transition', () => {
    const lifecycle = source(lifecycleFile);

    expect(publicMethods(lifecycleFile, 'RoomSurfaceLifecycle')).toEqual([
      'transition',
    ]);
    expect(lifecycle).toContain('readonly state = computed(');
    expect(lifecycle).toContain('readonly surface = computed(');
    expect(lifecycle).toContain('readonly renderedSurface = computed<');
    expect(lifecycle).toContain('WorkspaceBackService).register({');
    expect(lifecycle).toContain('afterNextRender(');
  });

  it('routes every message-surface caller through the lifecycle', () => {
    const lifecycle = source(lifecycleFile);
    const messageActions = source(`${featureRoot}/message-actions.service.ts`);
    const accountRouting = source(`${featureRoot}/account-routing.service.ts`);
    const page = source(`${featureRoot}/rooms.page.ts`);
    const template = source(`${featureRoot}/rooms.page.html`);

    for (const caller of [messageActions, accountRouting]) {
      expect(caller).toContain('RoomSurfaceLifecycle');
      expect(caller).not.toContain('.rightPanel');
      expect(caller).not.toContain('.messageSearchTarget');
      expect(caller).not.toContain('.jumpRequest');
    }
    expect(template).toContain('roomSurfaces.renderedSurface()');
    expect(template).toContain('roomSurfaces.jumpTarget()');
    expect(template).toContain('roomSurfaces.jumpRevision()');
    expect(template).not.toContain('store.rightPanel()');
    expect(lifecycle).toContain('this.workspace.eventTarget()');
    expect(lifecycle).toContain('untracked(() =>');
    expect(page).not.toContain('this.workspace.eventTarget()');
  });

  it('keeps every Room surface and its browser lifecycle out of the shell store and page', () => {
    const productionSources = globSync(`${featureRoot}/**/*.ts`, {
      cwd: workspaceRoot,
    }).filter(
      (file) =>
        !file.endsWith('.spec.ts') && !file.endsWith('.spec-harness.ts'),
    );
    const writers = productionSources
      .filter((file) => /\.rightPanel\.(?:set|update)\(/u.test(source(file)))
      .sort();

    expect(writers).toEqual([]);
    const store = source(`${featureRoot}/room-shell-store.ts`);
    expect(store).not.toContain('rightPanel');
    expect(store).not.toContain('membersOpen');

    const page = source(`${featureRoot}/rooms.page.ts`);
    expect(page).not.toContain('WorkspaceBackService');
    expect(page).not.toContain('BELOW_MEMBERS_QUERY');
    expect(page).not.toContain('manageRightPanelFocus');
    expect(page).not.toContain('activeWorkspaceSurface');

    const memberActions = source(`${featureRoot}/member-actions.service.ts`);
    expect(memberActions).toContain('RoomSurfaceLifecycle');
    expect(memberActions).toContain("kind: 'open-member'");
  });
});
