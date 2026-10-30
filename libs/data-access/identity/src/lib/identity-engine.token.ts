import { InjectionToken, inject } from '@angular/core';
import type { IdentityEngine } from './identity-engine';
import { JsSdkIdentityEngine } from './js-sdk/js-sdk-identity-engine';

export const IDENTITY_ENGINE = new InjectionToken<IdentityEngine>(
  'IDENTITY_ENGINE',
  {
    providedIn: 'root',
    factory: () => inject(JsSdkIdentityEngine),
  },
);
