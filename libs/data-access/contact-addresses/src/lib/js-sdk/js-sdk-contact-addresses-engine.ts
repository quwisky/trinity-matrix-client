import { Injectable, inject } from '@angular/core';
import { Method, type MatrixClient } from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of } from 'rxjs';
import {
  JS_SDK_CLIENTS,
  uiaChallengeOf,
} from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  type UiaAuth,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import type {
  ContactAddressesEngine,
  OpenIdToken,
  ThreePid,
} from '../contact-addresses-engine';

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  const challenge = uiaChallengeOf(error);
  if (challenge) {
    return { kind, code: 'uia-required', diagnostic, params: { challenge } };
  }
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

// The SDK's account-data map is closed over spec events; `m.accepted_terms` is reached
// through a narrow string-keyed view.
function readAccountData(client: MatrixClient, type: string): Promise<unknown> {
  return (
    client.getAccountDataFromServer.bind(client) as (
      type: string,
    ) => Promise<unknown>
  )(type);
}

@Injectable({ providedIn: 'root' })
export class JsSdkContactAddressesEngine implements ContactAddressesEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  threePids(accountId: string): Observable<
    EngineResult<{
      readonly addresses: readonly ThreePid[];
      readonly canChange: boolean;
    }>
  > {
    return this.request(accountId, async (client) => {
      const [{ threepids }, capabilities] = await Promise.all([
        client.getThreePids(),
        client.getCapabilities(),
      ]);
      return {
        addresses: threepids.map(({ medium, address }) => ({
          medium,
          address,
        })),
        canChange: capabilities['m.3pid_changes']?.enabled !== false,
      };
    });
  }

  requestAddEmailToken(
    accountId: string,
    request: {
      readonly email: string;
      readonly clientSecret: string;
      readonly sendAttempt: number;
    },
  ): Observable<EngineResult<{ readonly sid: string }>> {
    return this.request(accountId, async (client) => {
      const { sid } = await client.requestAdd3pidEmailToken(
        request.email,
        request.clientSecret,
        request.sendAttempt,
      );
      return { sid };
    });
  }

  addThreePid(
    accountId: string,
    request: { readonly sid: string; readonly clientSecret: string },
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.addThreePidOnly({
        sid: request.sid,
        client_secret: request.clientSecret,
        // The SDK types `auth` as `{ type }`, but a fallback stage answers with `{ session }` alone.
        ...(auth
          ? {
              auth: auth as Parameters<
                typeof client.addThreePidOnly
              >[0]['auth'],
            }
          : {}),
      });
      return null;
    });
  }

  deleteThreePid(
    accountId: string,
    medium: string,
    address: string,
  ): Observable<EngineResult<{ readonly unbind: 'success' | 'no-support' }>> {
    return this.request(accountId, async (client) => {
      const { id_server_unbind_result } = await client.deleteThreePid(
        medium,
        address,
      );
      return {
        unbind:
          id_server_unbind_result === 'no-support' ? 'no-support' : 'success',
      };
    });
  }

  identityServerSetting(accountId: string): Observable<
    EngineResult<{
      readonly account: { readonly baseUrl: string | null } | null;
      readonly wellKnown: string | null;
    }>
  > {
    return this.request(accountId, async (client) => {
      const stored = await client.getAccountDataFromServer('m.identity_server');
      // Null while no well-known poll period is configured, which Trinity does not set.
      const wellKnown =
        client.getClientWellKnown()?.['m.identity_server']?.base_url;
      return {
        account: stored
          ? {
              baseUrl:
                typeof stored.base_url === 'string' ? stored.base_url : null,
            }
          : null,
        wellKnown: typeof wellKnown === 'string' ? wellKnown : null,
      };
    });
  }

  setIdentityServer(
    accountId: string,
    baseUrl: string | null,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.setAccountData('m.identity_server', { base_url: baseUrl });
      return null;
    });
  }

  acceptedTerms(
    accountId: string,
  ): Observable<EngineResult<readonly string[]>> {
    return this.request(accountId, async (client) => {
      const data = (await readAccountData(client, 'm.accepted_terms')) as {
        readonly accepted?: unknown;
      } | null;
      return Array.isArray(data?.accepted)
        ? data.accepted.filter((u): u is string => typeof u === 'string')
        : [];
    });
  }

  setAcceptedTerms(
    accountId: string,
    urls: readonly string[],
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await (
        client.setAccountData.bind(client) as (
          type: string,
          content: unknown,
        ) => Promise<unknown>
      )('m.accepted_terms', { accepted: [...urls] });
      return null;
    });
  }

  openIdToken(accountId: string): Observable<EngineResult<OpenIdToken>> {
    return this.request(accountId, async (client) => {
      const token = await client.getOpenIdToken();
      return {
        accessToken: token.access_token,
        tokenType: token.token_type,
        matrixServerName: token.matrix_server_name,
        expiresIn: token.expires_in,
      };
    });
  }

  bindThreePid(
    accountId: string,
    request: {
      readonly sid: string;
      readonly clientSecret: string;
      readonly idServer: string;
      readonly idAccessToken: string;
    },
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.bindThreePid({
        sid: request.sid,
        client_secret: request.clientSecret,
        id_server: request.idServer,
        id_access_token: request.idAccessToken,
      });
      return null;
    });
  }

  // The SDK's unbindThreePid reads the server from client state, so the request is sent raw.
  unbindThreePid(
    accountId: string,
    request: {
      readonly medium: 'email';
      readonly address: string;
      readonly idServer: string;
    },
  ): Observable<EngineResult<'success' | 'no-support'>> {
    return this.request(accountId, async (client) => {
      const { id_server_unbind_result } = await client.http.authedRequest<{
        id_server_unbind_result?: string;
      }>(Method.Post, '/account/3pid/unbind', undefined, {
        medium: request.medium,
        address: request.address,
        id_server: request.idServer,
      });
      return id_server_unbind_result === 'no-support'
        ? 'no-support'
        : 'success';
    });
  }

  // The client is looked up on subscribe: a client read earlier is stale after a re-login.
  private request<T>(
    accountId: string,
    run: (client: MatrixClient) => Promise<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      return from(run(client)).pipe(
        map((value) => engineOk(value)),
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }
}
