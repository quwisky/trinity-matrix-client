import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const sessionProjections = [
  ['room-library', 'room-library.service.ts'],
  ['room-library', 'spaces.service.ts'],
  ['room-library', 'invites.service.ts'],
  ['room-library', 'space-children.service.ts'],
  ['room-library', 'selected-room-library.service.ts'],
  ['trust', 'trust.service.ts'],
  ['trust', 'trust-verification.service.ts'],
  ['identity', 'identity-presence.service.ts'],
  ['notifications', 'room-notifications.service.ts'],
  ['room-administration', 'room-action-permissions.service.ts'],
  ['room-administration', 'room-members.service.ts'],
].map(([capability, file]) => `libs/data-access/${capability}/src/lib/${file}`);

const presentationSources = globSync(
  [
    'apps/**/*.ts',
    'libs/feature/**/*.ts',
    'libs/application/runtime/src/lib/**/*component.ts',
  ],
  { cwd: workspaceRoot },
)
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

describe('Application Runtime session projection ownership', () => {
  it('exposes one cold owned lifetime instead of generic lifecycle controls', () => {
    for (const file of sessionProjections) {
      const implementation = source(file);

      expect(implementation, file).toContain(
        'runProjection(): Observable<void>',
      );
      expect(implementation, file).not.toMatch(
        /^\s{2}(?:connect|disconnect)\([^)]*\): void \{/mu,
      );
    }
  });

  it('keeps session lifetime entrypoints out of routes and presentation hosts', () => {
    const presentation = presentationSources.map(source).join('\n');

    expect(presentation).not.toContain('.runProjection()');
    expect(presentation).not.toMatch(
      /inject\((?:RoomLibraryLifetime|TrustLifetime|IdentityLifetime|NotificationLifetime|RoomAdministrationLifetime)\)/u,
    );
  });

  it('retains explicit local lifetimes for exact Room and settings demand', () => {
    const conversations = source(
      'libs/data-access/timeline/src/lib/conversation-runtime.service.ts',
    );
    const rooms = source('libs/feature/rooms/src/lib/rooms/rooms.page.ts');
    const widgets = source(
      'libs/feature/rooms/src/lib/room-settings/room-widgets.component.ts',
    );
    const devices = source(
      'libs/feature/settings/src/lib/devices/devices-section.component.ts',
    );
    const imagePacks = source(
      'libs/feature/settings/src/lib/image-packs/image-packs-section.component.ts',
    );
    const sounds = source(
      'libs/feature/settings/src/lib/notifications/notifications-section.component.ts',
    );

    expect(conversations).toContain('timeline.open(key.roomId, client)');
    expect(conversations).toContain('timeline.close()');
    expect(rooms).toContain('this.imagePackService.connect(roomId)');
    expect(rooms).toContain('this.imagePackService.disconnect(roomId)');
    expect(widgets).toContain(
      'this.widgetsService.connect(this.connectedTarget)',
    );
    expect(widgets).toContain(
      'this.widgetsService.disconnect(this.connectedTarget)',
    );
    expect(devices).toContain('this.devicesSvc.connect()');
    expect(devices).toContain('this.devicesSvc.disconnect()');
    expect(imagePacks).toContain('this.management.connect()');
    expect(imagePacks).toContain('this.management.disconnect()');
    expect(sounds).toContain('this.sound.connect()');
    expect(sounds).toContain('this.sound.disconnect()');
  });
});
