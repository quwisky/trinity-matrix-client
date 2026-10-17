import { InjectionToken } from '@angular/core';

export interface ReleaseNote {
  readonly version: string;
  readonly date: string;
  readonly sections: {
    readonly added?: readonly string[];
    readonly fixed?: readonly string[];
    readonly changed?: readonly string[];
    readonly reverted?: readonly string[];
  };
}

/** Bundled release notes, newest first. Empty unless the build generated them. */
export const RELEASE_NOTES = new InjectionToken<readonly ReleaseNote[]>(
  'RELEASE_NOTES',
  { providedIn: 'root', factory: () => [] },
);
