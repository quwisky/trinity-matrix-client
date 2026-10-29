import { InjectionToken, inject } from '@angular/core';
import type { TrustEngine } from './trust-engine';
import { JsSdkTrustEngine } from './js-sdk/js-sdk-trust-engine';

export const TRUST_ENGINE = new InjectionToken<TrustEngine>('TRUST_ENGINE', {
  providedIn: 'root',
  factory: () => inject(JsSdkTrustEngine),
});
