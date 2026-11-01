import type { ElectronApplication, Page } from 'playwright';

/**
 * Replace host notification presentation with a counter. The fake owns support too:
 * without libnotify (Linux CI under xvfb) main reports notifications unsupported, so the
 * renderer is never granted the operation and never presents anything.
 */
export async function installNotificationCounter(
  app: ElectronApplication,
): Promise<void> {
  await app.evaluate(({ ipcMain, Notification }) => {
    Notification.isSupported = () => true;
    const channel = 'trinity:host:v1:notification-presentation:present';
    const state = globalThis as typeof globalThis & {
      __e2eNotificationBodies?: string[];
    };
    state.__e2eNotificationBodies = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event: unknown, raw: unknown) => {
      const { body } = raw as { body?: unknown };
      state.__e2eNotificationBodies?.push(typeof body === 'string' ? body : '');
      return { kind: 'completed' };
    });
  });
}

/** Reload so the renderer negotiates its host operations again with the fakes in place. */
export async function grantNotifications(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** The body of every notification presented since the counter was installed. */
export function notificationBodies(
  app: ElectronApplication,
): Promise<string[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __e2eNotificationBodies?: string[];
    };
    return state.__e2eNotificationBodies ?? [];
  });
}
