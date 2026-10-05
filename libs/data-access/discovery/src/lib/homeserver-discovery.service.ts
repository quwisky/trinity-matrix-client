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
// homeserver". Only the first (cold) request is slow, so it gets 8 s and the retries 5 s each, with
// 0.5 s and 1 s backoff: at most 8 + 0.5 + 5 + 1 + 5 = 19.5 s per request, 39 s for well-known + versions.
const ATTEMPT_TIMEOUTS_MS = [8_000, 5_000, 5_000];
const RETRY_DELAYS_MS = [500, 1_000];
const RETRIED_PATH =
  /\/(\.well-known\/matrix\/client|_matrix\/client\/versions)$/;

/**
 * `fetch` for the SDK's discovery requests. Only a thrown failure (timeout, network error, or a
 * body that stalls) of the well-known and versions requests is retried; any HTTP response, including
 * 404/500, is a definitive answer. Other requests (the ignored identity server) pass straight through.
 */
async function fetchWithRetry(
  resource: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = resource instanceof Request ? resource.url : String(resource);
  if (!RETRIED_PATH.test(new URL(url).pathname)) {
    return fetch(resource, init);
  }
  for (let attempt = 0; ; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ATTEMPT_TIMEOUTS_MS[attempt]);
    try {
      // Replaces the SDK's signal: it is already aborted by the time a retry would reuse it.
      // A caller-supplied `init.signal` is dropped on purpose (the SDK only passes its own 5 s
      // timeoutSignal today); chain it here if a future SDK passes a real cancel signal.
      const res = await fetch(resource, { ...init, signal: abort.signal });
      // Read the body inside the attempt so a stall after the headers is also timed out and retried.
      const body = await res.arrayBuffer();
      return new Response(body.byteLength ? body : null, res);
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
