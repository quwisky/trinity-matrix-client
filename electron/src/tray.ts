import { Menu, nativeImage, Tray } from 'electron';
import * as fs from 'node:fs';
import { iconCandidatePaths, trayIconFile } from './icons';
import { focusMainWindow, requestQuit } from './window';
import { appIdentity } from './app-identity';

// Held in module scope so the tray is not garbage-collected (it would vanish).
let tray: Tray | null = null;

/**
 * Resolve the platform tray icon. macOS uses a monochrome template image (black + alpha)
 * that the system recolors for light and dark menubars; Windows uses a 16 px colored PNG
 * and Linux a 32 px one (AppIndicators draw larger), each with an @2x sibling. Never throws
 * if the asset is missing.
 */
function resolveTrayIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const fileName = trayIconFile(process.platform);

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

  console.warn('[tray] icon asset not found; tray may not render', {
    fileName,
  });
  return nativeImage.createEmpty();
}

/**
 * System tray, so the app keeps syncing and notifying after the window is closed to tray.
 * The context menu's explicit "Quit" goes through requestQuit so the app really exits.
 */
export function createTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(resolveTrayIcon());
  // Trinity and Trinity Next share the tray icon; the name tells them apart.
  const { productName } = appIdentity();
  tray.setToolTip(productName);

  const contextMenu = Menu.buildFromTemplate([
    { label: `Open ${productName}`, click: () => focusMainWindow() },
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
