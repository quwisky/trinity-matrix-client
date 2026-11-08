import { expect, test, testResourceId, type Page } from '../../../fixtures.mts';
import {
  homeserverSession,
  login,
  preferenceKeys,
  webNavigate,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { addAccountViaUi } from '../../support/multi-account-journey.mts';
import {
  closeSettings,
  openSettingsSection,
  openSystemStatusFromRooms,
} from '../../../support/journeys/navigation.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';

// Covers Report a bug and the on-device diagnostic log: with Detailed logging turned on for the
// session before the user signs in, matrix-js-sdk debug output is captured into IndexedDB and
// survives a reload, and the stored entries never hold a credential. Report a bug offers no log:
// it opens a pre-filled GitHub issue whose URL holds no credential, device ID, room ID, user ID,
// server name, room name or message body. Turning "Keep a diagnostic log" off deletes the log
// and Report a bug still works; after a reload the log can be turned on again and stores a fresh
// one. Report a bug also opens over System status and, signed out, from the sign-in page. The
// homeserver tests self-skip without one.
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

test.describe('Report a bug', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('opens a pre-filled issue without the log, never stores a credential, and the log can be turned off', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}bug`;
    const user = `bugreport-${runId}`;
    const pass = `${user}-pass`;
    const helper = `bugreport-helper-${runId}`;
    const helperPass = `${helper}-pass`;
    const roomName = `Bug report ${runId}`;
    const body = `diagnostic-secret-body-${runId}`;
    const sealedRoomName = `Bug report sealed ${runId}`;
    const sealedBody = `diagnostic-sealed-body-${runId}`;

    await registerUser(request, user, pass);
    await registerUser(request, helper, helperPass);
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

    // Debug lines carry the requests, so the credential checks below need the user's own
    // sign-in and first sync recorded with Detailed logging on. Settings needs an account,
    // so a helper account signs in first and the user is added in the same app session.
    // Detailed logging lasts one session; the reload below turns it off again.
    await login(page, {
      available: true,
      hs,
      user: helper,
      pass: helperPass,
    } as HomeserverSession);
    await openSettingsSection(page, 'advanced');
    const detailed = page.getByRole('switch', { name: 'Detailed logging' });
    await detailed.click();
    await expect(detailed).toBeChecked();
    await closeSettings(page);
    await addAccountViaUi(page, hs, user, pass);
    await expect(page.locator('.userbar__handle')).toContainText(`@${user}:`);
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

    // The hard rule holds in the store itself. A marker logged after
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
      { label: 'helper password', value: helperPass },
    ];
    await storeMarker(page, `[bug-report-e2e] first session done ${runId}`);
    const firstSession = await storedMessages(page);
    // FetchHttpApi logs requests only at debug: these prove sign-in and the first sync were
    // captured in detail. A bare `/v3/login` would also match the sign-in options GET.
    const debugRequest = (method: string, path: string) =>
      firstSession.some(
        (message) =>
          message.includes(`FetchHttpApi: --> ${method} `) &&
          message.includes(path),
      );
    expect(
      debugRequest('POST', '/v3/login'),
      'the sign-in request is in the log at debug',
    ).toBe(true);
    expect(
      debugRequest('GET', '/v3/sync'),
      'the first sync is in the log at debug',
    ).toBe(true);
    expectNoSecret(
      firstSession.join('\n'),
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

    // The app's own device for the user, not the helper's.
    let deviceId: unknown;
    for (const appToken of appTokens) {
      const whoami = (await (
        await request.get(`${hs}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${appToken}` },
        })
      ).json()) as { user_id?: unknown; device_id?: unknown };
      if (whoami.user_id === rest.userId) deviceId = whoami.device_id;
    }
    expect(typeof deviceId, 'whoami returns a device ID').toBe('string');
    expect((deviceId as string).length).toBeGreaterThan(0);
    const serverName = rest.userId.slice(rest.userId.indexOf(':') + 1);
    const secrets: Secret[] = [
      ...credentials,
      { label: 'device ID', value: deviceId as string },
      { label: 'room ID', value: roomId },
      { label: 'encrypted room ID', value: sealedRoomId },
      { label: 'user ID', value: rest.userId },
      { label: 'helper user ID', value: `@${helper}:${serverName}` },
      { label: 'server name', value: serverName },
      { label: 'received message body', value: body },
      { label: 'encrypted message body', value: sealedBody },
      { label: 'room name', value: roomName },
      { label: 'encrypted room name', value: sealedRoomName },
    ];
    for (const { label, value } of secrets) {
      expect(value.length, `${label} is known`).toBeGreaterThan(0);
    }

    await openSettingsSection(page, 'advanced');
    // The reload was a restart, so Detailed logging is off again.
    await expect(
      page.getByRole('switch', { name: 'Detailed logging' }),
    ).not.toBeChecked();
    const reportButton = page.getByTestId('advanced-report-bug');
    await reportButton.click();
    const dialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('What went wrong?').fill('Messages arrive late');
    // Nothing in the dialog offers, previews or saves the log.
    await expect(dialog.getByText(/diagnostic log/i)).toHaveCount(0);
    await expect(dialog.getByRole('switch')).toHaveCount(0);

    const popupPromise = page.context().waitForEvent('page');
    await dialog.getByTestId('report-bug-github').click();
    const popup = await popupPromise;
    const issue = new URL(popup.url());
    expect(issue.pathname).toBe('/quwisky/trinity-matrix-client/issues/new');
    expect(issue.searchParams.get('template')).toBe('bug_report.yml');
    expect(issue.searchParams.get('summary')).toBe('Messages arrive late');
    expect(issue.searchParams.has('logs')).toBe(false);
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
    // kept for the installation, and Report a bug still opens GitHub.
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
    await expect(dialog.getByTestId('report-bug-github')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close Report a bug' }).click();
    await expect(dialog).toBeHidden();
    await expect(reportButton).toBeFocused();
  });
});
