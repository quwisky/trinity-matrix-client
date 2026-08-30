import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

export interface AuthenticationHomeserver {
  readonly domain: string;
  readonly baseUrl: string;
}

/**
 * Account authentication's narrow port to Discovery. The app composition root binds
 * it so the Accounts capability does not acquire a cross-capability dependency.
 */
export interface AuthenticationHomeserverDiscovery {
  discover(input: string): Observable<AuthenticationHomeserver>;
}

export const AUTHENTICATION_HOMESERVER_DISCOVERY =
  new InjectionToken<AuthenticationHomeserverDiscovery>(
    'AUTHENTICATION_HOMESERVER_DISCOVERY',
  );
