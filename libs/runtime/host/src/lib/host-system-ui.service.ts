import { Injectable, computed, signal } from '@angular/core';
import { Observable, defer, finalize } from 'rxjs';

/**
 * Counts system UI Trinity itself put up: the user-presence prompt, a native save or share
 * sheet, the camera, the photo picker, a file chooser and the in-app browser sheet on mobile
 * (sign-in and the account provider's pages). App lock's away timer ignores time spent there,
 * so taking a photo or confirming Face ID never locks the app behind the person using it.
 */
@Injectable({ providedIn: 'root' })
export class HostSystemUiService {
  private readonly open = signal(0);
  private readonly fullScreen = signal(0);

  readonly active = computed(() => this.open() > 0);
  /**
   * System UI that covers the whole screen (the photo gallery, the camera) is open: no Trinity
   * content shows, so App lock's app-switcher cover may step aside. A sheet leaves the room in view.
   */
  readonly fullScreenActive = computed(() => this.fullScreen() > 0);

  /**
   * Cold: counts from subscription until the work completes, errors or is unsubscribed.
   * It writes a signal: never call it or subscribe to it inside `computed()`.
   */
  track<T>(
    work: Observable<T>,
    options: { readonly fullScreen?: boolean } = {},
  ): Observable<T> {
    return defer(() => {
      const counts = options.fullScreen
        ? [this.open, this.fullScreen]
        : [this.open];
      counts.forEach((count) => count.update((n) => n + 1));
      let ended = false;
      return work.pipe(
        finalize(() => {
          if (ended) return;
          ended = true;
          counts.forEach((count) => count.update((n) => Math.max(0, n - 1)));
        }),
      );
    });
  }
}
