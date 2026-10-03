import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Candidate on-disk locations for an icon asset shipped in `electron/build/`.
 * The asset is made available at runtime via electron-builder `extraResources`
 * (Resources/build) when packaged. We probe a small set of locations so it
 * resolves in dev (run from `electron/`), when packaged (asar app root +
 * extracted resources), or if ever copied beside the compiled main.
 *
 * Shared by the tray + notification icon resolvers.
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

/** BrowserWindow icon options: the generated icon on Windows/Linux, the bundle icon on macOS. */
export function windowIconOptions(platform: NodeJS.Platform): {
  icon?: string;
} {
  return platform === 'darwin' ? {} : { icon: resolveIconFile('icon.png') };
}
