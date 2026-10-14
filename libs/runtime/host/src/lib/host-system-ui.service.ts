import { Injectable, computed, signal } from '@angular/core';
import { Observable, defer, finalize } from 'rxjs';

/**
 * Counts system UI Trinity itself put up: the user-presence prompt, a native save or share
 * sheet, the camera and the photo picker. App lock's away timer ignores time spent there,
 * so taking a photo or confirming Face ID never locks the app behind the person using it.
 */
@Injectable({ providedIn: 'root' })
export class HostSystemUiService {
  private readonly open = signal(0);

  readonly active = computed(() => this.open() > 0);

  /**
   * Cold: counts from subscription until the work completes, errors or is unsubscribed.
   * It writes a signal: never call it or subscribe to it inside `computed()`.
   */
  track<T>(work: Observable<T>): Observable<T> {
    return defer(() => {
      this.open.update((count) => count + 1);
      let ended = false;
      return work.pipe(
        finalize(() => {
          if (ended) return;
          ended = true;
          this.open.update((count) => Math.max(0, count - 1));
        }),
      );
    });
  }
}
