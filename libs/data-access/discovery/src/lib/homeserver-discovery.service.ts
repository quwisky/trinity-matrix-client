import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, tap } from 'rxjs';
import { HostNetworkPolicyService } from '@trinity/platform-native';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { DISCOVERY_ENGINE } from './discovery-engine';

/** Discovery result for a user-entered Matrix homeserver or MXID. */
export interface HomeserverDiscoveryResult {
  readonly domain: string;
  readonly baseUrl: string;
}

/** Owns `.well-known` homeserver discovery before authentication begins. */
@Injectable({ providedIn: 'root' })
export class HomeserverDiscoveryService {
  private readonly engine = inject(DISCOVERY_ENGINE);
  private readonly hostNetworkPolicy = inject(HostNetworkPolicyService);

  /**
   * `allowOrigins: false` only reads: it declares neither the server nor its homeserver to
   * the desktop network policy, for a lookup of a name the user did not choose.
   */
  discover(
    input: string,
    { allowOrigins = true }: { readonly allowOrigins?: boolean } = {},
  ): Observable<HomeserverDiscoveryResult> {
    const domain = extractDomain(input);
    return defer(() => {
      if (allowOrigins) this.hostNetworkPolicy.allowOrigin(`https://${domain}`);
      return this.engine.discover(domain);
    }).pipe(
      unwrapEngineResult(),
      tap(({ baseUrl }) => {
        if (allowOrigins) this.hostNetworkPolicy.allowOrigin(baseUrl);
      }),
      map(({ domain, baseUrl }) => ({ domain, baseUrl })),
    );
  }
}

/** Accept `@user:server.org`, `user:server.org`, or a bare `server.org`. */
function extractDomain(input: string): string {
  const trimmed = input.trim().replace(/^@/, '');
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}
