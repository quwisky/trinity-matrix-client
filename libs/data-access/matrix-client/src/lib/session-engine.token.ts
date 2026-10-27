import { InjectionToken, inject } from '@angular/core';
import type { SessionEngine } from './session-engine';
import { JsSdkSessionEngine } from './js-sdk/js-sdk-session-engine';

export const SESSION_ENGINE = new InjectionToken<SessionEngine>(
  'SESSION_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkSessionEngine) },
);
