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
// its device ID, a room ID, the user ID, the server name, a room name or topic, the user's
// display name, an email address or a message body received, sent, encrypted or decrypted.
// Turning "Keep a diagnostic log" off deletes the log and the report then says logging is
// off; after a reload it can be turned on again and stores a fresh log. Report a bug also
// opens over System status and, signed out, from the sign-in page. The homeserver tests
// self-skip without one.
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

/** The recorder batches writes and flushes every 5 s (`FLUSH_DELAY_MS`). */
const FLUSH_DELAY_MS = 5_000;

/** A value that must never appear, named so a failure can say which without printing it. */
interface Secret {
  readonly label: string;
  readonly value: string;
}

/**
 * Fail if `text` holds any secret. The message names the secret and the text's source but
 * prints neither the secret nor the text: CI logs of this public repository are readable.
 */
function expectNoSecret(
  text: string,
  secrets: readonly Secret[],
  where: string,
): void {
  for (const { label, value } of secrets) {
    expect(text.includes(value), `${where} holds the ${label}`).toBe(false);
  }
}

/**
 * Log a line through the app's captured console and wait until IndexedDB holds it. The
 * recorder writes in order, so every line logged before the marker is stored by then.
 */
async function storeMarker(page: Page, marker: string): Promise<void> {
  await page.evaluate((line) => console.warn(line), marker);
  await expect
    .poll(async () => (await storedMessages(page)).includes(marker), {
      timeout: 4 * FLUSH_DELAY_MS,
    })
    .toBe(true);
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
    const roomTopic = `Quarterly launch plans ${runId}`;
    const displayName = `Wren Quillfeather ${runId}`;
    const email = `wren.${runId}@mail.example.net`;

    await registerUser(request, user, pass);
    const rest = await passwordLogin(request, hs, user, pass);
    const headers = { Authorization: `Bearer ${rest.accessToken}` };
    // Set before the rooms exist, so every membership event carries the display name.
    const named = await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(rest.userId)}/displayname`,
      { headers, data: { displayname: displayName } },
    );
    expect(named.ok()).toBe(true);
    const { room_id: roomId } = (await (
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, topic: roomTopic, preset: 'private_chat' },
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

    // The hard rule holds in the store itself, not only in the export. A marker logged after
    // the last action waits out the recorder's batch, so the store is read only once real
    // sign-in, sync, send, encrypt and decrypt have all reached IndexedDB.
    expect(appTokens.size).toBeGreaterThan(0);
    const credentials: Secret[] = [
      ...[...appTokens].map((value, index) => ({
        label: `app token ${index + 1}`,
        value,
      })),
      { label: 'REST access token', value: rest.accessToken },
      { label: 'password', value: pass },
    ];
    // Names reach the log whenever the app or the SDK prints them; the export must replace
    // them. Logged through the captured console, so the store holds them as any log would.
    await page.evaluate(
      (line) => console.warn(line),
      `[bug-report-e2e] in ${roomName} (${roomTopic}), also ${sealedRoomName}, as ${displayName} <${email}>`,
    );
    await storeMarker(page, `[bug-report-e2e] first session done ${runId}`);
    expectNoSecret(
      (await storedMessages(page)).join('\n'),
      credentials,
      'stored log (first session)',
    );

    // Persistence: a reload starts a second session on top of the stored first one; both
    // "app started" markers are stored, and the second session's entries hold no credential
    // either.
    await reloadIntoRoom(page);
    await storeMarker(page, `[bug-report-e2e] second session done ${runId}`);
    const stored = await storedMessages(page);
    expect(
      stored.filter((message) => message.startsWith('app started: ')).length,
    ).toBeGreaterThanOrEqual(2);
    expectNoSecret(
      stored.join('\n'),
      credentials,
      'stored log (both sessions)',
    );

    const [appToken] = [...appTokens];
    const { device_id: deviceId } = (await (
      await request.get(`${hs}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${appToken}` },
      })
    ).json()) as { device_id?: unknown };
    expect(typeof deviceId, 'whoami returns a device ID').toBe('string');
    expect((deviceId as string).length).toBeGreaterThan(0);
    const serverName = rest.userId.slice(rest.userId.indexOf(':') + 1);
    const secrets: Secret[] = [
      ...credentials,
      { label: 'device ID', value: deviceId as string },
      { label: 'room ID', value: roomId },
      { label: 'encrypted room ID', value: sealedRoomId },
      { label: 'user ID', value: rest.userId },
      { label: 'server name', value: serverName },
      { label: 'received message body', value: body },
      { label: 'encrypted message body', value: sealedBody },
      { label: 'room name', value: roomName },
      { label: 'encrypted room name', value: sealedRoomName },
      { label: 'room topic', value: roomTopic },
      { label: 'display name', value: displayName },
      { label: 'email address', value: email },
    ];
    for (const { label, value } of secrets) {
      expect(value.length, `${label} is known`).toBeGreaterThan(0);
    }

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
    // Both sessions' markers are in the export. Read as a count so a failure never prints
    // the log.
    await expect
      .poll(
        async () =>
          ((await preview.textContent()) ?? '').match(/app started: /g)
            ?.length ?? 0,
      )
      .toBeGreaterThanOrEqual(2);
    const previewText = (await preview.textContent()) ?? '';

    for (const expected of [
      '# Accounts signed in: 1',
      '@me:server1',
      'FetchHttpApi',
      'email1@example.invalid',
      'Person 1',
      'Topic 1',
    ]) {
      expect(previewText.includes(expected), `preview shows ${expected}`).toBe(
        true,
      );
    }
    expectNoSecret(previewText, secrets, 'preview');

    const downloadPromise = page.waitForEvent('download');
    await dialog.getByTestId('report-bug-save').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(await expectedLogName(page));
    const saved = readFileSync(await download.path(), 'utf8');
    expect(saved === previewText, 'saved file is the preview text').toBe(true);
    expectNoSecret(saved, secrets, 'saved file');

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
    expectNoSecret(popup.url(), secrets, 'issue URL');
    expectNoSecret(
      popup.url(),
      secrets.map(({ label, value }) => ({
        label,
        value: encodeURIComponent(value),
      })),
      'issue URL (encoded)',
    );
    expectNoSecret(
      [...issue.searchParams.values()].join('\n'),
      secrets,
      'issue fields',
    );
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
    // Nothing is recorded while off: a line logged now must still be absent once more than
    // one flush delay has passed.
    await page.evaluate(() =>
      console.warn('[trinity] written while the log is off'),
    );
    const quietUntil = Date.now() + FLUSH_DELAY_MS + 1_500;
    await expect
      .poll(
        async () => {
          if ((await storedMessages(page)).length > 0) return 'recorded';
          return Date.now() >= quietUntil ? 'quiet' : 'waiting';
        },
        { timeout: 3 * FLUSH_DELAY_MS, intervals: [500] },
      )
      .toBe('quiet');
    await reportButton.click();
    await expect(dialog.getByTestId('report-bug-logging-off')).toBeVisible();
    await expect(dialog.getByTestId('report-bug-include-logs')).toHaveCount(0);
    await expect(dialog.getByTestId('report-bug-save')).toHaveCount(0);
    await expect(dialog.getByTestId('report-bug-github')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close Report a bug' }).click();
    await reloadIntoRoom(page);
    expect(await storedMessages(page)).toEqual([]);

    // After the reload the stored "off" is read and no store is opened, yet the switch can
    // still be turned back on, and a fresh log is stored again.
    await openSettingsSection(page, 'advanced');
    const keepLog = page.getByRole('switch', { name: 'Keep a diagnostic log' });
    await expect(keepLog).toBeEnabled();
    await expect(keepLog).not.toBeChecked();
    await keepLog.click();
    await expect(keepLog).toBeChecked();
    await storeMarker(page, `[bug-report-e2e] turned on again ${runId}`);
    expect(
      (await storedMessages(page)).some((message) =>
        message.startsWith('diagnostic log turned on: '),
      ),
    ).toBe(true);
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
