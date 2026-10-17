import { Injectable, inject } from '@angular/core';
import {
  BUILD_INFO,
  DevicePreferenceStorageService,
} from '@trinity/platform-native';
import { catchError, map, of, switchMap, type Observable } from 'rxjs';
import { RELEASE_NOTES, type ReleaseNote } from './release-notes';
import {
  compareReleaseVersions,
  hasEntries,
  releasesSince,
} from './release-version';

const LAST_SEEN_KEY = 'trinity.whats-new.last-seen-version';

/** Decides which bundled release notes this device has not seen yet. Never errors. */
@Injectable({ providedIn: 'root' })
export class WhatsNewService {
  private readonly storage = inject(DevicePreferenceStorageService);
  private readonly running = inject(BUILD_INFO).version;

  /** Every bundled release that has user-facing entries, newest first. */
  readonly all: readonly ReleaseNote[] =
    inject(RELEASE_NOTES).filter(hasEntries);

  /**
   * Notes newer than the stored version. When it returns none it stores the running
   * version itself (not when storage cannot be read); when it returns notes it stores
   * nothing: the caller calls {@link markSeen} before opening the dialog and opens it
   * only if that write succeeded.
   */
  pending(): Observable<readonly ReleaseNote[]> {
    return this.storage.get(LAST_SEEN_KEY).pipe(
      switchMap((stored) => {
        const unseen =
          stored !== null &&
          compareReleaseVersions(stored, this.running) !== null
            ? releasesSince(this.all, stored, this.running)
            : [];
        return unseen.length > 0
          ? of<readonly ReleaseNote[]>(unseen)
          : this.markSeen().pipe(map((): readonly ReleaseNote[] => []));
      }),
      catchError(() => of<readonly ReleaseNote[]>([])),
    );
  }

  /** Stores the running version: true when written, false when the write failed. Never errors. */
  markSeen(): Observable<boolean> {
    return this.storage.set(LAST_SEEN_KEY, this.running).pipe(
      map(() => true),
      catchError(() => of(false)),
    );
  }
}
