import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const roomLibraryEntrypoint = 'libs/data-access/room-library/src/index.ts';
const legacyRoomsEntrypoint = 'libs/data-access/rooms/src/index.ts';

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

/**
 * Freeze #317's completed expand-contract migration.
 *
 * Room Library has one explicit entrypoint. The old broad rooms barrel now exposes only
 * remote-discovery adapters, so a moved room-graph symbol appearing there
 * again would silently reopen the migration allowlist this ticket reduced to zero.
 */
describe('Room Library production boundary', () => {
  it('owns the room graph through one capability entrypoint', () => {
    const entrypoint = source(roomLibraryEntrypoint);

    expect(entrypoint).toContain("export * from './lib/room-library.service'");
    expect(entrypoint).toContain("export * from './lib/spaces.service'");
    expect(entrypoint).toContain("export * from './lib/invites.service'");
    expect(entrypoint).toContain(
      "export * from './lib/unread-aggregator.service'",
    );
    expect(source('tsconfig.base.json')).toContain(
      '"@trinity/data-access/room-library"',
    );
  });

  it('keeps the former room-graph export and caller allowlist empty', () => {
    const movedSymbols =
      /\b(?:RoomLibraryService|SpacesService|SpaceChildrenService|SpaceRoomOrderService|AccountScopeService|MixedRoomsService|MixedSpacesService|InvitesService|MixedInvitesService|UnreadAggregatorService)\b/;
    const legacyImport =
      /import\s*(?:type\s*)?{([^}]*)}\s*from\s*['"]@trinity\/data-access\/rooms['"]/gs;
    const offenders = productionSources.filter((file) => {
      const contents = source(file);
      return [...contents.matchAll(legacyImport)].some((match) =>
        movedSymbols.test(match[1]),
      );
    });

    expect(offenders).toEqual([]);
    expect(source(legacyRoomsEntrypoint)).not.toMatch(movedSymbols);
    expect(source('tsconfig.base.json')).not.toContain(
      '"@trinity/data-access/invites"',
    );
    expect(
      existsSync(join(workspaceRoot, 'libs/data-access/invites/project.json')),
    ).toBe(false);
  });

  it('keeps Workspace selection on typed Room Library projections', () => {
    const workspace = source(
      'libs/feature/rooms/src/lib/rooms/workspace.service.ts',
    );
    const transition = source(
      'libs/feature/rooms/src/lib/rooms/workspace-transition.workflow.ts',
    );

    expect(workspace).toContain("from '@trinity/data-access/room-library'");
    expect(workspace).not.toContain("from '@trinity/data-access/rooms'");
    expect(workspace).not.toContain("from 'matrix-js-sdk");
    expect(workspace).not.toContain('MatrixClientService');
    expect(transition).not.toContain('MatrixClientService');
    expect(transition).toContain('this.rooms.selectionAvailability(');
    expect(transition).not.toContain('selectionAvailability?.(');
    expect(workspace).not.toContain('selectionAvailability?.(');
    expect(workspace).toMatch(
      /this\.rooms\s*\.\s*clearMarkedUnread\(view\.roomId\)/,
    );
    expect(workspace).toContain('.openSpace(view.scope.kind');
  });
});
