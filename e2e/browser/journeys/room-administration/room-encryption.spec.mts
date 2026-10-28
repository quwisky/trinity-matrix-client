import type { Page, Route } from '@playwright/test';
import { expect, test, testResourceId } from '../../../fixtures.mts';
import {
  login,
  waitForSent,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { withSyncFence } from '../../../support/sync-fence.mts';
import {
  HS_SERVER_NAME,
  configureRoomSettingsSuite,
  openRoom,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

/** The dev build's Angular debug API, reaching the active account's Matrix client. */
interface MatrixClientWindow extends Window {
  ng: {
    getComponent(element: Element): {
      runtime: {
        adapter: {
          session: {
            roomAdministration: {
              permissions: {
                matrix: {
                  instance: {
                    getCrypto(): {
                      isEncryptionEnabledInRoom(
                        roomId: string,
                      ): Promise<boolean>;
                      /** RustCrypto's private per-room encryptors. */
                      roomEncryptors?: Record<string, unknown>;
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  };
}

/** Whether the crypto store has the room as encrypted and its encryptor is configured. */
function encryptsOnThisDevice(page: Page, roomId: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    const root = document.querySelector('trn-root');
    if (!root) return false;
    const crypto = (window as unknown as MatrixClientWindow).ng
      .getComponent(root)
      .runtime.adapter.session.roomAdministration.permissions.matrix.instance.getCrypto();
    return (
      (await crypto.isEncryptionEnabledInRoom(id)) &&
      !!crypto.roomEncryptors?.[id]
    );
  }, roomId);
}

// Covers Room settings › General › Encryption: an admin turns on encryption in an unencrypted
// room. The status changes once sync delivers m.room.encryption, and the next message the app
// sends reaches the server as m.room.encrypted.
test.describe('Room encryption', () => {
  configureRoomSettingsSuite();

  test('an admin turns on encryption and the next message is encrypted', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}enc`;
    const user = `encrypt-${runId}`;
    const pass = `${user}-pass`;
    const userId = `@${user}:${HS_SERVER_NAME}`;
    const roomName = `Encrypt ${runId}`;

    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    const headers = { Authorization: `Bearer ${token}` };
    const room = (id: string) =>
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(id)}`;
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: token },
      roomName,
    );

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
    const settings = page.getByTestId('room-settings');
    await expect(settings).toBeVisible({ timeout: 10_000 });

    const status = settings.getByTestId('room-settings-encryption');
    await expect(status).toHaveText(
      'Messages in this room are not end-to-end encrypted.',
    );
    await settings.getByRole('button', { name: 'Turn on encryption…' }).click();
    const confirm = page.getByRole('dialog', {
      name: 'Turn on encryption?',
    });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("This can't be undone.");
    await expect(confirm.getByTestId('alert-confirm')).toHaveText(
      'Turn on encryption',
    );

    await withSyncFence(
      page,
      request,
      session,
      { userId, headers },
      async () => {
        const sent = page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' &&
            response.url().includes('/state/m.room.encryption'),
        );
        await confirm.getByTestId('alert-confirm').click();
        expect((await sent).ok()).toBe(true);
      },
    );

    await expect(status).toHaveText(
      "Messages in this room are end-to-end encrypted. This can't be turned off.",
      { timeout: 30_000 },
    );
    await expect(
      settings.getByRole('button', { name: 'Turn on encryption…' }),
    ).toHaveCount(0);
    const state = await request
      .get(`${room(roomId)}/state/m.room.encryption/`, { headers })
      .then((r) => r.json());
    expect(state).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });

    await page.getByTestId('room-settings-cancel').click();
    await expect(settings).toBeHidden();
    const body = `Secret ${runId}`;
    await page.getByTestId('composer-input').fill(body);
    await page.getByTestId('composer-input').press('Enter');
    await waitForSent(
      page.locator('.scroll .msg[data-mid]', { hasText: body }).first(),
    );

    const messages = await request
      .get(`${room(roomId)}/messages?dir=b&limit=20`, { headers })
      .then((r) => r.json());
    const latest = (
      messages.chunk as { type: string; sender: string; content: object }[]
    ).find(
      ({ type, sender }) =>
        sender === userId &&
        (type === 'm.room.message' || type === 'm.room.encrypted'),
    );
    expect(latest?.type).toBe('m.room.encrypted');
    expect(JSON.stringify(latest?.content)).not.toContain(body);
  });

  // A homeserver can leave m.room.encryption out of sync (Tuwunel's state_after race), so the
  // SDK never configures the room. The app applies its own write at once, and after a reload
  // restores the room's encryption from the server, so no message leaves in the clear.
  test('messages stay encrypted when sync never delivers the encryption event', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ens`;
    const user = `encrypt-${runId}`;
    const pass = `${user}-pass`;
    const userId = `@${user}:${HS_SERVER_NAME}`;
    const roomName = `Encrypt unsynced ${runId}`;

    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: token },
      roomName,
    );

    let stripped = 0;
    const sync = '**/_matrix/client/v3/sync*';
    const withoutEncryption = async (route: Route): Promise<void> => {
      try {
        const response = await route.fetch({ timeout: 0 });
        const json = await response.json();
        const joined = json.rooms?.join?.[roomId];
        for (const key of [
          'org.matrix.msc4222.state_after',
          'state',
          'timeline',
        ]) {
          const events = joined?.[key]?.events as
            { type?: string }[] | undefined;
          if (!events) continue;
          joined[key].events = events.filter(
            ({ type }) => type !== 'm.room.encryption',
          );
          stripped += events.length - joined[key].events.length;
        }
        await route.fulfill({ response, json });
      } catch {
        // The page reloaded or closed while this sync was waiting; else the SDK retries.
        await route.abort().catch(() => undefined);
      }
    };
    // Before sign-in, so no sync the page starts escapes the filter.
    await page.route(sync, withoutEncryption);
    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);

    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
    const settings = page.getByTestId('room-settings');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    await settings.getByRole('button', { name: 'Turn on encryption…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Turn on encryption?' });
    const turnedOn = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes('/state/m.room.encryption'),
    );
    await confirm.getByTestId('alert-confirm').click();
    expect((await turnedOn).ok()).toBe(true);
    await expect(settings.getByTestId('room-settings-encryption')).toHaveText(
      "Messages in this room are end-to-end encrypted. This can't be turned off.",
    );
    await expect(
      settings.getByTestId('room-settings-encryption-late'),
    ).toHaveCount(0);
    await page.getByTestId('room-settings-cancel').click();
    await expect(settings).toBeHidden();

    const ownMessageTypes = async (): Promise<string[]> => {
      const messages = await request
        .get(
          `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`,
          { headers },
        )
        .then((r) => r.json());
      return (messages.chunk as { type: string; sender: string }[])
        .filter(
          ({ type, sender }) =>
            sender === userId &&
            (type === 'm.room.message' || type === 'm.room.encrypted'),
        )
        .map(({ type }) => type);
    };
    const send = async (body: string): Promise<void> => {
      await page.getByTestId('composer-input').fill(body);
      await page.getByTestId('composer-input').press('Enter');
      await waitForSent(
        page.locator('.scroll .msg[data-mid]', { hasText: body }).first(),
      );
    };

    await send(`Secret ${runId} 1`);
    expect(stripped).toBeGreaterThan(0);
    expect(await ownMessageTypes()).toEqual(['m.room.encrypted']);

    // The sync filter stays on: the reloaded client again sees no m.room.encryption.
    await page.reload();
    await openRoom(page, roomName);
    // The repair runs in the background after sync; send once this device encrypts there.
    await expect
      .poll(() => encryptsOnThisDevice(page, roomId), { timeout: 20_000 })
      .toBe(true);
    await send(`Secret ${runId} 2`);
    expect(await ownMessageTypes()).toEqual([
      'm.room.encrypted',
      'm.room.encrypted',
    ]);

    await page.unroute(sync, withoutEncryption);
    await send(`Secret ${runId} 3`);
    expect(await ownMessageTypes()).toEqual([
      'm.room.encrypted',
      'm.room.encrypted',
      'm.room.encrypted',
    ]);
  });
});
