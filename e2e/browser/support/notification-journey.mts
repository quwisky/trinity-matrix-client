import { type APIRequestContext, type Page } from '../../fixtures.mts';
import { type ApiUser } from '../../support/account.mts';

/** Have the sender post one live message via the CS API; returns its body so
 * callers can assert on it. */
export async function postMessage(
  request: APIRequestContext,
  hs: string,
  sender: ApiUser,
  roomId: string,
  txnId: string,
  body: string,
): Promise<string> {
  const response = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    { headers: sender.headers, data: { msgtype: 'm.text', body } },
  );
  const json = await response.json();
  return json.event_id as string;
}

/**
 * Recorder for both Web Notification delivery paths NotificationService can
 * take (see notification.service.ts `show()`):
 *
 *  - the renderer `new Notification(title, options)` constructor (desktop
 *    browsers, and this app in the e2e build — the service worker is only
 *    `enabled` on a *production* build, and e2e serves the `development`
 *    config, so no SW ever controls the page here); and
 *  - `navigator.serviceWorker.ready.then(reg => reg.showNotification(...))`
 *    (taken instead when a SW *does* control the page).
 *
 * Every call, from either path, is appended to `window.__notifications` as
 * `{ title, options }`. Registered via `page.addInitScript` so it's in place
 * before the app's first script runs, on every navigation in the page
 * (including the /login → /rooms redirect `login()` drives).
 */
export async function installNotificationRecorder(page: Page): Promise<void> {
  function install(): void {
    const w = window as typeof window & {
      __notifications: Array<{
        title: string;
        options: unknown;
        instance?: { onclick: (() => void) | null };
      }>;
      __notificationRecorderInstalled?: boolean;
    };
    if (w.__notificationRecorderInstalled) return;
    w.__notifications = [];

    w.__notificationRecorderInstalled = true;
    class RecordingNotification {
      static permission = 'granted';
      static requestPermission = async (): Promise<string> => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: unknown) {
        w.__notifications.push({ title, options, instance: this });
      }
      close(): void {
        /* no-op */
      }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: RecordingNotification,
    });

    // Neutralize the service-worker path so the constructor above is always the
    // one taken, AND record through it too in case a SW ever does control the
    // page (belt and braces — e2e's development build never registers one).
    if (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      navigator.serviceWorker
    ) {
      try {
        Object.defineProperty(navigator.serviceWorker, 'controller', {
          configurable: true,
          get: () => null,
        });
      } catch {
        /* some engines make `controller` non-configurable — ignore */
      }
      void navigator.serviceWorker.ready
        .then((registration) => {
          const original = registration.showNotification?.bind(registration);
          registration.showNotification = ((
            title: string,
            options?: unknown,
          ) => {
            w.__notifications.push({ title, options });
            return original
              ? original(title, options as NotificationOptions)
              : Promise.resolve();
          }) as typeof registration.showNotification;
        })
        .catch(() => {
          /* no SW registration in this build — nothing to wrap */
        });
    }
  }

  await page.addInitScript(install);
  await page.evaluate(install);
}
