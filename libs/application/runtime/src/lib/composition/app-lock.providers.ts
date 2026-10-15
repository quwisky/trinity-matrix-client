import {
  computed,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import { AppearanceEffects } from '@trinity/application/appearance';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import { type NotificationVisibilityPort } from '@trinity/data-access/notifications';
import {
  CONVERSATION_ATTENTION,
  type ConversationAttention,
} from '@trinity/data-access/timeline';
import {
  EMPTY,
  catchError,
  concat,
  defer,
  firstValueFrom,
  ignoreElements,
  timeout,
} from 'rxjs';

/**
 * How long a locked start waits for the saved Appearance (local reads) before the first
 * render, as the session-lock stage does: a stuck read must not hold the cover back.
 */
const SAVED_APPEARANCE_BUDGET_MS = 500;

type Visibility = ReturnType<NotificationVisibilityPort['snapshot']>;

/**
 * Whether App lock covers the app, so nobody can be looking at it: locked, or not yet
 * known (before hydration), which fails closed like `AppLockService.whenUnlocked`.
 */
export function appLockCovers(status: AppLockStatus): boolean {
  return status !== 'off' && status !== 'unlocked';
}

/** While locked nobody is looking: the open room notifies like any other (spec §2). */
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
 * state is known, so a locked app never paints a room, a dialog or the startup status first
 * (Review Focus 3). Hydration never errors and waits for the host at most
 * SUPPORT_TIMEOUT_MS. A locked start then puts the saved Appearance on the document, so the
 * cover paints in the person's theme instead of flashing light. It also tells Conversations
 * whether anyone can be looking ({@link CONVERSATION_ATTENTION}).
 */
export function appLockProviders(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      const appLock = inject(AppLockService);
      const appearance = inject(AppearanceEffects);
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
      // Conversations hold read receipts while nobody is looking (spec §2).
      provide: CONVERSATION_ATTENTION,
      useFactory: (): ConversationAttention => {
        const appLock = inject(AppLockService);
        return {
          attentive: computed(() => !appLockCovers(appLock.status())),
        };
      },
    },
  ]);
}
