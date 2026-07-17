import { ipcMain } from 'electron';
import { allowCorsOrigin, setAllowedCorsOrigins } from './cors';
import { getMainWindow } from './window';

/** Channel the renderer publishes its live origin set on. */
export const SET_CORS_ORIGINS_CHANNEL = 'trinity:cors:set-allowed-origins';
/** Channel for additively allowing one origin (discovery / login, pre-account). */
export const ALLOW_CORS_ORIGIN_CHANNEL = 'trinity:cors:allow-origin';

/**
 * Wire the CORS-allowlist IPC. The main process cannot know which homeservers are in
 * play — the renderer picks them at login, there may be several (multi-account), and
 * `.well-known` discovery probes an origin the user has only just typed. So the
 * renderer publishes the set and main scopes {@link installMatrixCors} to it.
 *
 * Treated as untrusted, like every other channel here: only our own main window's
 * renderer is served, and a malformed payload is ignored rather than throwing.
 */
export function registerCorsIpc(): void {
  ipcMain.on(SET_CORS_ORIGINS_CHANNEL, (event, raw: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      return;
    }
    if (!Array.isArray(raw) || !raw.every((o) => typeof o === 'string')) {
      return; // malformed — leave the current allowlist as-is
    }
    setAllowedCorsOrigins(raw);
  });

  ipcMain.on(ALLOW_CORS_ORIGIN_CHANNEL, (event, raw: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents || typeof raw !== 'string') {
      return;
    }
    allowCorsOrigin(raw);
  });
}
