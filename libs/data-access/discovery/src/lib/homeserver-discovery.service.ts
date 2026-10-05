import { Injectable, inject } from '@angular/core';
import { AutoDiscovery } from 'matrix-js-sdk';
import { Observable, defer, from, map } from 'rxjs';
import { HostNetworkPolicyService } from '@trinity/platform-native';

/** Discovery result for a user-entered Matrix homeserver or MXID. */
export interface HomeserverDiscoveryResult {
  readonly domain: string;
  readonly baseUrl: string;
}

// #978: the SDK's own 5 s abort is hard-coded and its fetch failures look like a definitive "no
// homeserver", so we own the per-attempt budget (8 s) and retry thrown failures twice (0.5 s, 1 s).
const ATTEMPT_TIMEOUT_MS = 8_000;
const RETRY_DELAYS_MS = [500, 1_000];

/**
 * `fetch` for the SDK's discovery requests. Only a thrown failure (timeout, network error) is
 * retried; any HTTP response, including 404/500, is returned untouched as a definitive answer.
 */
async function fetchWithRetry(
  resource: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      // Replaces the SDK's signal: it is already aborted by the time a retry would reuse it.
      return await fetch(resource, { ...init, signal: abort.signal });
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Owns `.well-known` homeserver discovery before authentication begins. */
@Injectable({ providedIn: 'root' })
export class HomeserverDiscoveryService {
  private readonly hostNetworkPolicy = inject(HostNetworkPolicyService);

  constructor() {
    AutoDiscovery.setFetchFn(fetchWithRetry);
  }

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
