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

/**
 * R1's Graphite dark `--trinity-surface-app` (oklch(16% 0.004 270deg)) and `--trinity-text`
 * (oklch(90% 0.004 270deg)) as sRGB hex, converted once by hand: the window background and
 * the native button strip paint these until the renderer sends the live theme's colours.
 * Update them together with the tokens in libs/theme-foundation/styles/internal/variables.scss.
 */
export const GRAPHITE_DARK_SURFACE_APP = '#0d0d0f';
const GRAPHITE_DARK_TEXT = '#dddee1';

/** The renderer reads this switch to know whether to draw its own title row. */
export function titleBarArgument(prefs: WindowPrefs): string {
  return `--trinity-title-bar=${prefs.systemTitleBar ? 'system' : 'row'}`;
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

/** Frameless window options; the renderer corrects the overlay colours on load. */
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
    titleBarOverlay: {
      color: GRAPHITE_DARK_SURFACE_APP,
      symbolColor: GRAPHITE_DARK_TEXT,
      height: 32,
    },
  };
}
