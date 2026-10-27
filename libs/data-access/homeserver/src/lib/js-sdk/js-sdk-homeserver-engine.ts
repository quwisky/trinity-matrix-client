import { Injectable, inject } from '@angular/core';
import { Observable, defer, forkJoin, map, of } from 'rxjs';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { trimTrailing } from '@trinity/util/matrix';
import type { HomeserverEngine, HomeserverProbe } from '../homeserver-engine';
import {
  fetchCapabilities,
  fetchSpecVersions,
  probeServerSoftware,
} from '../probe-homeserver';

@Injectable({ providedIn: 'root' })
export class JsSdkHomeserverEngine implements HomeserverEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  probe(accountId: string): Observable<HomeserverProbe | null> {
    // Read on subscribe, not when built: a token read earlier is stale after an OIDC rotation.
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) {
        return of(null);
      }
      const baseUrl = trimTrailing(client.baseUrl, '/');
      const serverName = client.getDomain() ?? accountId.replace(/^.*?:/, '');
      const token = client.getAccessToken();
      return forkJoin({
        software: probeServerSoftware(baseUrl, serverName),
        versions: fetchSpecVersions(baseUrl, token),
        capabilities: fetchCapabilities(baseUrl, token),
      }).pipe(
        map(({ software, versions, capabilities }): HomeserverProbe => ({
          serverName,
          baseUrl,
          software,
          specVersions: versions?.versions ?? null,
          unstableFeatures: versions?.unstableFeatures ?? null,
          capabilities,
        })),
      );
    });
  }
}
