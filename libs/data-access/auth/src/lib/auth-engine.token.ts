import { InjectionToken, inject } from '@angular/core';
import type { AuthEngine } from './auth-engine';
import { JsSdkAuthEngine } from './js-sdk/js-sdk-auth-engine';

export const AUTH_ENGINE = new InjectionToken<AuthEngine>('AUTH_ENGINE', {
  providedIn: 'root',
  factory: () => inject(JsSdkAuthEngine),
});
