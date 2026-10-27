import { InjectionToken, type Signal, inject } from '@angular/core';
import type { SessionEngine, SessionSnapshot } from './session-engine';
import { JsSdkSessionEngine } from './js-sdk/js-sdk-session-engine';

export const SESSION_ENGINE = new InjectionToken<SessionEngine>(
  'SESSION_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkSessionEngine) },
);

/** The engine's synchronous snapshot, so plain-data readers never lag  MatrixClientService. */
export const SESSION_SNAPSHOT = new InjectionToken<Signal<SessionSnapshot>>(
  'SESSION_SNAPSHOT',
  { providedIn: 'root', factory: () => inject(JsSdkSessionEngine).snapshot },
);
