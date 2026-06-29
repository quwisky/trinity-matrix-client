import { Menu, nativeImage, Tray } from 'electron';
import * as fs from 'node:fs';
import { iconCandidatePaths } from './icons';
import { focusMainWindow, requestQuit } from './window';

// The reference is held in module scope so the tray is not garbage-collected
// (which would make it vanish).
let tray: Tray | null = null;

/**
 * Resolve the platform tray icon as a NativeImage.
 *
 * macOS uses a monochrome *template* image (`…Template.png`, black + alpha) that
 * the system recolors for light/dark menubars; Windows/Linux use the colored
 * PNG. Never throws if the asset is missing.
 */
function resolveTrayIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const fileName = isMac ? 'trinityTrayTemplate.png' : 'trinityTray.png';

  for (const candidate of iconCandidatePaths(fileName)) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const image = nativeImage.createFromPath(candidate);
      if (image.isEmpty()) {
        continue;
      }
      if (isMac) {
        image.setTemplateImage(true);
      }
      return image;
    } catch {
      // try next candidate
    }
  }

  console.warn('[tray] icon asset not found; tray may not render', { fileName });
  return nativeImage.createEmpty();
}

/**
 * System tray so the app keeps running (and syncing, and notifying) in the
 * background after the window is closed to tray. Click / double-click reveals
 * the window; the context menu offers an explicit "Quit" that sets `isQuitting`
 * (via requestQuit) so the app really exits.
 */
export function createTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(resolveTrayIcon());
  tray.setToolTip('Trinity');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Trinity', click: () => focusMainWindow() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => requestQuit(),
    },
  ]);
  tray.setContextMenu(contextMenu);

  // Left-click reveals on Linux/macOS; Windows convention is double-click.
  tray.on('click', () => focusMainWindow());
  tray.on('double-click', () => focusMainWindow());
}
