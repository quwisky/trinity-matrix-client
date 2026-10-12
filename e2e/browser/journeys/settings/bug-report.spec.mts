import { readFileSync } from 'node:fs';
import { expect, test, testResourceId, type Page } from '../../../fixtures.mts';
import {
  homeserverSession,
  login,
  preferenceKeys,
  webNavigate,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import {
  openSettingsSection,
  openSystemStatusFromRooms,
} from '../../../support/journeys/navigation.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';

// Covers Report a bug: matrix-js-sdk debug output is captured into IndexedDB and survives a
// reload; the stored entries never hold a credential; the preview and the saved
// trinity-<date>.log are the same redacted text, and neither contains the app's access token,
// its device ID, a room ID, the user ID, the server name or a message body received, sent,
// encrypted or decrypted. Turning "Keep a diagnostic log" off deletes the log and the report
// then says logging is off. Report a bug also opens over System status and, signed out, from
// the sign-in page. The homeserver tests self-skip without one.
const session = homeserverSession();
const DB_NAME = 'trinity-diagnostic-log';
const KEEP_LOG_KEY = 'trinity.diagnostics.keep-log';

/** Messages in the diagnostic log database, read without creating it. */
function storedMessages(page: Page): Promise<string[]> {
  return page.evaluate(
    (name) =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open(name);
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('entries')) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction('entries').objectStore('entries').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(
              (all.result as { message: string }[]).map((e) => e.message),
            );
          };
          all.onerror = () => {
            db.close();
            resolve([]);
          };
        };
      }),
    DB_NAME,
  );
}

/** Reload; the app restores the open room from its URL, so wait for its composer. */
async function reloadIntoRoom(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 30_000,
  });
}

/** The file name the app will use: the browser's local date. */
function expectedLogName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `trinity-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
  });
}

test.describe('Report a bug', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('saves a redacted diagnostic log, never stores a credential, and can be turned off', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}bug`;
    const user = `bugreport-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Bug report ${runId}`;
    const body = `diagnostic-secret-body-${runId}`;
    const sealedRoomName = `Bug report sealed ${runId}`;
    const sealedBody = `diagnostic-sealed-body-${runId}`;

    await registerUser(request, user, pass);
    const rest = await passwordLogin(request, hs, user, pass);
    const headers = { Authorization: `Bearer ${rest.accessToken}` };
    const { room_id: roomId } = (await (
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
    ).json()) as { room_id: string };
    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}`,
      { headers, data: { msgtype: 'm.text', body } },
    );
    expect(sent.ok()).toBe(true);
    const { room_id: sealedRoomId } = (await (
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: {
          name: sealedRoomName,
          preset: 'private_chat',
          initial_state: [
            {
              type: 'm.room.encryption',
              state_key: '',
              content: { algorithm: 'm.megolm.v1.aes-sha2' },
            },
          ],
        },
      })
    ).json()) as { room_id: string };

    const appTokens = new Set<string>();
    page.on('request', (outgoing) => {
      const authorization = outgoing.headers()['authorization'];
      if (authorization?.startsWith('Bearer ')) {
        appTokens.add(authorization.slice('Bearer '.length));
      }
    });
    // A refresh token never travels in a header: read it from the login and refresh answers.
    page.on('response', async (incoming) => {
      if (
        !/\/_matrix\/client\/v3\/(?:login|refresh)$/.test(
          new URL(incoming.url()).pathname,
        )
      ) {
        return;
      }
      const answer = (await incoming.json().catch(() => null)) as {
        access_token?: string;
        refresh_token?: string;
      } | null;
      for (const token of [answer?.access_token, answer?.refresh_token]) {
        if (token) appTokens.add(token);
      }
    });
    await page.context().route('https://github.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>stub</title>',
      }),
    );

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    // Receive: a message another device sent.
    await openNamedRoom(page, roomName);
    await expect(page.locator('.msg__text', { hasText: body })).toBeVisible({
      timeout: 20_000,
    });
    // Send, encrypt and decrypt: the app's own message in an encrypted room, which the SDK
    // encrypts on send and decrypts again from its remote echo.
    await openNamedRoom(page, sealedRoomName);
    await sendComposerLines(page, [sealedBody]);
    await expect(
      page.locator('.msg__text', { hasText: sealedBody }),
    ).toBeVisible({ timeout: 20_000 });

    // Persistence: the first session's lines reach IndexedDB, then a reload adds a second
    // session; both "app started" markers must be in the export.
    await expect
      .poll(async () => (await storedMessages(page)).length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await reloadIntoRoom(page);

    // The hard rule holds in the store itself, not only in the export: after real sign-in,
    // sync, send, encrypt and decrypt, no stored entry carries a credential.
    expect(appTokens.size).toBeGreaterThan(0);
    const credentials = [...appTokens, rest.accessToken, pass];
    const stored = (await storedMessages(page)).join('\n');
    expect(stored.length).toBeGreaterThan(0);
    for (const credential of credentials) {
      expect(
        stored,
        `stored log holds ${credential.slice(0, 6)}…`,
      ).not.toContain(credential);
    }

    const [appToken] = [...appTokens];
    const { device_id: deviceId } = (await (
      await request.get(`${hs}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${appToken}` },
      })
    ).json()) as { device_id: string };
    const serverName = rest.userId.slice(rest.userId.indexOf(':') + 1);
    const secrets = [
      ...credentials,
      deviceId,
      roomId,
      sealedRoomId,
      rest.userId,
      serverName,
      body,
      sealedBody,
    ];

    await openSettingsSection(page, 'advanced');
    const reportButton = page.getByTestId('advanced-report-bug');
    await reportButton.click();
    const dialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('What went wrong?').fill('Messages arrive late');
    await dialog.getByTestId('report-bug-preview-toggle').click();
    const preview = dialog.getByRole('region', {
      name: 'Diagnostic log preview',
    });
    await expect(preview).toBeVisible();
    const previewText = (await preview.textContent()) ?? '';

    expect(previewText).toContain('# Accounts signed in: 1');
    expect(previewText).toContain('@me:server1');
    expect(previewText).toContain('FetchHttpApi');
    expect(
      previewText.match(/app started: /g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    for (const secret of secrets) {
      expect(previewText, `preview leaks ${secret.slice(0, 6)}…`).not.toContain(
        secret,
      );
    }

    const downloadPromise = page.waitForEvent('download');
    await dialog.getByTestId('report-bug-save').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(await expectedLogName(page));
    const saved = readFileSync(await download.path(), 'utf8');
    expect(saved).toBe(previewText);
    for (const secret of secrets) {
      expect(saved, `saved file leaks ${secret.slice(0, 6)}…`).not.toContain(
        secret,
      );
    }

    const popupPromise = page.context().waitForEvent('page');
    await dialog.getByTestId('report-bug-github').click();
    const popup = await popupPromise;
    const issue = new URL(popup.url());
    expect(issue.pathname).toBe('/quwisky/trinity-matrix-client/issues/new');
    expect(issue.searchParams.get('template')).toBe('bug_report.yml');
    expect(issue.searchParams.get('summary')).toBe('Messages arrive late');
    expect(issue.searchParams.get('logs')).toContain(
      download.suggestedFilename(),
    );
    for (const secret of secrets) {
      expect(popup.url()).not.toContain(encodeURIComponent(secret));
    }
    await popup.close();

    await dialog.getByRole('button', { name: 'Close Report a bug' }).click();
    await expect(dialog).toBeHidden();
    await expect(reportButton).toBeFocused();

    await page.getByTestId('advanced-clear-diagnostic-logs').click();
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText('Diagnostic logs cleared.'),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (await storedMessages(page)).some((message) =>
          message.startsWith('app started: '),
        ),
      )
      .toBe(false);

    // Keep a diagnostic log off: the log is deleted, nothing more is recorded, the choice is
    // kept for the installation, and the report says logging is off.
    await page.getByRole('switch', { name: 'Keep a diagnostic log' }).click();
    await expect.poll(async () => (await storedMessages(page)).length).toBe(0);
    await expect.poll(() => preferenceKeys(page)).toContain(KEEP_LOG_KEY);
    await expect(
      page.getByTestId('advanced-clear-diagnostic-logs'),
    ).toHaveCount(0);
    await page.evaluate(() =>
      console.warn('[trinity] written while the log is off'),
    );
    await reportButton.click();
    await expect(dialog.getByTestId('report-bug-logging-off')).toBeVisible();
    await expect(dialog.getByTestId('report-bug-include-logs')).toHaveCount(0);
    await expect(dialog.getByTestId('report-bug-save')).toHaveCount(0);
    await expect(dialog.getByTestId('report-bug-github')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close Report a bug' }).click();
    await reloadIntoRoom(page);
    expect(await storedMessages(page)).toEqual([]);
  });

  test('opens Report a bug over System status', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}bugss`;
    const user = `bugstatus-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as HomeserverSession);

    await openSystemStatusFromRooms(page);
    await page.getByRole('button', { name: 'Support details' }).click();
    const reportButton = page.getByTestId('system-status-report-bug');
    await reportButton.click();

    const dialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // Over the panel, not a navigation to Settings.
    await expect(page).toHaveURL(
      (url) => !url.pathname.startsWith('/settings'),
    );
    await dialog.getByRole('button', { name: 'Close Report a bug' }).click();
    await expect(dialog).toBeHidden();
    await expect(reportButton).toBeFocused();
  });
});

test.describe('Report a bug while signed out', () => {
  test('opens Report a bug from the sign-in page', async ({ page }) => {
    await webNavigate(page, '/login');
    const reportButton = page.getByTestId('login-report-bug');
    await reportButton.click();

    const dialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByTestId('report-bug-preview-toggle').click();
    await expect(
      dialog.getByRole('region', { name: 'Diagnostic log preview' }),
    ).toContainText('# Accounts signed in: 0');
    await expect(dialog.getByTestId('report-bug-github')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close Report a bug' }).click();
    await expect(dialog).toBeHidden();
    await expect(reportButton).toBeFocused();
  });
});
