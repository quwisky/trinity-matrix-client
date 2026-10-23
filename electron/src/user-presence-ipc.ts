import { app, ipcMain, safeStorage, systemPreferences } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import * as path from 'node:path';
import {
  PIN_FILE_NAME,
  PinVerifier,
  type PinStatus,
} from './app-lock-pin-store';
import {
  presenceReason,
  systemPresenceDriver,
  type SystemPresenceDriver,
} from './user-presence';
import { getMainWindow } from './window';
import { loadWindowsHello, windowsBuild } from './windows-hello';

// preload.ts mirrors these by string value.
export const USER_PRESENCE_SUPPORT_CHANNEL =
  'trinity:host:v1:user-presence:support';
export const USER_PRESENCE_VERIFY_CHANNEL =
  'trinity:host:v1:user-presence:verify';
export const USER_PRESENCE_SET_PIN_CHANNEL =
  'trinity:host:v1:user-presence:set-pin';
export const USER_PRESENCE_VERIFY_PIN_CHANNEL =
  'trinity:host:v1:user-presence:verify-pin';
export const USER_PRESENCE_CLEAR_PIN_CHANNEL =
  'trinity:host:v1:user-presence:clear-pin';

const NOT_SUPPORTED = { kind: 'unavailable', reason: 'not-supported' } as const;
const SENDER_REJECTED = {
  kind: 'rejected',
  diagnostic: { code: 'sender-rejected' },
} as const;
const CLEAR_FAILED = {
  kind: 'rejected',
  diagnostic: { code: 'pin-clear-failed' },
} as const;
const PIN_UNREADABLE = {
  kind: 'unavailable',
  reason: 'secure-storage-unavailable',
} as const;

function trusted(event: IpcMainInvokeEvent): boolean {
  const win = getMainWindow();
  return !!win && event.sender === win.webContents;
}

/** The PIN field of a request; main alone validates it (4–16 ASCII digits). */
function pinOf(raw: unknown): unknown {
  return raw && typeof raw === 'object'
    ? (raw as { readonly pin?: unknown }).pin
    : undefined;
}

/**
 * The PIN half of support. A record that cannot be read is reported, never "not set";
 * a host with no usable store and no record has no PIN store at all.
 */
async function pinSupport(pins: PinVerifier) {
  let status: PinStatus;
  try {
    status = await pins.status();
  } catch {
    return PIN_UNREADABLE;
  }
  switch (status.kind) {
    case 'ready':
      return {
        kind: 'available',
        set: status.set,
        nextAttemptAt: status.nextAttemptAt,
      } as const;
    case 'unavailable':
      return PIN_UNREADABLE;
    case 'not-supported':
      return NOT_SUPPORTED;
    default: {
      const unhandled: never = status;
      void unhandled;
      return PIN_UNREADABLE;
    }
  }
}

/**
 * This computer's system prompt: Touch ID on macOS, Windows Hello through the addon on
 * Windows (a missing or broken addon leaves the Trinity PIN alone), none elsewhere.
 */
export function defaultPresenceDriver(
  platform: NodeJS.Platform = process.platform,
): SystemPresenceDriver {
  return systemPresenceDriver(
    platform,
    platform === 'win32'
      ? {
          systemPreferences,
          windowsHello: loadWindowsHello({
            packaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            require: (file) => createRequire(__filename)(file),
          }),
          windowsBuild: windowsBuild(release()),
        }
      : { systemPreferences },
  );
}

/**
 * Wire the `user-presence` host operation. Every channel serves only the main window's
 * renderer and validates its payload before native work; errors carry stable codes only,
 * and no answer carries the PIN, its hash or its salt.
 */
export function registerUserPresenceIpc(
  driver: SystemPresenceDriver = defaultPresenceDriver(),
  pins: PinVerifier = new PinVerifier({
    safeStorage,
    file: path.join(app.getPath('userData'), PIN_FILE_NAME),
  }),
): void {
  ipcMain.handle(USER_PRESENCE_SUPPORT_CHANNEL, async (event) => {
    if (!trusted(event)) return { system: NOT_SUPPORTED, pin: NOT_SUPPORTED };
    let system: unknown;
    try {
      system = await driver.support();
    } catch {
      // A driver that cannot report reads as no system prompt; its text never crosses IPC.
      system = NOT_SUPPORTED;
    }
    return { system, pin: await pinSupport(pins) };
  });

  ipcMain.handle(USER_PRESENCE_VERIFY_CHANNEL, async (event, raw: unknown) => {
    if (!trusted(event)) {
      return SENDER_REJECTED;
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

  ipcMain.handle(USER_PRESENCE_SET_PIN_CHANNEL, async (event, raw: unknown) => {
    if (!trusted(event)) return SENDER_REJECTED;
    let result: Awaited<ReturnType<PinVerifier['set']>>;
    try {
      result = await pins.set(pinOf(raw));
    } catch {
      return NOT_SUPPORTED;
    }
    switch (result) {
      case 'completed':
        return { kind: 'completed' };
      case 'invalid':
        return { kind: 'rejected', diagnostic: { code: 'pin-invalid' } };
      case 'unavailable':
        return NOT_SUPPORTED;
      default: {
        const unhandled: never = result;
        void unhandled;
        return NOT_SUPPORTED;
      }
    }
  });

  ipcMain.handle(
    USER_PRESENCE_VERIFY_PIN_CHANNEL,
    async (event, raw: unknown) => {
      if (!trusted(event)) return SENDER_REJECTED;
      try {
        return await pins.verify(pinOf(raw));
      } catch {
        return { kind: 'unavailable' };
      }
    },
  );

  ipcMain.handle(USER_PRESENCE_CLEAR_PIN_CHANNEL, async (event) => {
    if (!trusted(event)) return SENDER_REJECTED;
    // A PIN that may still be on disk fails the full reset; it never reads as "none".
    try {
      return pins.clear() === 'completed'
        ? { kind: 'completed' }
        : CLEAR_FAILED;
    } catch {
      return CLEAR_FAILED;
    }
  });
}
