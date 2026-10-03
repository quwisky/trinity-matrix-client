import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppIconName } from './icons';

const STATE_FILE = 'app-icon.json';

export function isAppIconName(value: unknown): value is AppIconName {
  return value === 'blurple' || value === 'dark';
}

/**
 * The last icon the renderer chose, read before the window and tray exist so a Dark
 * user never sees the blurple icon flash at startup.
 */
export function storedAppIcon(): AppIconName {
  try {
    const state: unknown = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), STATE_FILE), 'utf8'),
    );
    return typeof state === 'object' &&
      state !== null &&
      'icon' in state &&
      isAppIconName(state.icon)
      ? state.icon
      : 'blurple';
  } catch {
    return 'blurple';
  }
}

export function saveAppIcon(icon: AppIconName): void {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), STATE_FILE),
      JSON.stringify({ icon }),
    );
  } catch {
    // Losing this only means the next start shows the previous icon until the renderer applies.
  }
}
