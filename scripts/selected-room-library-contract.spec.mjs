import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const selectedImplementation =
  'libs/data-access/room-library/src/lib/selected-room-library.service.ts';
const searchImplementation =
  'libs/data-access/room-library/src/lib/room-library-search.service.ts';

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter(
    (file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec-harness.ts'),
  )
  .sort();

/** Freeze the expand-migrate boundary until #372-#373 remove its legacy consumers. */
describe('Selected Room Library boundary', () => {
  it('makes local search a complete selected-view consumer', () => {
    const search = source(searchImplementation);

    expect(search).toContain('inject(SelectedRoomLibraryService)');
    expect(search).toContain('const view = this.selected.view()');
    expect(search).not.toMatch(
      /\b(?:AccountScopeService|InvitesService|MixedRoomsService|MixedSpacesService|RoomLibraryService|SpacesService)\b/u,
    );
  });

  it('keeps Account-source observation inside the selected implementation', () => {
    const selected = source(selectedImplementation);

    expect(selected).toContain('const accountIds = this.scope.selected()');
    expect(selected.match(/\.setAccounts\(accountIds\)/gu)).toHaveLength(3);
  });

  it('leaves legacy mixed projections only in deferred action paths', () => {
    const legacyImport =
      /import\s*{[^}]*\bMixed(?:Rooms|Spaces|Invites)Service\b[^}]*}\s*from\s*['"]@trinity\/data-access\/room-library['"]/s;
    const consumers = productionSources
      .filter((file) => file !== selectedImplementation)
      .filter((file) => legacyImport.test(source(file)));

    expect(consumers).toEqual([
      'libs/feature/rooms/src/lib/rooms/invite-actions.service.ts',
      'libs/feature/rooms/src/lib/rooms/room-shell-navigation.service.ts',
    ]);
  });

  it('registers capability-owned selection persistence', () => {
    const scope = source(
      'libs/data-access/room-library/src/lib/account-scope.service.ts',
    );
    const providers = source(
      'libs/application/runtime/src/lib/composition/application-capability.providers.ts',
    );

    expect(scope).toContain("id: 'room-library.selected-accounts'");
    expect(scope).toContain('PreferenceStoreService');
    expect(scope).not.toContain('DevicePreferenceStorageService');
    expect(providers).toContain('provideRoomLibraryPreferences()');
  });
});
