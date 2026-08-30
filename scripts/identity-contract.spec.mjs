import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

/** Freeze #320's Identity expand-contract migration. */
describe('Identity production boundary', () => {
  it('owns user summaries, profiles, presence and ignore state through one entrypoint', () => {
    const entrypoint = source('libs/data-access/identity/src/index.ts');
    const paths = source('tsconfig.base.json');

    for (const module of [
      'identity.service',
      'account-identities.service',
      'identity-presence.service',
      'ignored-users.service',
      'identity-operation-error',
    ]) {
      expect(entrypoint).toContain(`export * from './lib/${module}'`);
    }
    expect(paths).toContain('"@trinity/data-access/identity"');
    expect(paths).not.toContain('"@trinity/data-access/profile"');
    expect(existsSync(join(workspaceRoot, 'libs/data-access/profile'))).toBe(
      false,
    );
  });

  it('depends on a lifecycle-free Matrix Identity port', () => {
    const identity = productionSources
      .filter((file) => file.startsWith('libs/data-access/identity/'))
      .map(source)
      .join('\n');
    const port = source(
      'libs/data-access/matrix-client/src/lib/identity-matrix.port.ts',
    );
    const activeView = port.match(
      /export interface ActiveIdentityMatrix \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;
    const projectionConfig = port.match(
      /export interface IdentityProjectionConfig \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(identity).toContain('IdentityMatrixPort');
    expect(identity).not.toContain('MatrixClientService');
    expect(identity).not.toMatch(/from ['"]matrix-js-sdk/);
    expect(port).not.toMatch(
      /\b(?:addAccount|removeAccount|switchAccount|startClient|stopClient|initRustCrypto)\b\s*\(/,
    );
    expect(activeView).toBeDefined();
    expect(activeView).not.toMatch(/\bMatrixClient\b/);
    expect(projectionConfig).toBeDefined();
    expect(projectionConfig).not.toMatch(/\bMatrixClient\b/);
    expect(projectionConfig).not.toContain('ProjectFromClientConfig');
  });

  it('keeps stable Identity presentation independent of Room membership', () => {
    const identity = source(
      'libs/data-access/identity/src/lib/identity.service.ts',
    );
    const roomLibrary = source(
      'libs/data-access/room-library/src/lib/room-library.service.ts',
    );
    const roomMembers = source(
      'libs/data-access/room-administration/src/lib/room-members.service.ts',
    );
    const userDirectory = source(
      'libs/data-access/discovery/src/lib/user-directory-discovery.service.ts',
    );

    expect(identity).toContain('export interface IdentitySummary');
    expect(identity).toContain('lookup(userId: string)');
    expect(identity).not.toMatch(/\bsearch\s*\(/);
    expect(identity).not.toContain('RoomMember');
    expect(userDirectory).toMatch(/search\(term: string(?:,|\))/);
    expect(roomLibrary).not.toContain('searchUserDirectory');
    expect(roomLibrary).not.toMatch(/\bsearchUsers\s*\(/);
    expect(roomMembers).toContain('roomDisplayName');
    expect(roomMembers).toContain('roomAvatarMxc');
    expect(roomMembers).toContain('powerLevel');
    expect(roomMembers).not.toMatch(/readonly\s+displayName\b/);
    expect(roomMembers).not.toMatch(/readonly\s+avatarMxc\b/);
  });

  it('routes avatar bytes through Media and keeps commands cold with typed failures', () => {
    const identity = productionSources
      .filter((file) => file.startsWith('libs/data-access/identity/'))
      .map(source)
      .join('\n');
    const profile = source(
      'libs/data-access/identity/src/lib/identity.service.ts',
    );
    const media = source('libs/data-access/media/src/lib/avatar.service.ts');

    expect(profile).toContain('inject(AvatarService)');
    expect(profile).toContain('this.avatars.upload(');
    expect(profile).not.toContain('uploadContent');
    expect(media).toContain('upload(file: File, accountId: string)');
    expect(media).toContain('client.uploadContent(file');
    expect(identity).toContain('return defer(() =>');
    expect(identity).toContain("'offline'");
    expect(identity).toContain("'unavailable'");
    expect(identity).toContain("'server-failure'");
    expect(identity).not.toMatch(
      /\basync\s+(?:load|lookup|search|setDisplayName|setAvatar|setOwnPresence|ignore|unignore)\s*\(/,
    );
  });

  it('removes legacy profile imports and caller SDK escape paths', () => {
    const allProduction = productionSources.map(source).join('\n');
    const callers = [
      'libs/feature/rooms/src/lib/member-info/member-info.component.ts',
      'libs/feature/rooms/src/lib/quick-switcher/quick-switcher.component.ts',
      'libs/feature/rooms/src/lib/user-card/user-card.component.ts',
      'libs/feature/rooms/src/lib/user-picker/user-picker.component.ts',
      'libs/feature/settings/src/lib/profile/profile-settings.component.ts',
      'libs/feature/settings/src/lib/presence/presence-section.component.ts',
    ]
      .map(source)
      .join('\n');

    expect(allProduction).not.toContain('@trinity/data-access/profile');
    expect(allProduction).not.toMatch(
      /\b(?:ProfileService|AccountProfilesService|PresenceService)\b/,
    );
    expect(callers).not.toContain('MatrixClientService');
    expect(callers).not.toMatch(/from ['"]matrix-js-sdk/);
    expect(callers).toContain("from '@trinity/data-access/identity'");
  });
});
