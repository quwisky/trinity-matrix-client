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

/** The completed #378–#380 contraction has no compatibility caller allowlist.
 * Include specs: setting implementation state in a fixture would bypass the same
 * transitions production callers must use. Behavioral tests and the typecheck gate
 * verify read-only signals, focus, Back, reset, and reveal ordering without pinning
 * the implementation's signal constructors or scheduling operators here.
 */
describe('Room surface lifecycle boundary', () => {
  const lifecycleFile = `${featureRoot}/room-surface-lifecycle.ts`;

  it('exposes read-only state and one synchronous transition', () => {
    const lifecycle = source(lifecycleFile);

    expect(publicMethods(lifecycleFile, 'RoomSurfaceLifecycle')).toEqual([
      'transition',
    ]);
    expect(lifecycle).not.toContain('export interface RoomSurfaceState');
    expect(lifecycle).not.toContain('readonly state =');
    expect(lifecycle).not.toContain('readonly surface =');
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
    expect(page).not.toContain('this.workspace.eventTarget()');
  });

  it('keeps every Room surface and its browser lifecycle out of the shell store and page', () => {
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

  it('keeps legacy surface compatibility usage at zero, including tests and templates', () => {
    const callers = globSync(['apps/**/*.{ts,html}', 'libs/**/*.{ts,html}'], {
      cwd: workspaceRoot,
    });
    expect(
      callers.filter((file) =>
        /\b(?:rightPanel|messageSearchTarget|jumpRequest|membersOpen)\b/u.test(
          source(file),
        ),
      ),
    ).toEqual([]);
  });

  it('keeps all surface and jump writes inside the implementation, including test setup', () => {
    const callers = globSync(`${featureRoot}/**/*.{ts,html}`, {
      cwd: workspaceRoot,
    }).filter((file) => file !== lifecycleFile);
    expect(
      callers.filter((file) =>
        /\b(?:writableState|membersRequested|revealGeneration)\b|\b(?:renderedSurface|jumpTarget|jumpRevision|membersVisible|membersAreDrawer)\s*\.\s*(?:set|update)\s*\(/u.test(
          source(file),
        ),
      ),
    ).toEqual([]);
  });
});
