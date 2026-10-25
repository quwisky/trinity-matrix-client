import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  MatrixError,
  describeMatrixRequestFailure,
} from '@trinity/util/matrix';
import { SERVICE_TYPES } from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  from,
  last,
  of,
  switchMap,
  takeWhile,
} from 'rxjs';
import type {
  IdentityPolicy,
  IdentityServerChoice,
  IdentityServerRefusal,
  IdentityServerRefused,
  PendingPublish,
  PublishLinkResult,
  PublishResult,
  TermsCheck,
} from './identity-server.models';

type Client = NonNullable<ReturnType<MatrixClientService['clientFor']>>;

interface AcceptedTerms {
  readonly accepted?: readonly string[];
}

interface OfferedPolicy {
  readonly policy: IdentityPolicy;
  readonly urls: readonly string[];
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
      return wellKnown && isHttps(wellKnown)
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
      const base = normalizeUrl(url);
      if (!isHttps(base)) return of(refused('not-https'));
      const client = this.client(accountId);
      return from(probe(base)).pipe(
        switchMap((answer) => {
          if (answer !== 'ok') {
            return of(
              refused(
                answer === 'unreachable'
                  ? 'unreachable'
                  : 'not-identity-server',
              ),
            );
          }
          return from(
            client.setAccountData('m.identity_server', { base_url: base }),
          ).pipe(switchMap(() => of({ kind: 'saved', url: base } as const)));
        }),
      );
    }).pipe(catchError((err: unknown) => of(refusalOf(err))));
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
    const base = normalizeUrl(url);
    return this.withClient(accountId, async (client): Promise<TermsCheck> => {
      const [terms, accepted] = await Promise.all([
        client.getTerms(SERVICE_TYPES.IS, base),
        acceptedUrls(client),
      ]);
      const missing = offeredPolicies(terms.policies)
        .filter(({ urls }) => !urls.some((u) => accepted.includes(u)))
        .map(({ policy }) => policy);
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
    const base = normalizeUrl(url);
    const urls = policies.map((policy) => policy.url);
    return this.withToken(accountId, base, (token) =>
      this.client(accountId).agreeToTerms(SERVICE_TYPES.IS, base, token, urls),
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

  findable(
    accountId: string,
    url: string,
    emails: readonly string[],
  ): Observable<
    | { readonly kind: 'loaded'; readonly published: ReadonlySet<string> }
    | IdentityServerRefused
  > {
    return this.withToken(accountId, url, async (token) => {
      const client = this.client(accountId);
      const found = await client.identityHashedLookup(
        emails.map((email) => [email, 'email']),
        token,
      );
      const self = client.getUserId();
      return {
        kind: 'loaded',
        published: new Set(
          found
            .filter(({ mxid }) => mxid === self)
            .map(({ address }) => address),
        ),
      } as const;
    }).pipe(catchError((err: unknown) => of(refusalOf(err))));
  }

  sendPublishLink(
    accountId: string,
    url: string,
    email: string,
  ): Observable<PublishLinkResult> {
    return defer(() =>
      this.requestLink({
        accountId,
        url: normalizeUrl(url),
        email,
        sid: '',
        clientSecret: this.client(accountId).generateClientSecret(),
        sendAttempt: 1,
      }),
    ).pipe(catchError((err: unknown) => of(refusalOf(err))));
  }

  resendPublishLink(pending: PendingPublish): Observable<PublishLinkResult> {
    return this.requestLink({
      ...pending,
      sendAttempt: pending.sendAttempt + 1,
    }).pipe(catchError((err: unknown) => of(refusalOf(err))));
  }

  publish(pending: PendingPublish): Observable<PublishResult> {
    return this.withToken(pending.accountId, pending.url, async (token) => {
      await this.client(pending.accountId).bindThreePid({
        sid: pending.sid,
        client_secret: pending.clientSecret,
        id_server: new URL(normalizeUrl(pending.url)).host,
        id_access_token: token,
      });
      return { kind: 'published' } as const;
    }).pipe(
      catchError((err: unknown) =>
        of(
          isNotValidated(err)
            ? ({ kind: 'not-verified', pending } as const)
            : refusalOf(err),
        ),
      ),
    );
  }

  unpublish(
    accountId: string,
    url: string,
    email: string,
  ): Observable<{ readonly kind: 'unpublished' } | IdentityServerRefused> {
    return this.withClient(accountId, async (client) => {
      // unbindThreePid reads the identity server from the client, not from an argument.
      client.setIdentityServerUrl(normalizeUrl(url));
      await client.unbindThreePid('email', email);
      return { kind: 'unpublished' } as const;
    });
  }

  unpublishAll(
    accountId: string,
    url: string,
    emails: readonly string[],
  ): Observable<{ readonly kind: 'unpublished' } | IdentityServerRefused> {
    return from(emails).pipe(
      concatMap((email) => this.unpublish(accountId, url, email)),
      takeWhile((result) => result.kind === 'unpublished', true),
      last(),
      defaultIfEmpty({ kind: 'unpublished' } as const),
    );
  }

  private requestLink(pending: PendingPublish): Observable<PublishLinkResult> {
    return this.withToken(pending.accountId, pending.url, async (token) => {
      const { sid } = await this.client(pending.accountId).requestEmailToken(
        pending.email,
        pending.clientSecret,
        pending.sendAttempt,
        undefined,
        token,
      );
      return { kind: 'sent', pending: { ...pending, sid } } as const;
    });
  }

  /** Runs `call` with an identity access token, registering once and renewing it after a 401. */
  private withToken<T>(
    accountId: string,
    url: string,
    call: (token: string) => Promise<T>,
  ): Observable<T> {
    return defer(() => {
      const client = this.client(accountId);
      const base = normalizeUrl(url);
      const key = `${accountId}\n${base}`;
      // shortcut: concurrent first calls each register (both tokens stay valid); dedupe if it shows up as load.
      const fresh = async (): Promise<string> => {
        client.setIdentityServerUrl(base);
        const { access_token } = await client.registerWithIdentityServer(
          await client.getOpenIdToken(),
        );
        this.tokens.set(key, access_token);
        return access_token;
      };
      return from(
        (async () => {
          // The identity server URL is per-client state shared by every account call.
          client.setIdentityServerUrl(base);
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

  private client(accountId: string): Client {
    const client = this.matrix.clientFor(accountId);
    if (!client) throw new AccountUnavailableError();
    return client;
  }

  private withClient<T>(
    accountId: string,
    run: (client: Client) => Promise<T>,
  ): Observable<T | IdentityServerRefused> {
    return defer(() => from(run(this.client(accountId)))).pipe(
      catchError((err: unknown) => of(refusalOf(err))),
    );
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

// Observed on Sydent via Synapse: M_SESSION_NOT_VALIDATED; the message match covers a bare 400.
function isNotValidated(err: unknown): boolean {
  return (
    err instanceof MatrixError &&
    (err.errcode === 'M_SESSION_NOT_VALIDATED' ||
      (err.httpStatus === 400 && /not.*validated/i.test(err.error ?? '')))
  );
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function probe(base: string): Promise<'ok' | 'no' | 'unreachable'> {
  try {
    const response = await fetch(`${base}/_matrix/identity/v2`, {
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 200 ? 'ok' : 'no';
  } catch {
    // fetch rejects with a bare TypeError (or a timeout) when the host cannot be reached.
    return 'unreachable';
  }
}

// The SDK's account-data map is closed over spec events; `m.accepted_terms` is
// reached through a narrow string-keyed view.
async function acceptedUrls(client: Client): Promise<string[]> {
  const read = client.getAccountDataFromServer.bind(client) as (
    type: string,
  ) => Promise<unknown>;
  const data = (await read('m.accepted_terms')) as AcceptedTerms | null;
  return Array.isArray(data?.accepted)
    ? data.accepted.filter((u): u is string => typeof u === 'string')
    : [];
}

async function setAcceptedTerms(
  client: Client,
  content: AcceptedTerms,
): Promise<void> {
  const write = client.setAccountData.bind(client) as (
    type: string,
    content: unknown,
  ) => Promise<unknown>;
  await write('m.accepted_terms', content);
}

// Consent is recorded as URLs only, so a version bump served at the same URL is not
// asked again (protocol limit); a new version at a new URL is.
function offeredPolicies(
  policies: Readonly<Record<string, Record<string, unknown>>>,
): OfferedPolicy[] {
  return Object.entries(policies).flatMap(([id, policy]) => {
    const version = policy['version'];
    if (typeof version !== 'string') return [];
    const languages = Object.entries(policy).flatMap(([lang, entry]) => {
      if (lang === 'version' || typeof entry !== 'object' || entry === null) {
        return [];
      }
      const { name, url } = entry as { name?: unknown; url?: unknown };
      return typeof name === 'string' && typeof url === 'string' && isHttps(url)
        ? [{ lang, name, url }]
        : [];
    });
    const chosen = languages.find(({ lang }) => lang === 'en') ?? languages[0];
    return chosen
      ? [
          {
            policy: { id, name: chosen.name, url: chosen.url, version },
            urls: languages.map(({ url }) => url),
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
