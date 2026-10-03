import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppIconName } from './icons';

const STATE_FILE = 'app-icon.json';

/** What the renderer sends: an icon, or 'system' to leave the macOS icon to macOS. */
export type AppIconChoice = AppIconName | 'system';

export function isAppIconChoice(value: unknown): value is AppIconChoice {
  return value === 'blurple' || value === 'dark' || value === 'system';
}

/**
 * The last icon the renderer chose, read before the window and tray exist so a Dark
 * user never sees the blurple icon flash at startup.
 */
export function storedAppIcon(): AppIconName {
  const choice = storedAppIconChoice();
  return choice === 'system' ? 'blurple' : choice;
}

export function storedAppIconChoice(): AppIconChoice {
  try {
    const state: unknown = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), STATE_FILE), 'utf8'),
    );
    return typeof state === 'object' &&
      state !== null &&
      'icon' in state &&
      isAppIconChoice(state.icon)
      ? state.icon
      : 'blurple';
  } catch {
    return 'blurple';
  }
}

export function saveAppIcon(icon: AppIconChoice): void {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), STATE_FILE),
      JSON.stringify({ icon }),
    );
  } catch {
    // Losing this only means the next start shows the previous icon until the renderer applies.
  }
}
