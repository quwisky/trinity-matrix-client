import { InjectionToken, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  HomeserverCapabilities,
  ServerSoftware,
} from './homeserver-info.model';
import { JsSdkHomeserverEngine } from './js-sdk/js-sdk-homeserver-engine';

/** What one account's homeserver says about itself. Plain data. */
export interface HomeserverProbe {
  readonly serverName: string;
  /** The client base URL, without a trailing slash. */
  readonly baseUrl: string;
  readonly software: ServerSoftware | null;
  readonly specVersions: readonly string[] | null;
  readonly unstableFeatures: readonly string[] | null;
  readonly capabilities: HomeserverCapabilities | null;
}

export interface HomeserverEngine {
  /**
   * Ask the account's homeserver about itself. Cold; emits once and completes. Emits `null`
   * when there is no session for the account. Never errors: an unreachable server yields a
   * probe whose remote fields are null.
   */
  probe(accountId: string): Observable<HomeserverProbe | null>;
}

export const HOMESERVER_ENGINE = new InjectionToken<HomeserverEngine>(
  'HOMESERVER_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkHomeserverEngine) },
);
