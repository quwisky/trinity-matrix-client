import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  MatrixError,
  describeMatrixRequestFailure,
} from '@trinity/util/matrix';
import { SERVICE_TYPES } from 'matrix-js-sdk';
import { Observable, catchError, defer, from, of, switchMap } from 'rxjs';
import type {
  IdentityPolicy,
  IdentityServerChoice,
  IdentityServerRefusal,
  IdentityServerRefused,
  TermsCheck,
} from './identity-server.models';

interface AcceptedTerms {
  accepted?: string[];
}

/** Which identity server an account uses, and the access it needs to talk to it. */
@Injectable({ providedIn: 'root' })
export class IdentityServerService {
  private readonly matrix = inject(MatrixClientService);
  // Memory only: an identity access token is never persisted or logged.
  private readonly tokens = new Map<string, string>();

  choice(
    accountId: string,
  ): Observable<IdentityServerChoice | IdentityServerRefused> {
    return this.withClient(accountId, async (client) => {
      const stored = await client.getAccountDataFromServer('m.identity_server');
      if (stored) {
        return stored.base_url
          ? ({ kind: 'set', url: stored.base_url, source: 'account' } as const)
          : ({ kind: 'off' } as const);
      }
      const wellKnown =
        client.getClientWellKnown()?.['m.identity_server']?.base_url;
      return wellKnown
        ? ({ kind: 'set', url: wellKnown, source: 'well-known' } as const)
        : ({ kind: 'none' } as const);
    });
  }

  use(
    accountId: string,
    url: string,
  ): Observable<
    { readonly kind: 'saved'; readonly url: string } | IdentityServerRefused
  > {
    return defer(() => {
      const base = url.trim().replace(/\/+$/, '');
      if (!isHttps(base)) return of(refused('not-https'));
      return from(this.probe(base)).pipe(
        switchMap((ok) =>
          ok
            ? this.withClient(accountId, async (client) => {
                await client.setAccountData('m.identity_server', {
                  base_url: base,
                });
                return { kind: 'saved', url: base } as const;
              })
            : of(refused('not-identity-server')),
        ),
        catchError((err: unknown) => of(refusalOf(err))),
      );
    });
  }

  turnOff(
    accountId: string,
  ): Observable<{ readonly kind: 'saved' } | IdentityServerRefused> {
    return this.withClient(accountId, async (client) => {
      await client.setAccountData('m.identity_server', { base_url: null });
      return { kind: 'saved' } as const;
    });
  }

  terms(accountId: string, url: string): Observable<TermsCheck> {
    return this.withClient(accountId, async (client): Promise<TermsCheck> => {
      const [terms, accepted] = await Promise.all([
        client.getTerms(SERVICE_TYPES.IS, url),
        acceptedUrls(client),
      ]);
      const missing = policiesOf(terms.policies).filter(
        (policy) => !accepted.includes(policy.url),
      );
      return missing.length
        ? { kind: 'needs-consent', policies: missing }
        : { kind: 'accepted' };
    });
  }

  acceptTerms(
    accountId: string,
    url: string,
    policies: readonly IdentityPolicy[],
  ): Observable<{ readonly kind: 'accepted' } | IdentityServerRefused> {
    const urls = policies.map((policy) => policy.url);
    return this.withToken(accountId, url, (token) =>
      this.client(accountId).agreeToTerms(SERVICE_TYPES.IS, url, token, urls),
    ).pipe(
      switchMap(() =>
        this.withClient(accountId, async (client) => {
          const accepted = await acceptedUrls(client);
          await setAcceptedTerms(client, {
            accepted: [...new Set([...accepted, ...urls])],
          });
          return { kind: 'accepted' } as const;
        }),
      ),
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  /** Runs `call` with an identity access token, registering once and renewing it after a 401. */
  private withToken<T>(
    accountId: string,
    url: string,
    call: (token: string) => Promise<T>,
  ): Observable<T> {
    return defer(() => {
      const client = this.client(accountId);
      const key = `${accountId}\n${url}`;
      const fresh = async (): Promise<string> => {
        client.setIdentityServerUrl(url);
        const { access_token } = await client.registerWithIdentityServer(
          await client.getOpenIdToken(),
        );
        this.tokens.set(key, access_token);
        return access_token;
      };
      return from(
        (async () => {
          client.setIdentityServerUrl(url);
          try {
            return await call(this.tokens.get(key) ?? (await fresh()));
          } catch (err) {
            if (!isUnauthorized(err)) throw err;
            this.tokens.delete(key);
            return call(await fresh());
          }
        })(),
      );
    });
  }

  private client(accountId: string) {
    const client = this.matrix.clientFor(accountId);
    if (!client) throw new AccountUnavailableError();
    return client;
  }

  private withClient<T>(
    accountId: string,
    run: (client: ReturnType<IdentityServerService['client']>) => Promise<T>,
  ): Observable<T | IdentityServerRefused> {
    return defer(() => from(run(this.client(accountId)))).pipe(
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  private async probe(base: string): Promise<boolean> {
    const response = await fetch(`${base}/_matrix/identity/v2`, {
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 200;
  }
}

class AccountUnavailableError extends Error {}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isUnauthorized(err: unknown): boolean {
  return (
    err instanceof MatrixError &&
    (err.httpStatus === 401 || err.errcode === 'M_UNAUTHORIZED')
  );
}

type Client = NonNullable<ReturnType<MatrixClientService['clientFor']>>;

// `m.accepted_terms` is not in the SDK's account-data typing.
async function acceptedUrls(client: Client): Promise<string[]> {
  const data = (await client.getAccountDataFromServer(
    'm.accepted_terms' as never,
  )) as AcceptedTerms | null;
  return data?.accepted ?? [];
}

async function setAcceptedTerms(
  client: Client,
  content: AcceptedTerms,
): Promise<void> {
  await client.setAccountData('m.accepted_terms' as never, content as never);
}

function policiesOf(
  policies: Readonly<Record<string, Record<string, unknown>>>,
): IdentityPolicy[] {
  return Object.entries(policies).flatMap(([id, policy]) => {
    const languages = Object.entries(policy).filter(
      (entry): entry is [string, { name: string; url: string }] =>
        entry[0] !== 'version' &&
        typeof entry[1] === 'object' &&
        entry[1] !== null,
    );
    const chosen = languages.find(([lang]) => lang === 'en') ?? languages[0];
    return chosen
      ? [
          {
            id,
            name: chosen[1].name,
            url: chosen[1].url,
            version: String(policy['version']),
          },
        ]
      : [];
  });
}

function refused(reason: IdentityServerRefusal): IdentityServerRefused {
  return { kind: 'refused', reason };
}

function refusalOf(err: unknown): IdentityServerRefused {
  if (err instanceof AccountUnavailableError) {
    return refused('account-unavailable');
  }
  const failure = describeMatrixRequestFailure(err);
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return refused('unreachable');
  }
  if (failure.kind === 'rate-limit') {
    const retryAfterMs = failure.diagnostic.retryAfterMs;
    return {
      ...refused('rate-limited'),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  return refused('failed');
}
