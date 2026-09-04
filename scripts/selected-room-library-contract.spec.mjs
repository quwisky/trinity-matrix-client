import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const selectedImplementation =
  'libs/data-access/room-library/src/lib/selected-room-library.service.ts';
const selectedProjection =
  'libs/data-access/room-library/src/lib/selected-room-library-projection.ts';
const roomLibraryLifetime =
  'libs/data-access/room-library/src/lib/room-library-lifetime.ts';
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

const selectedConsumers = [
  roomLibraryLifetime,
  'libs/data-access/room-library/src/lib/room-library-search.service.ts',
  'libs/feature/rooms/src/lib/account-picker/account-picker.component.ts',
  'libs/feature/rooms/src/lib/channel-sidebar/channel-sidebar.component.ts',
  'libs/feature/rooms/src/lib/rooms/account-routing.service.ts',
  'libs/feature/rooms/src/lib/rooms/room-actions.service.ts',
  'libs/feature/rooms/src/lib/rooms/room-shell-navigation.service.ts',
  'libs/feature/rooms/src/lib/rooms/room-shell-view-model.ts',
  'libs/feature/rooms/src/lib/rooms/rooms.page.ts',
  'libs/feature/rooms/src/lib/shared/account-badges.service.ts',
];

/** Freeze the contracted selected Room Library boundary after #374. */
describe('Selected Room Library boundary', () => {
  it('makes local search a complete selected-view consumer', () => {
    const search = source(searchImplementation);

    expect(search).toContain('inject(SelectedRoomLibraryService)');
    expect(search).toContain('const view = this.selected.view()');
    expect(search).not.toMatch(
      /\b(?:AccountScopeService|InvitesService|MixedRoomsService|MixedSpacesService|RoomLibraryService|SpacesService)\b/u,
    );
  });

  it('keeps one Account-source registry inside the selected implementation', () => {
    const selected = source(selectedImplementation);
    const projection = source(selectedProjection);

    expect(selected).toContain('const accountIds = this.scope.selected()');
    expect(selected).toContain('new SelectedAccountSourceRegistry(');
    expect(selected).toContain('this.sources.reconcile(accountIds)');
    expect(projection).toContain('class SelectedAccountSourceRegistry');
    expect(projection).toContain('current !== source.client');
    expect(projection).toContain('projectSelectedRooms(');
    expect(projection).toContain('projectSelectedSpaces(');
    expect(projection).toContain('projectSelectedInvitations(');
  });

  it('removes legacy mixed implementations, exports, and callers', () => {
    const legacySymbols = /\bMixed(?:Rooms|Spaces|Invites)Service\b/u;
    const consumers = productionSources.filter((file) =>
      legacySymbols.test(source(file)),
    );
    const legacyFiles = ['rooms', 'spaces', 'invites'].map(
      (domain) =>
        `libs/data-access/room-library/src/lib/mixed-${domain}.service.ts`,
    );

    expect(consumers).toEqual([]);
    expect(
      legacyFiles.filter((file) => existsSync(join(workspaceRoot, file))),
    ).toEqual([]);
    expect(source('libs/data-access/room-library/src/index.ts')).not.toMatch(
      /mixed-(?:rooms|spaces|invites)\.service/u,
    );
  });

  it('keeps page fan-out and source-choice branching out of every selected caller', () => {
    const page = source('libs/feature/rooms/src/lib/rooms/rooms.page.ts');
    const viewModel = source(
      'libs/feature/rooms/src/lib/rooms/room-shell-view-model.ts',
    );
    const actualConsumers = productionSources.filter((file) =>
      source(file).includes('inject(SelectedRoomLibraryService)'),
    );
    const sourceChoice =
      /(?:view(?:\(\))?\.mode|mixedOn\(\)|mixing\(\))[\s\S]{0,200}(?:\.rooms\(\)|\.spaces\(\)|\.pendingInvites\(\))|(?:\.rooms\(\)|\.spaces\(\)|\.pendingInvites\(\))[\s\S]{0,200}(?:view(?:\(\))?\.mode|mixedOn\(\)|mixing\(\))/u;

    expect(actualConsumers).toEqual(selectedConsumers);
    for (const consumer of actualConsumers) {
      expect(source(consumer)).not.toContain('inject(AccountScopeService)');
      expect(source(consumer)).not.toMatch(sourceChoice);
    }
    expect(page).not.toContain('AccountScopeService');
    expect(page).not.toContain('.setAccounts(');
    expect(viewModel).toContain('inject(SelectedRoomLibraryService)');
    expect(viewModel).not.toMatch(
      /inject\((?:SpacesService|InvitesService)\)/u,
    );
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

  it('keeps selected sources inside the named Room Library lifetime', () => {
    const selected = source(selectedImplementation);
    const lifetime = source(roomLibraryLifetime);
    const page = source('libs/feature/rooms/src/lib/rooms/rooms.page.ts');

    expect(selected).toContain('connect(): void');
    expect(selected).toContain('disconnect(): void');
    expect(lifetime).toContain('class RoomLibraryLifetime');
    expect(lifetime).toContain("waitFor({ kind: 'active-account' })");
    expect(lifetime).toContain('this.selected.connect()');
    expect(lifetime).toContain('this.selected.disconnect()');
    expect(page).not.toMatch(
      /this\.(?:rooms|spaces|invites|spaceChildren)\.connect\(\)/u,
    );
  });
});
