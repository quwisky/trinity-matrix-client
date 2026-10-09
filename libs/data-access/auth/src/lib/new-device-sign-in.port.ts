import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

/** A sign-in that got a new device for an account this device already stores. */
export interface NewDeviceSignIn {
  readonly userId: string;
  /**
   * `false` when key backup is known not to hold every room key of the stored device;
   * `null` when its client is not live, so nothing could be checked.
   */
  readonly roomKeysBackedUp: false | null;
}

/**
 * App-composed confirmation before a new device replaces a stored one, which deletes the
 * stored device's room keys from this device. Emits true to go ahead. Deliberately has no
 * default: a host that does not bind it cannot build `AuthService` at all.
 */
export interface NewDeviceSignInPort {
  confirm(signIn: NewDeviceSignIn): Observable<boolean>;
}

export const NEW_DEVICE_SIGN_IN = new InjectionToken<NewDeviceSignInPort>(
  'auth.new-device-sign-in',
);

/** A sign-in stopped so a stored account keeps its device and room keys. */
export class NewDeviceSignInCancelledError extends Error {
  constructor(userId: string) {
    super(`Sign-in cancelled. ${userId} stays on this device with its keys.`);
    this.name = 'NewDeviceSignInCancelledError';
  }
}
