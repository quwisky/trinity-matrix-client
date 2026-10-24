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
  reportBug: () =>
    defer(() => import('@trinity/feature/settings')).pipe(
      map((module) => module.ReportBugDialogComponent),
    ),
  addToImagePack: () =>
    defer(() => import('@trinity/feature/settings')).pipe(
      map((module) => module.AddToPackDialogComponent),
    ),
  imagePackEditor: () =>
    defer(() => import('@trinity/feature/settings')).pipe(
      map((module) => module.PersonalPackComponent),
    ),
  whatsNew: () =>
    defer(() => import('@trinity/feature/whats-new')).pipe(
      map((module) => module.WhatsNewDialogComponent),
    ),
} satisfies TrinityApplicationDialogLoaders;
