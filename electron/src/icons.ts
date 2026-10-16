import { app, nativeImage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Candidate locations for an icon asset in `electron/build/`, so it resolves in dev (run
 * from `electron/`), packaged (electron-builder `extraResources`, or the asar app root),
 * or copied beside the compiled main. Shared by the tray and notification icon resolvers.
 */
export function iconCandidatePaths(fileName: string): string[] {
  return [
    path.join(process.resourcesPath, 'build', fileName), // packaged: extraResources
    path.join(app.getAppPath(), 'build', fileName), // dev (electron/) + asar root
    path.join(__dirname, '..', 'build', fileName), // dist/ -> build/
    path.join(__dirname, fileName), // alongside compiled main
  ];
}

/** First existing candidate for an `electron/build/` asset, or `undefined`. */
export function resolveIconFile(fileName: string): string | undefined {
  return iconCandidatePaths(fileName).find((candidate) =>
    fs.existsSync(candidate),
  );
}

/** The tray image for a platform: a template on macOS, a larger icon for Linux AppIndicators. */
export function trayIconFile(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'trinityTrayTemplate.png';
  return platform === 'linux' ? 'trinityTrayLinux.png' : 'trinityTray.png';
}

// The 256 px app icon (notificationIcon.png), decoded once for every BrowserWindow and Linux
// notifications. `undefined` not yet resolved, `null` none found.
let appIconCache: Electron.NativeImage | null | undefined;

/** The shared 256 px app icon image, or `undefined` when the asset can't be found. */
export function appIconImage(): Electron.NativeImage | undefined {
  if (appIconCache === undefined) {
    appIconCache = null;
    for (const candidate of iconCandidatePaths('notificationIcon.png')) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) {
          appIconCache = image;
          break;
        }
      } catch {
        // try next candidate
      }
    }
  }
  return appIconCache ?? undefined;
}

/** BrowserWindow icon options: the shared 256 px icon on Windows/Linux, the bundle icon on macOS. */
export function windowIconOptions(platform: NodeJS.Platform): {
  icon?: Electron.NativeImage;
} {
  if (platform === 'darwin') return {};
  const icon = appIconImage();
  return icon ? { icon } : {};
}
