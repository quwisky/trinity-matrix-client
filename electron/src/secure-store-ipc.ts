import { app, ipcMain, safeStorage } from 'electron';
import * as path from 'node:path';
import { secureStoreDelete, secureStoreGet, secureStoreSet } from './secure-store';
import { getMainWindow } from './window';

/** On-disk home for the OS-encrypted secret map (safeStorage only encrypts bytes). */
function secureStoreFile(): string {
  return path.join(app.getPath('userData'), 'trinity-secure-store.json');
}

/**
 * Wire the secure-storage IPC (renderer <-> main, request/response). The renderer
 * never sees the OS keyring or the on-disk ciphertext — it only asks main to
 * get/set/delete a key. Values are encrypted with Electron `safeStorage` (OS keychain)
 * and the base64 ciphertext is persisted to a 0600 file under `userData`. Treats the
 * channel as untrusted: only our own main window's renderer is served, and `set`
 * returns false (so the renderer can fall back) when OS encryption is unavailable.
 */
export function registerSecureStoreIpc(): void {
  ipcMain.handle('trinity:secure-store:available', (event) => {
    const win = getMainWindow();
    return !!win && event.sender === win.webContents
      ? safeStorage.isEncryptionAvailable()
      : false;
  });

  ipcMain.handle('trinity:secure-store:get', (event, rawKey: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents || typeof rawKey !== 'string') {
      return null;
    }
    return secureStoreGet(safeStorage, secureStoreFile(), rawKey);
  });

  ipcMain.handle(
    'trinity:secure-store:set',
    (event, rawKey: unknown, rawValue: unknown) => {
      const win = getMainWindow();
      if (
        !win ||
        event.sender !== win.webContents ||
        typeof rawKey !== 'string' ||
        typeof rawValue !== 'string'
      ) {
        return false;
      }
      return secureStoreSet(safeStorage, secureStoreFile(), rawKey, rawValue);
    },
  );

  ipcMain.handle('trinity:secure-store:delete', (event, rawKey: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents || typeof rawKey !== 'string') {
      return;
    }
    secureStoreDelete(secureStoreFile(), rawKey);
  });
}
