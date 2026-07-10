import { InjectionToken } from '@angular/core';

/** Identifying details of the running build, shown in Settings. */
export interface BuildInfo {
  /** App version from `package.json` (e.g. `0.0.1`). */
  version: string;
  /** Short git commit the build was made from (e.g. `a1b2c3d`), or `unknown`. */
  commit: string;
  /** ISO timestamp the build was generated at, or `''` when unknown. */
  builtAt: string;
}

/**
 * The running build's {@link BuildInfo}. Provided in `main.ts` from a file the build
 * regenerates from git + `package.json` (see `scripts/gen-build-info.mjs`), so features
 * (e.g. the Settings footer) can display the version/commit without reaching into the app.
 */
export const BUILD_INFO = new InjectionToken<BuildInfo>('BUILD_INFO');
