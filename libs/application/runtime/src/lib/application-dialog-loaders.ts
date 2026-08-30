import { InjectionToken, type Type } from '@angular/core';
import type { Observable } from 'rxjs';

/** One cold lazy component loader supplied by the application composition root. */
export type ApplicationDialogLoader = () => Observable<Type<unknown>>;

/** Trust flows that Application Runtime may present as lazy dialogs. */
export type EncryptionDialogKind = 'unlock' | 'verify';

/** Cold lazy loaders supplied by the application composition root. */
export type EncryptionDialogLoaders = Record<
  EncryptionDialogKind,
  ApplicationDialogLoader
>;

/** Keeps Application Runtime independent of the Settings feature implementation. */
export const SETTINGS_DIALOG_COMPONENT =
  new InjectionToken<ApplicationDialogLoader>('SETTINGS_DIALOG_COMPONENT');

/**
 * Keeps Application Runtime independent of the Trust feature while allowing it
 * to present routed pages as dialogs on hosts that support that placement.
 */
export const ENCRYPTION_DIALOG_COMPONENTS =
  new InjectionToken<EncryptionDialogLoaders>('ENCRYPTION_DIALOG_COMPONENTS');
