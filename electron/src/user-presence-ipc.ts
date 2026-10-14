import { ipcMain, systemPreferences } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
  presenceReason,
  systemPresenceDriver,
  type SystemPresenceDriver,
} from './user-presence';
import { getMainWindow } from './window';

// preload.ts mirrors these by string value.
export const USER_PRESENCE_SUPPORT_CHANNEL =
  'trinity:host:v1:user-presence:support';
export const USER_PRESENCE_VERIFY_CHANNEL =
  'trinity:host:v1:user-presence:verify';

const NOT_SUPPORTED = { kind: 'unavailable', reason: 'not-supported' } as const;

function trusted(event: IpcMainInvokeEvent): boolean {
  const win = getMainWindow();
  return !!win && event.sender === win.webContents;
}

/**
 * Wire the `user-presence` host operation. Every channel serves only the main window's
 * renderer and validates its payload before native work; errors carry stable codes only.
 */
export function registerUserPresenceIpc(
  driver: SystemPresenceDriver = systemPresenceDriver(process.platform, {
    systemPreferences,
  }),
): void {
  ipcMain.handle(USER_PRESENCE_SUPPORT_CHANNEL, async (event) => ({
    system: trusted(event) ? await driver.support() : NOT_SUPPORTED,
    pin: NOT_SUPPORTED,
  }));

  ipcMain.handle(USER_PRESENCE_VERIFY_CHANNEL, async (event, raw: unknown) => {
    if (!trusted(event)) {
      return { kind: 'rejected', diagnostic: { code: 'sender-rejected' } };
    }
    const reason = presenceReason(
      raw && typeof raw === 'object'
        ? (raw as { readonly reason?: unknown }).reason
        : undefined,
    );
    if (!reason) {
      return {
        kind: 'rejected',
        diagnostic: { code: 'invalid-presence-reason' },
      };
    }
    try {
      return await driver.verify(reason, getMainWindow());
    } catch {
      return { kind: 'rejected', diagnostic: { code: 'presence-failed' } };
    }
  });
}
