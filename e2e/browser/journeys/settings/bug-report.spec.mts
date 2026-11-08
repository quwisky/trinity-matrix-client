import { expect, test, testResourceId } from '../../../fixtures.mts';
import {
  databaseNames,
  homeserverSession,
  login,
  preferenceKeys,
  seedPreference,
  webNavigate,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import {
  openSettingsSection,
  openSystemStatusFromRooms,
} from '../../../support/journeys/navigation.mts';

// Covers Report a bug: from Settings it offers no diagnostic log and opens a pre-filled GitHub
// issue whose URL holds no credential, user ID or server name. It also opens over System status
// and, signed out, from the sign-in page. A diagnostic log an earlier version left on the device
// is deleted at startup. The homeserver tests self-skip without one.
const session = homeserverSession();
const RETIRED_DB_NAME = 'trinity-diagnostic-log';
const RETIRED_KEEP_LOG_KEY = 'trinity.diagnostics.keep-log';

test.describe('Report a bug', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('opens a pre-filled issue with no log and no private details', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}bug`;
    const user = `bugreport-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const rest = await passwordLogin(request, hs, user, pass);

    const appTokens = new Set<string>();
    page.on('request', (outgoing) => {
      const authorization = outgoing.headers()['authorization'];
      if (authorization?.startsWith('Bearer ')) {
        appTokens.add(authorization.slice('Bearer '.length));
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
    await openSettingsSection(page, 'advanced');
    for (const control of [
      'Keep a diagnostic log',
      'Detailed logging',
      'Clear diagnostic logs',
    ]) {
      await expect(page.getByText(control)).toHaveCount(0);
    }
    const reportButton = page.getByTestId('advanced-report-bug');
    await reportButton.click();
    const dialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/diagnostic log/i)).toHaveCount(0);
    await expect(dialog.getByRole('switch')).toHaveCount(0);
    await dialog.getByLabel('What went wrong?').fill('Messages arrive late');

    const popupPromise = page.context().waitForEvent('page');
    await dialog.getByTestId('report-bug-github').click();
    const popup = await popupPromise;
    const issue = new URL(popup.url());
    expect(issue.pathname).toBe('/quwisky/trinity-matrix-client/issues/new');
    expect(issue.searchParams.get('template')).toBe('bug_report.yml');
    expect(issue.searchParams.get('summary')).toBe('Messages arrive late');
    expect(issue.searchParams.has('logs')).toBe(false);
    expect(appTokens.size).toBeGreaterThan(0);
    const serverName = rest.userId.slice(rest.userId.indexOf(':') + 1);
    const fields = [...issue.searchParams.values()].join('\n');
    for (const [label, value] of [
      ...[...appTokens].map((token, index) => [
        `app token ${index + 1}`,
        token,
      ]),
      ['password', pass],
      ['user ID', rest.userId],
      ['server name', serverName],
    ]) {
      // Names the leak without printing the value: CI logs of this repository are public.
      expect(fields.includes(value), `issue fields hold the ${label}`).toBe(
        false,
      );
      expect(
        popup.url().includes(encodeURIComponent(value)),
        `issue URL holds the ${label}`,
      ).toBe(false);
    }
    await popup.close();

    await dialog.getByRole('button', { name: 'Close Report a bug' }).click();
    await expect(dialog).toBeHidden();
    await expect(reportButton).toBeFocused();
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

  test('deletes a diagnostic log an earlier version left on the device', async ({
    page,
  }) => {
    await webNavigate(page, '/login');
    await expect(page.getByTestId('login-report-bug')).toBeVisible();
    // What an earlier version stored: the log database with an entry, and its setting.
    await page.evaluate(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onupgradeneeded = () =>
            open.result.createObjectStore('entries', { autoIncrement: true });
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const write = db.transaction('entries', 'readwrite');
            write.objectStore('entries').add({ message: 'app started' });
            write.oncomplete = () => {
              db.close();
              resolve();
            };
          };
        }),
      RETIRED_DB_NAME,
    );
    await seedPreference(
      page,
      RETIRED_KEEP_LOG_KEY,
      JSON.stringify({ version: 1, value: true }),
    );
    expect(await databaseNames(page)).toContain(RETIRED_DB_NAME);

    await page.reload();
    await expect(page.getByTestId('login-report-bug')).toBeVisible();

    await expect.poll(() => databaseNames(page)).not.toContain(RETIRED_DB_NAME);
    await expect
      .poll(() => preferenceKeys(page))
      .not.toContain(RETIRED_KEEP_LOG_KEY);
  });
});
