import { Injectable, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  type Observable,
  filter,
  finalize,
  switchMap,
  takeUntil,
  throwError,
  timeout,
} from 'rxjs';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  type ConversationKey,
  ConversationRuntime,
  TimelineActionsService,
} from '@trinity/data-access/timeline';
import { GeolocationService, type GeoPoint } from '@trinity/platform-native';
import { ManualLocationDialogComponent } from './manual-location-dialog/manual-location-dialog.component';

const sameConversation = (
  a: ConversationKey | undefined,
  b: ConversationKey | undefined,
): boolean => a?.accountId === b?.accountId && a?.roomId === b?.roomId;

/**
 * Shares a location to the open room as an `m.location` message. On web/mobile it resolves
 * the device position through Capacitor's adapter (prompting for permission). On the desktop
 * shell it opens the manual-location dialog instead: Chromium's `navigator.geolocation`
 * can't resolve a position without an embedded Google API key and would stall. The resolved
 * point flows into {@link TimelineActionsService.sendLocation}; {@link sharing} tracks the
 * in-flight send.
 */
@Injectable({ providedIn: 'root' })
export class LocationShareService {
  private readonly geo = inject(GeolocationService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnSurfaceService);

  private readonly focused$ = toObservable(this.conversations.focused);

  private readonly sharingSig = signal(false);
  readonly sharing = this.sharingSig.asReadonly();

  share(): void {
    if (!this.geo.supportsPrecise()) {
      this.shareViaDialog();
      return;
    }
    // Bound the whole request: the browser's own `timeout` only starts once permission is
    // granted, so an unanswered or soft-dismissed prompt never settles and the busy state
    // would stick for the session. On timeout we error, which clears busy via `finalize`
    // and toasts.
    // The service outlives the room, so leaving it ends the wait quietly: the room opened
    // next must not inherit the busy Location action or a toast about a share it never had.
    const atStart = this.conversations.focused()?.key;
    this.send(
      this.geo.current().pipe(
        timeout({
          each: 30_000,
          with: () =>
            throwError(
              () => new Error('Location request timed out. Try again.'),
            ),
        }),
        takeUntil(
          this.focused$.pipe(
            filter((now) => !sameConversation(now?.key, atStart)),
          ),
        ),
      ),
    );
  }

  /** Desktop: pick a location by hand (Chromium can't resolve one), then send it. */
  private shareViaDialog(): void {
    this.send(
      this.dialog
        .openAndWait$<GeoPoint, ManualLocationDialogComponent>(
          ManualLocationDialogComponent,
        )
        .pipe(filter((point): point is GeoPoint => point !== null)),
    );
  }

  private send(source: Observable<GeoPoint>): void {
    this.sharingSig.set(true);
    // The point arrives after a permission prompt, a fix or a dialog, and `sendLocation` posts
    // to the room open then: exact coordinates must not reach a room opened in between.
    const atStart = this.conversations.focused()?.key;
    source
      .pipe(
        switchMap(({ lat, lng }) => {
          if (!sameConversation(this.conversations.focused()?.key, atStart)) {
            return throwError(
              () =>
                new Error('Location not shared: you left the room it was for.'),
            );
          }
          return this.timelineActions.sendLocation(lat, lng);
        }),
        finalize(() => this.sharingSig.set(false)),
      )
      .subscribe({
        error: (err: unknown) =>
          this.toast.show(
            err instanceof Error
              ? err.message
              : 'Could not share your location.',
            { duration: 4000, variant: 'danger' },
          ),
      });
  }
}
