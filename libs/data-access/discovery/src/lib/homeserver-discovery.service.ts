import { Injectable, inject } from '@angular/core';
import { AutoDiscovery } from 'matrix-js-sdk';
import { Observable, defer, from, map } from 'rxjs';
import { HostNetworkPolicyService } from '@trinity/platform-native';

/** Discovery result for a user-entered Matrix homeserver or MXID. */
export interface HomeserverDiscoveryResult {
  readonly domain: string;
  readonly baseUrl: string;
}

/** Owns `.well-known` homeserver discovery before authentication begins. */
@Injectable({ providedIn: 'root' })
export class HomeserverDiscoveryService {
  private readonly hostNetworkPolicy = inject(HostNetworkPolicyService);

  discover(input: string): Observable<HomeserverDiscoveryResult> {
    const domain = extractDomain(input);
    return defer(() => {
      this.hostNetworkPolicy.allowOrigin(`https://${domain}`);
      return from(AutoDiscovery.findClientConfig(domain));
    }).pipe(
      map((config) => {
        const homeserver = config['m.homeserver'];
        if (
          homeserver.state === AutoDiscovery.FAIL_PROMPT ||
          homeserver.state === AutoDiscovery.FAIL_ERROR
        ) {
          const reason =
            typeof homeserver.error === 'string' ? homeserver.error : null;
          throw new Error(
            reason ?? `Could not discover a homeserver for "${domain}".`,
          );
        }
        const baseUrl = (homeserver.base_url ?? `https://${domain}`).replace(
          /\/$/,
          '',
        );
        this.hostNetworkPolicy.allowOrigin(baseUrl);
        return { domain, baseUrl };
      }),
    );
  }
}

/** Accept `@user:server.org`, `user:server.org`, or a bare `server.org`. */
function extractDomain(input: string): string {
  const trimmed = input.trim().replace(/^@/, '');
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}
