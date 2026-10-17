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

/**
 * Keeps Application Runtime independent of the Settings feature while it opens Report a bug
 * for surfaces that cannot import Settings: the sign-in screen, System status and the desktop
 * title bar.
 */
export const REPORT_BUG_DIALOG_COMPONENT =
  new InjectionToken<ApplicationDialogLoader>('REPORT_BUG_DIALOG_COMPONENT');

/** Keeps Application Runtime independent of the What's new feature that shows release notes. */
export const WHATS_NEW_DIALOG_COMPONENT =
  new InjectionToken<ApplicationDialogLoader>('WHATS_NEW_DIALOG_COMPONENT');
