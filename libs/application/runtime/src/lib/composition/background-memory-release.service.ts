import { ErrorHandler, Injectable, inject } from '@angular/core';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { HostLifecycleService } from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  ignoreElements,
  switchMap,
  timer,
} from 'rxjs';

/**
 * How long the app stays in the background before it frees memory. Chromium's own purge
 * waits at least a minute after a renderer is backgrounded, so a glance at another window
 * or a quick minimise never costs a refetch; nothing reloads until the app is shown again.
 */
export const BACKGROUND_RELEASE_DELAY_MS = 60_000;

/**
 * Frees what the hidden app does not show: unpinned media and avatar blobs, the warm
 * non-focused conversations and, on the desktop shell, Blink's resource caches. On-screen
 * media, held avatars and the focused conversation stay, so showing the app again needs no
 * reload; everything else comes back lazily on its next use, as after eviction.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundMemoryRelease {
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly media = inject(MediaService);
  private readonly avatars = inject(AvatarService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly errors = inject(ErrorHandler);

  run(): Observable<never> {
    return this.lifecycle.events.pipe(
      // A return to the foreground before the delay cancels the pending release.
      switchMap((event) =>
        event.kind === 'background'
          ? timer(BACKGROUND_RELEASE_DELAY_MS).pipe(
              switchMap(() => this.release()),
            )
          : EMPTY,
      ),
      ignoreElements(),
    );
  }

  private release(): Observable<unknown> {
    for (const step of [
      () => this.media.releaseUnpinned(),
      () => this.avatars.releaseUnpinned(),
      () => this.conversations.retireRetained(),
    ]) {
      try {
        step();
      } catch (error: unknown) {
        // Best effort: one failed release must not end the session's lifetime stream.
        this.errors.handleError(error);
      }
    }
    return defer(() => this.lifecycle.releaseMemory()).pipe(
      catchError(() => EMPTY),
    );
  }
}
