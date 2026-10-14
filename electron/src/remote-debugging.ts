import { app, dialog } from 'electron';

// Chromium's remote debugging switches. No Electron fuse turns them off, so a local user
// could relaunch a release build with a DevTools protocol endpoint and read a locked app.
const REMOTE_DEBUGGING_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
] as const;

/**
 * In a packaged release build (Trinity or Trinity Next) launched with a remote debugging
 * switch, show an error box and exit with code 1. Development runs keep remote debugging.
 * Returns whether startup may continue. Call first in main, before the single-instance
 * lock and before any window; dialog.showErrorBox is safe before `ready`.
 */
export function checkRemoteDebuggingOrExit(): boolean {
  if (!app.isPackaged) return true;
  if (
    !REMOTE_DEBUGGING_SWITCHES.some((name) => app.commandLine.hasSwitch(name))
  ) {
    return true;
  }
  dialog.showErrorBox(
    'Trinity cannot start',
    'Remote debugging is not available in release builds.',
  );
  app.exit(1);
  return false;
}
