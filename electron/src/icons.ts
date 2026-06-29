import { app } from 'electron';
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
