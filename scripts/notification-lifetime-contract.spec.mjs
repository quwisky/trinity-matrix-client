import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

describe('Notification projection lifetime', () => {
  it('belongs to Application Runtime rather than the Rooms route', () => {
    const entrypoint = source('libs/data-access/notifications/src/index.ts');
    const lifetime = source(
      'libs/data-access/notifications/src/lib/notification-lifetime.ts',
    );
    const session = source(
      'libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts',
    );
    const page = source('libs/feature/rooms/src/lib/rooms/rooms.page.ts');

    expect(entrypoint).toContain("export * from './lib/notification-lifetime'");
    expect(lifetime).toContain('class NotificationLifetime');
    expect(session).toContain('inject(NotificationLifetime)');
    expect(page).not.toContain('this.roomNotifications.connect()');
  });
});
