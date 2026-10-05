import { app } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WindowPrefs {
  /** Keep the OS title bar instead of Trinity's own title row. */
  systemTitleBar: boolean;
}

/** Injectable file access so tests never touch disk. */
export interface WindowPrefsIo {
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, data: string) => void;
  path: string;
}

const defaultPrefs: WindowPrefs = { systemTitleBar: false };

function defaultIo(): WindowPrefsIo {
  return {
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
    writeFile: (filePath, data) => fs.writeFileSync(filePath, data),
    path: path.join(app.getPath('userData'), 'window-prefs.json'),
  };
}

/** Synchronous (needed before the window exists). Any failure yields the defaults. */
export function readWindowPrefs(io: WindowPrefsIo = defaultIo()): WindowPrefs {
  try {
    const raw = JSON.parse(io.readFile(io.path)) as unknown;
    const value = (raw as { systemTitleBar?: unknown } | null)?.systemTitleBar;
    return { systemTitleBar: typeof value === 'boolean' ? value : false };
  } catch {
    return { ...defaultPrefs };
  }
}

export function writeWindowPrefs(
  prefs: WindowPrefs,
  io: WindowPrefsIo = defaultIo(),
): void {
  io.writeFile(
    io.path,
    JSON.stringify({ systemTitleBar: prefs.systemTitleBar }),
  );
}

/**
 * Frameless window options. The initial overlay colours are the Graphite dark
 * app/text values; the renderer corrects them on load.
 */
export function titleBarOptions(
  platform: NodeJS.Platform,
  prefs: WindowPrefs,
): Partial<BrowserWindowConstructorOptions> {
  if (prefs.systemTitleBar) {
    return {};
  }
  if (platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 10 } };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#29292e', symbolColor: '#dbdee1', height: 32 },
  };
}
