import { InjectionToken, type Type } from '@angular/core';

/** The self-initiated encryption flows that can open as a desktop modal. */
export type EncryptionDialogKind = 'unlock' | 'verify';

/** Lazy loader for a modal-mode encryption page, keyed by flow. */
export type EncryptionDialogLoaders = Record<
  EncryptionDialogKind,
  () => Promise<Type<unknown>>
>;

/**
 * Lazy loaders for the modal-mode encryption pages. Wired at the app (`main.ts`)
 * with dynamic `import('@trinity/feature/crypto')` calls, so `ui` never imports the
 * feature — keeping the `type:ui` (scope:shared) → `type:feature` (scope:matrix)
 * module boundary intact while {@link EncryptionDialogService} can still present those
 * pages as modals on desktop. Absent in `ui`-in-isolation / tests with no app
 * wiring, in which case the service always falls back to routing.
 */
export const ENCRYPTION_DIALOG_COMPONENTS =
  new InjectionToken<EncryptionDialogLoaders>('ENCRYPTION_DIALOG_COMPONENTS');
