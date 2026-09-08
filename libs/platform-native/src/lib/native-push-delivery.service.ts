import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, defer, from, catchError, map, of, throwError } from 'rxjs';
import { foregroundNotificationChannel } from './foreground-notification-channel';

export type NativePushForegroundKind = 'listener' | 'presentation';

interface NativePushDeliveryPlugin {
  claimPresentation(options: {
    accountRoute: string;
    eventId: string;
    channelId: string;
  }): Promise<{ claimed: boolean }>;
  badgeSupport(): Promise<{ supported: boolean }>;
  setBadge(options: { count: number }): Promise<void>;
  setForegroundOwner(options: {
    kind: NativePushForegroundKind;
    owner: string;
    active: boolean;
  }): Promise<void>;
}

const nativePushDelivery = registerPlugin<NativePushDeliveryPlugin>(
  'TrinityPushDelivery',
);
const DELIVERY_FAILURE = 'Native push delivery operation failed';

/** Coordinates Android's durable push delivery ownership with web lifetimes. */
@Injectable({ providedIn: 'root' })
export class NativePushDeliveryService {
  readonly platform = nativePushPlatform();

  claimPresentation(
    accountRoute: string,
    eventId: string,
    silent = false,
  ): Observable<boolean> {
    return defer(() =>
      this.platform !== 'android'
        ? of(true)
        : from(
            nativePushDelivery.claimPresentation({
              accountRoute,
              eventId,
              channelId: foregroundNotificationChannel(silent),
            }),
          ).pipe(map(({ claimed }) => claimed)),
    ).pipe(
      // Native failures must remain visible to the delivery caller. Keep the
      // bridge's details out of the application error surface.
      catchError(() => throwError(() => new Error(DELIVERY_FAILURE))),
    );
  }

  badgeSupport(): Observable<boolean> {
    return defer(() =>
      this.platform !== 'android'
        ? of(false)
        : from(nativePushDelivery.badgeSupport()).pipe(
            map(({ supported }) => supported),
          ),
    );
  }

  setBadge(count: number): Observable<void> {
    return defer(() =>
      this.platform !== 'android'
        ? of(void 0)
        : from(
            nativePushDelivery.setBadge({
              count: Math.min(9999, Math.max(0, Math.trunc(count))),
            }),
          ),
    );
  }

  foreground(kind: NativePushForegroundKind): Observable<void> {
    return new Observable<void>((subscriber) => {
      if (this.platform !== 'android') {
        subscriber.next();
        return;
      }

      const owner = `trinity-push-${kind}-${crypto.randomUUID()}`;
      let active = true;
      const setOwner = (ownerActive: boolean): void => {
        void Promise.resolve()
          .then(() =>
            nativePushDelivery.setForegroundOwner({
              kind,
              owner,
              active: ownerActive,
            }),
          )
          .catch(() => undefined);
      };

      void Promise.resolve()
        .then(() =>
          nativePushDelivery.setForegroundOwner({
            kind,
            owner,
            active: true,
          }),
        )
        .then(
          () => {
            if (active) subscriber.next();
            else setOwner(false);
          },
          () => {
            if (active) subscriber.error(new Error(DELIVERY_FAILURE));
          },
        );

      return () => {
        active = false;
        setOwner(false);
      };
    });
  }
}

function nativePushPlatform(): 'android' | 'ios' | null {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios' ? platform : null;
}
