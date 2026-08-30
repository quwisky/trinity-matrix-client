import type { TrinityApplicationDialogLoaders } from '@trinity/application/runtime';
import { defer, map } from 'rxjs';

/** Lazy product presentation selected only by this deployable application host. */
export const APPLICATION_DIALOG_LOADERS = {
  settings: () =>
    defer(() => import('@trinity/feature/settings')).pipe(
      map((module) => module.SettingsDialogComponent),
    ),
  encryption: {
    unlock: () =>
      defer(() => import('@trinity/feature/crypto')).pipe(
        map((module) => module.EncryptionUnlockPage),
      ),
    verify: () =>
      defer(() => import('@trinity/feature/crypto')).pipe(
        map((module) => module.DeviceVerificationPage),
      ),
  },
} satisfies TrinityApplicationDialogLoaders;
