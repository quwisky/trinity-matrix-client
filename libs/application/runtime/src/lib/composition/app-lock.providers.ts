import {
  DestroyRef,
  computed,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AppearanceEffects } from '@trinity/application/appearance';
import { QR_SCANNER_SUSPENDED } from '@trinity/components/controls';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import {
  NOTIFICATION_TEXT,
  type NotificationTextPort,
  type NotificationVisibilityPort,
} from '@trinity/data-access/notifications';
import {
  CONVERSATION_ATTENTION,
  type ConversationAttention,
} from '@trinity/data-access/timeline';
import { HostCapabilitiesService } from '@trinity/runtime/host';
import {
  EMPTY,
  catchError,
  concat,
  defer,
  firstValueFrom,
  ignoreElements,
  switchMap,
  timeout,
} from 'rxjs';

/** A locked start's wait for the saved Appearance: a stuck read must not hold the cover back. */
const SAVED_APPEARANCE_BUDGET_MS = 500;

type Visibility = ReturnType<NotificationVisibilityPort['snapshot']>;

/** Not yet known (before hydration) counts as covered: fails closed like `whenUnlocked`. */
export function appLockCovers(status: AppLockStatus): boolean {
  return status !== 'off' && status !== 'unlocked';
}

/** While locked nobody is looking: the open room notifies like any other. */
export function visibilityWhileLocked(
  visibility: Visibility,
  locked: boolean,
): Visibility {
  return locked
    ? { foreground: false, hidden: visibility.hidden, conversation: null }
    : visibility;
}

/**
 * App lock's application wiring. The initializer holds the first render until the lock
 * state is known, so a locked app never paints a room, a dialog or the startup status
 * first. A locked start applies the saved Appearance so the cover doesn't flash light.
 */
export function appLockProviders(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      const appLock = inject(AppLockService);
      const appearance = inject(AppearanceEffects);
      // Hydration can read presence support during a failed negotiation, as "none".
      inject(HostCapabilitiesService)
        .recovered.pipe(
          switchMap(() => appLock.refreshSupport()),
          takeUntilDestroyed(inject(DestroyRef)),
        )
        .subscribe();
      return firstValueFrom(
        concat(
          appLock.hydrate().pipe(ignoreElements()),
          defer(() =>
            appLock.status() === 'locked' ? appearance.applySaved() : EMPTY,
          ).pipe(
            timeout({ first: SAVED_APPEARANCE_BUDGET_MS, with: () => EMPTY }),
            ignoreElements(),
            catchError(() => EMPTY),
          ),
        ),
        { defaultValue: undefined },
      );
    }),
    {
      // Conversations hold read receipts while nobody is looking.
      provide: CONVERSATION_ATTENTION,
      useFactory: (): ConversationAttention => {
        const appLock = inject(AppLockService);
        return {
          attentive: computed(() => !appLockCovers(appLock.status())),
        };
      },
    },
    {
      // A lock only covers the screen: the camera must not keep running beneath it.
      provide: QR_SCANNER_SUSPENDED,
      useFactory: () => inject(AppLockService).locked,
    },
    {
      // Always hide until App lock's settings are known (see effectiveNotificationText).
      provide: NOTIFICATION_TEXT,
      useFactory: (): NotificationTextPort => {
        const appLock = inject(AppLockService);
        return { mode: () => appLock.effectiveNotificationText() };
      },
    },
  ]);
}
