import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const implementation = 'libs/feature/rooms/src/lib/rooms/workspace.service.ts';
const expectedLegacyCallers = [
  'libs/feature/rooms/src/lib/rooms/account-routing.service.ts',
  'libs/feature/rooms/src/lib/rooms/room-shell-navigation.service.ts',
  'libs/feature/rooms/src/lib/rooms/rooms.page.ts',
  'libs/feature/rooms/src/lib/rooms/session-actions.service.ts',
];

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

/**
 * Freeze the expand-migrate-contract boundary introduced by #366.
 *
 * Room rows already use semantic intent. The four remaining direct `open` callers are
 * compatibility debt owned by #369; growing this list would move policy back out of
 * Workspace without making that architectural regression visible in review.
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

  it('freezes the legacy caller allowlist at four production files', () => {
    const legacyCallers = productionSources
      .filter((file) => source(file).includes('WorkspaceService'))
      .filter((file) => /\.\s*open\s*\(/s.test(source(file)));

    expect(legacyCallers).toEqual(expectedLegacyCallers);
  });

  it('keeps exact Room-row ownership on the semantic path', () => {
    const row = source(
      'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-list.component.html',
    );
    const routing = source(
      'libs/feature/rooms/src/lib/rooms/account-routing.service.ts',
    );

    expect(row).toContain(
      'selectRoom.emit({ roomId: room.id, accountId: room.accountId })',
    );
    expect(routing).toContain("origin: 'room-list'");
    expect(routing).toContain('this.workspace\n      .navigate({');
    expect(source(implementation)).toContain(
      'export class WorkspaceService implements WorkspaceNavigation',
    );
  });

  it('records the legacy counter and removal owner in the Workspace ADR', () => {
    const adr = source(
      'docs/adr/0004-workspace-authority-and-url-projection.md',
    );

    expect(adr).toContain('four production callers');
    expect(adr).toContain('#369');
  });
});
