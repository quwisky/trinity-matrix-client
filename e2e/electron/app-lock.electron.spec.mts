import type { ElectronApplication } from 'playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from './fixtures.mts';
import { homeserverSession, login, type Navigate } from '../support/app.mts';
import { passwordLogin, registerUser } from '../support/account.mts';
import { launchApp } from './support/launch.mts';

// App lock in the launched desktop shell (spec 2026-10-12). The main process's user-presence
// and notification handlers are replaced from inside the test with in-memory fakes: CI has
// neither Touch ID nor a keyring, and the shipped main has no test switch (decision 27). The
// real verifier and IPC are covered by electron/src/*.spec.ts. The PIN lives only in the
// fake; no assertion message, log or answer read back here carries it.
const session = homeserverSession();
const PIN = '482913';
const WRONG_PIN = '111111';

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

/** What the fakes saw; the PIN itself is never read back. */
interface FakeReport {
  readonly pinSet: boolean;
  readonly systemPrompts: number;
  readonly notifications: readonly { body: string; eventId: string }[];
}

interface FakeControls {
  /** Whether the system prompt (Touch ID here) can run. */
  system: 'available' | 'unavailable';
  /** What a system prompt that runs answers. */
  answer: 'verified' | 'cancelled';
}

async function installFakes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, Notification }) => {
    // The notification fake owns support too. Without libnotify (Linux CI under xvfb) main
    // reports notifications unsupported, the renderer is never granted the operation and
    // never reaches the fake below. See grantNotifications for the renderer's side.
    Notification.isSupported = () => true;
    let pin: string | null = null;
    const state = {
      system: 'available' as 'available' | 'unavailable',
      answer: 'verified' as 'verified' | 'cancelled',
      systemPrompts: 0,
      notifications: [] as { body: string; eventId: string }[],
      report: () => ({
        pinSet: pin !== null,
        systemPrompts: state.systemPrompts,
        notifications: state.notifications,
      }),
    };
    Object.assign(globalThis, { e2eAppLock: state });
    const swap = (
      channel: string,
      handler: (event: unknown, raw?: unknown) => unknown,
    ) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    const pinOf = (raw: unknown) =>
      raw && typeof raw === 'object' ? (raw as { pin?: unknown }).pin : null;
    swap('trinity:host:v1:user-presence:support', () => ({
      system:
        state.system === 'available'
          ? { kind: 'available', biometry: 'touch-id' }
          : { kind: 'unavailable', reason: 'not-configured' },
      pin: { kind: 'available', set: pin !== null, nextAttemptAt: null },
    }));
    swap('trinity:host:v1:user-presence:verify', () => {
      if (state.system !== 'available') {
        return { kind: 'unavailable', reason: 'not-configured' };
      }
      state.systemPrompts += 1;
      return { kind: state.answer };
    });
    swap('trinity:host:v1:user-presence:set-pin', (_event, raw) => {
      const next = pinOf(raw);
      if (typeof next !== 'string') {
        return { kind: 'rejected', diagnostic: { code: 'pin-invalid' } };
      }
      pin = next;
      return { kind: 'completed' };
    });
    swap('trinity:host:v1:user-presence:verify-pin', (_event, raw) =>
      pin !== null && pinOf(raw) === pin
        ? { kind: 'verified' }
        : { kind: 'failed', nextAttemptAt: null },
    );
    swap('trinity:host:v1:user-presence:clear-pin', () => {
      pin = null;
      return { kind: 'completed' };
    });
    swap('trinity:host:v1:notification-presentation:present', (_event, raw) => {
      const payload = raw as {
        body?: string;
        destination?: { eventId?: string };
      };
      state.notifications.push({
        body: payload.body ?? '',
        eventId: payload.destination?.eventId ?? '',
      });
      return { kind: 'completed' };
    });
  });
}

/**
 * Reload, so the renderer negotiates its host operations again, now with the faked
 * notification support. The first negotiation can run before installFakes does.
 */
async function grantNotifications(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
}

function fakes(app: ElectronApplication): Promise<FakeReport> {
  return app.evaluate(() =>
    (
      globalThis as unknown as { e2eAppLock: { report: () => FakeReport } }
    ).e2eAppLock.report(),
  );
}

async function setFakes(
  app: ElectronApplication,
  controls: Partial<FakeControls>,
): Promise<void> {
  await app.evaluate((_electron, next) => {
    Object.assign(
      (globalThis as unknown as { e2eAppLock: FakeControls }).e2eAppLock,
      next,
    );
  }, controls);
}

/** File › Lock <app>, as the person would choose it. */
async function lockFromMenu(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('lock-trinity')?.click();
  });
}

function lockMenuItem(app: ElectronApplication) {
  return app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('lock-trinity');
    return item
      ? {
          label: item.label,
          visible: item.visible,
          enabled: item.enabled,
          accelerator: item.accelerator ?? null,
        }
      : null;
  });
}

function windowTitle(app: ElectronApplication): Promise<string> {
  return app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '',
  );
}

/** The app's display name: "Trinity", or "Trinity Next" for the prerelease and dev runs. */
function appNameOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          trinityDesktop: { appIdentity: { displayName: string } };
        }
      ).trinityDesktop.appIdentity.displayName,
  );
}

/** Turn App lock on in Settings › Security: the system prompt where offered, then a PIN twice. */
async function turnOnAppLock(page: Page, appName: string): Promise<void> {
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-nav-security').click();
  await page.getByRole('switch', { name: `Lock ${appName}` }).click();
  await page.getByLabel('New PIN').fill(PIN);
  await page.getByLabel('Confirm PIN').fill(PIN);
  await page.getByRole('button', { name: 'Set PIN' }).click();
  await expect(page.getByTestId('app-lock-after')).toBeVisible({
    timeout: 15_000,
  });
}

/** Unlock with the PIN from the cover's PIN form. */
async function unlockWithPin(page: Page): Promise<void> {
  const cover = page.getByTestId('app-lock-cover');
  await cover.getByTestId('app-lock-pin').fill(PIN);
  await cover.getByTestId('app-lock-pin-submit').click();
  await expect(cover).not.toHaveAttribute('open', '', { timeout: 15_000 });
}

/** Two animation frames: anything a key press would open has rendered by then. */
function afterTwoFrames(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

let receiptChecks = 0;

/** Whether `userId` has a public read receipt on `eventId`, as `token`'s account sees it. */
async function readReceiptBy(
  request: APIRequestContext,
  hs: string,
  token: string,
  roomId: string,
  eventId: string,
  userId: string,
): Promise<boolean> {
  // Synapse answers a repeated, identical sync from a short-lived cache: vary the filter so
  // each check reads the receipts as they are now.
  receiptChecks += 1;
  const filter = JSON.stringify({
    room: { timeline: { limit: 1 } },
    account_data: { not_types: [`trn.e2e.receipt-check.${receiptChecks}`] },
  });
  const res = await request.get(
    `${hs}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(filter)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as {
    rooms?: {
      join?: Record<
        string,
        {
          ephemeral?: {
            events?: {
              type: string;
              content: Record<
                string,
                Record<string, Record<string, unknown> | undefined> | undefined
              >;
            }[];
          };
        }
      >;
    };
  };
  const receipts =
    body.rooms?.join?.[roomId]?.ephemeral?.events?.filter(
      (event) => event.type === 'm.receipt',
    ) ?? [];
  return receipts.some((receipt) =>
    Boolean(receipt.content[eventId]?.['m.read']?.[userId]),
  );
}

test.describe('App lock in the desktop shell', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('locks over an open dialog, keeps notifying, holds receipts and unlocks', async ({
    request,
    matrixResources,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const me = matrixResources.userLocalpart('app-lock');
    const friend = matrixResources.userLocalpart('app-lock-friend');
    await registerUser(request, me, `${me}-pass`);
    await registerUser(request, friend, `${friend}-pass`);
    const mine = await passwordLogin(request, hs, me, `${me}-pass`);
    const theirs = await passwordLogin(request, hs, friend, `${friend}-pass`);
    const roomName = matrixResources.roomName('app lock');
    const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${theirs.accessToken}` },
      data: { name: roomName, preset: 'private_chat', invite: [mine.userId] },
    });
    expect(created.ok()).toBe(true);
    const roomId = (await created.json()).room_id as string;
    const joined = await request.post(
      `${hs}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { headers: { Authorization: `Bearer ${mine.accessToken}` } },
    );
    expect(joined.ok()).toBe(true);

    const app = await launchApp();
    try {
      await installFakes(app);
      const page = await app.firstWindow();
      await grantNotifications(page);
      const appName = await appNameOf(page);
      // Every read receipt and read marker the client sends, in order.
      const acks: string[] = [];
      page.on('request', (sent) => {
        if (/\/receipt\/|\/read_markers/.test(sent.url()))
          acks.push(sent.url());
      });
      await login(
        page,
        { available: true, hs, user: me, pass: `${me}-pass` },
        electronNavigate,
      );
      await page.getByText(roomName, { exact: true }).first().click();
      await expect(page).toHaveTitle(new RegExp(roomName));

      // Turn App lock on: the system prompt (fake Touch ID), then a PIN typed twice.
      expect(await lockMenuItem(app)).toBeNull();
      await turnOnAppLock(page, appName);
      const afterSetup = await fakes(app);
      expect(afterSetup.pinSet).toBe(true);
      expect(afterSetup.systemPrompts).toBe(1);
      expect(await lockMenuItem(app)).toEqual({
        label: `Lock ${appName}`,
        visible: true,
        enabled: true,
        accelerator: null,
      });

      // Lock now ships unassigned: bind it in Settings › Shortcuts, which the menu shows.
      await page.getByTestId('settings-nav-shortcuts').click();
      await page.getByTestId('shortcut-edit-lock.now').click();
      await expect(page.getByTestId('capture-hint')).toBeVisible();
      await page.keyboard.press('Control+Shift+L');
      await expect(
        page.getByTestId('shortcut-lock.now').getByTestId('shortcut-binding'),
      ).toContainText('L');
      await expect
        .poll(async () => (await lockMenuItem(app))?.accelerator)
        .toBe('CommandOrControl+Shift+L');

      // From here a prompt that opens by itself (on focus) is cancelled, so only the PIN
      // or an explicit Unlock ends the lock.
      await setFakes(app, { answer: 'cancelled' });

      // The shortcut locks over the open Settings dialog.
      const cover = page.getByTestId('app-lock-cover');
      const editLockNow = page.getByTestId('shortcut-edit-lock.now');
      await editLockNow.focus();
      await expect(editLockNow).toBeFocused();
      await page.keyboard.press('Control+Shift+L');
      await expect(cover).toHaveAttribute('open', '', { timeout: 15_000 });
      // Over the dialog, the cover is still named for assistive technology.
      await expect(
        page.getByRole('heading', { name: `${appName} is locked` }),
      ).toBeVisible();
      // The title, the taskbar and window switchers show only the app's name.
      await expect(page).toHaveTitle(appName);
      expect(await windowTitle(app)).toBe(appName);
      expect((await lockMenuItem(app))?.enabled).toBe(false);
      await expect(page.getByTestId('app-lock-unlock')).toHaveText(
        'Unlock with Touch ID',
      );
      await page.getByTestId('app-lock-use-pin').click();
      await unlockWithPin(page);
      // The dialog was held beneath the lock, as it was, with focus back where it was.
      await expect(page.getByTestId('shortcut-lock.now')).toBeVisible();
      await expect(editLockNow).toBeFocused();
      await expect(page).toHaveTitle(new RegExp(roomName));
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('shortcut-lock.now')).toHaveCount(0);

      // Unlocked, Ctrl+K opens the quick switcher; locked, the same chord does nothing.
      const switcher = page.getByTestId('switcher-input');
      await page.keyboard.press('Control+K');
      await expect(switcher).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(switcher).toHaveCount(0);

      // File › Lock with the room open. A message for that room still notifies, and is not
      // marked read behind the cover.
      const composer = page.getByTestId('composer-input');
      await composer.focus();
      await expect(composer).toBeFocused();
      const acksBeforeLock = acks.length;
      await lockFromMenu(app);
      await expect(cover).toHaveAttribute('open', '', { timeout: 15_000 });
      // With no dialog beneath, the cover is a dialog named by its heading.
      await expect(
        page.getByRole('dialog', { name: `${appName} is locked` }),
      ).toBeVisible();
      await page.keyboard.press('Control+K');
      await afterTwoFrames(page);
      await expect(switcher).toHaveCount(0);
      await page.bringToFront();
      // Without window focus nothing is marked read anyway, so the hold below proves nothing.
      expect(await page.evaluate(() => document.hasFocus())).toBe(true);
      const sent = await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${matrixResources.namespace.role('locked-message')}`,
        {
          headers: { Authorization: `Bearer ${theirs.accessToken}` },
          data: { msgtype: 'm.text', body: 'Sent while locked' },
        },
      );
      expect(sent.ok()).toBe(true);
      const eventId = (await sent.json()).event_id as string;
      await expect
        .poll(
          async () =>
            (await fakes(app)).notifications.some(
              (shown) => shown.eventId === eventId,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);

      // A wrong PIN says so; the right one unlocks, and the held receipt goes out.
      await page.getByTestId('app-lock-use-pin').click();
      await page.getByLabel(`${appName} PIN`).fill(WRONG_PIN);
      await page.getByTestId('app-lock-pin-submit').click();
      await expect(page.getByTestId('app-lock-message')).toHaveText(
        'That PIN isn’t right.',
      );
      await expect(cover).toHaveAttribute('open', '');
      // The client got the message (it notified), yet sent no receipt or read marker while
      // locked.
      expect(acks.slice(acksBeforeLock)).toEqual([]);
      await unlockWithPin(page);
      await expect(composer).toBeFocused();
      await expect
        .poll(() =>
          acks
            .slice(acksBeforeLock)
            .some((url) => url.includes(encodeURIComponent(eventId))),
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            readReceiptBy(
              request,
              hs,
              theirs.accessToken,
              roomId,
              eventId,
              mine.userId,
            ),
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe(true);

      // The system prompt goes away (the Mac's password or Touch ID turned off): Lock from
      // the account menu shows the PIN form straight away, saying why.
      await setFakes(app, { system: 'unavailable' });
      await page.getByTestId('user-menu-trigger').click();
      await page.getByTestId('lock-trinity').click();
      await expect(cover).toHaveAttribute('open', '', { timeout: 15_000 });
      await expect(page.getByLabel(`${appName} PIN`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('app-lock-unlock')).toHaveCount(0);
      await expect(page.getByTestId('app-lock-message')).toContainText(
        `Enter your ${appName} PIN`,
      );
      await unlockWithPin(page);

      // Back again, the system prompt unlocks.
      await setFakes(app, { system: 'available', answer: 'verified' });
      await lockFromMenu(app);
      await expect(cover).toHaveAttribute('open', '', { timeout: 15_000 });
      await page.getByTestId('app-lock-unlock').click();
      await expect(cover).not.toHaveAttribute('open', '', { timeout: 15_000 });
      await expect(page).toHaveTitle(new RegExp(roomName));
    } finally {
      await app.close();
    }
  });

  // An open CDK dialog marks every <body> child but its overlay container aria-hidden. The
  // cover lives in its own <body> child that CDK skips, so a screen reader still gets it, and
  // CDK's own aria-hidden is as CDK left it after unlock.
  async function pinOnlyAppLock(
    request: APIRequestContext,
    localpart: string,
  ): Promise<{ app: ElectronApplication; page: Page; appName: string }> {
    const hs = session.hs as string;
    await registerUser(request, localpart, `${localpart}-pass`);
    const app = await launchApp();
    await installFakes(app);
    await setFakes(app, { system: 'unavailable' });
    const page = await app.firstWindow();
    const appName = await appNameOf(page);
    await login(
      page,
      { available: true, hs, user: localpart, pass: `${localpart}-pass` },
      electronNavigate,
    );
    await turnOnAppLock(page, appName);
    return { app, page, appName };
  }

  test('names the lock screen for assistive technology over an open dialog', async ({
    request,
    matrixResources,
  }) => {
    const { app, page, appName } = await pinOnlyAppLock(
      request,
      matrixResources.userLocalpart('app-lock-a11y'),
    );
    try {
      const root = page.locator('trn-root');
      const settings = page.getByTestId('settings-nav-security');
      // Settings is still open from turning the lock on.
      await expect(root).toHaveAttribute('aria-hidden', 'true');
      await lockFromMenu(app);
      await expect(
        page.getByRole('dialog', { name: `${appName} is locked` }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByRole('heading', { name: `${appName} is locked` }),
      ).toBeVisible();
      await expect(page.getByLabel(`${appName} PIN`)).toBeVisible();
      await unlockWithPin(page);
      // Settings is still open beneath, and CDK still hides the rest as it set it.
      await expect(settings).toBeVisible();
      await expect(root).toHaveAttribute('aria-hidden', 'true');
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      await expect(root).not.toHaveAttribute('aria-hidden');
    } finally {
      await app.close();
    }
  });

  test('names the lock screen for assistive technology over a dialog opened while locked', async ({
    request,
    matrixResources,
  }) => {
    const { app, page, appName } = await pinOnlyAppLock(
      request,
      matrixResources.userLocalpart('app-lock-a11y-late'),
    );
    try {
      const root = page.locator('trn-root');
      const settings = page.getByTestId('settings-nav-security');
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      await expect(root).not.toHaveAttribute('aria-hidden');
      await lockFromMenu(app);
      const cover = page.getByRole('dialog', { name: `${appName} is locked` });
      await expect(cover).toBeVisible({ timeout: 15_000 });
      // The app opens a dialog while locked: Settings, by a click dispatched to the hidden,
      // inert button. CDK hides the root, not the cover, and focus stays in the cover.
      await page.getByTestId('open-settings').dispatchEvent('click');
      await expect(settings).toBeAttached();
      await expect(root).toHaveAttribute('aria-hidden', 'true');
      await expect(cover).toBeVisible();
      await expect(page.getByLabel(`${appName} PIN`)).toBeFocused();
      await unlockWithPin(page);
      await expect(settings).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      await expect(root).not.toHaveAttribute('aria-hidden');
    } finally {
      await app.close();
    }
  });

  test('a locked window that reloads or crashes paints its cover before it shows', async ({
    request,
    matrixResources,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const me = matrixResources.userLocalpart('app-lock-reload');
    await registerUser(request, me, `${me}-pass`);
    const app = await launchApp();
    try {
      await installFakes(app);
      // The PIN alone, so no system prompt opens by itself on show or focus.
      await setFakes(app, { system: 'unavailable' });
      const page = await app.firstWindow();
      const appName = await appNameOf(page);
      await login(
        page,
        { available: true, hs, user: me, pass: `${me}-pass` },
        electronNavigate,
      );
      await turnOnAppLock(page, appName);
      await page.keyboard.press('Escape');

      // Count the cover's "painted" signals as main receives them; the shell's own listener
      // still handles each one.
      const platform = await app.evaluate(({ ipcMain }) => {
        const seen = { painted: 0 };
        Object.assign(globalThis, { e2eCoverPainted: seen });
        ipcMain.on('trinity:host:v1:lock-integration:cover-painted', () => {
          seen.painted += 1;
        });
        return process.platform;
      });
      const painted = () =>
        app.evaluate(
          () =>
            (globalThis as unknown as { e2eCoverPainted: { painted: number } })
              .e2eCoverPainted.painted,
        );
      const opacity = () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.getOpacity() ?? -1,
        );
      // Linux has no window opacity (`setOpacity` does nothing; `getOpacity` is always 1).
      const holds = platform !== 'linux';
      const hide = () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.hide(),
        );
      const show = () =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.show();
          win?.focus();
        });

      await lockFromMenu(app);
      const cover = page.getByTestId('app-lock-cover');
      await expect(cover).toHaveAttribute('open', '', { timeout: 15_000 });
      await expect.poll(painted).toBeGreaterThanOrEqual(1);

      // A reload while locked starts locked: the cover is open from the first frame, with
      // nothing behind it visible, and it tells the shell once it has painted.
      let before = await painted();
      await page.reload();
      await expect(cover).toHaveAttribute('open', '', { timeout: 30_000 });
      expect(
        await page.evaluate(
          () =>
            getComputedStyle(
              document.querySelector('trn-root > div') as Element,
            ).visibility,
        ),
      ).toBe('hidden');
      await expect.poll(painted).toBeGreaterThan(before);

      // Hidden to the tray, the window is held transparent; a reload there still comes back
      // locked, and showing it again reveals it once the cover has painted.
      await hide();
      if (holds) await expect.poll(opacity).toBe(0);
      await page.reload();
      await expect(cover).toHaveAttribute('open', '', { timeout: 30_000 });
      if (holds) expect(await opacity()).toBe(0);
      before = await painted();
      await show();
      await expect.poll(painted).toBeGreaterThan(before);
      if (holds) await expect.poll(opacity).toBe(1);
      await expect(cover).toHaveAttribute('open', '');

      // A renderer that crashes again soon after a recovery reload, while the window is
      // hidden: shown again, the window stays transparent past the hold's timeout (nothing
      // can paint), the recovery question opens in a box of its own, and only the reloaded
      // renderer's painted cover reveals the window.
      await app.evaluate(({ BrowserWindow, dialog }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const asked: { parented: boolean; message: string; opacity: number }[] =
          [];
        Object.assign(globalThis, { e2eRecoveryAsked: asked });
        dialog.showMessageBox = (async (...args: unknown[]) => {
          // Answer Reload after the hold's 700 ms timeout has passed.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          asked.push({
            parented: args.length > 1,
            message: (args.at(-1) as { message: string }).message,
            opacity: win?.getOpacity() ?? -1,
          });
          return { response: 0, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      });
      const recoveryAsked = () =>
        app.evaluate(
          () =>
            (
              globalThis as unknown as {
                e2eRecoveryAsked: {
                  parented: boolean;
                  message: string;
                  opacity: number;
                }[];
              }
            ).e2eRecoveryAsked,
        );
      // Asked from main: the Playwright page of a crashed renderer cannot be used again.
      const coverOpen = () =>
        app.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!contents) return 'no window';
          const answer = contents
            .executeJavaScript(
              `(() => {
                const cover = document.querySelector('[data-testid="app-lock-cover"]');
                const workspace = document.querySelector('trn-root > div');
                return cover?.hasAttribute('open') && window.__e2eCrashed !== true &&
                  !!workspace && getComputedStyle(workspace).visibility === 'hidden'
                  ? 'locked' : 'not locked';
              })()`,
            )
            .catch((error: unknown) => `script failed: ${String(error)}`);
          const late = new Promise<string>((resolve) =>
            setTimeout(() => resolve('script did not answer'), 2_000),
          );
          return Promise.race([answer, late]);
        });
      const crash = () =>
        app.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          await contents?.executeJavaScript('window.__e2eCrashed = true');
          contents?.forcefullyCrashRenderer();
        });

      await hide();
      if (holds) await expect.poll(opacity).toBe(0);
      // The first crash reloads at once, still hidden.
      await crash();
      await expect.poll(coverOpen, { timeout: 30_000 }).toBe('locked');
      if (holds) expect(await opacity()).toBe(0);
      // The second one, this soon after, waits to ask until the window is back on screen.
      await crash();
      await show();
      await expect
        .poll(async () => (await recoveryAsked()).length, { timeout: 30_000 })
        .toBe(1);
      const [question] = await recoveryAsked();
      expect(question?.message).toBe(`${appName} stopped working`);
      if (holds) {
        expect(question?.parented).toBe(false);
        expect(question?.opacity).toBe(0);
      }
      await expect.poll(coverOpen, { timeout: 30_000 }).toBe('locked');
      if (holds) await expect.poll(opacity, { timeout: 15_000 }).toBe(1);
    } finally {
      await app.close();
    }
  });
});
