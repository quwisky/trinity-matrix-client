import { Injectable, inject } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  EngineRequestError,
  type EngineResult,
  type MatrixRequestFailureMetadata,
  describeMatrixRequestFailure,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  firstValueFrom,
  forkJoin,
  from,
  last,
  map,
  of,
  switchMap,
  takeWhile,
} from 'rxjs';
import { CONTACT_ADDRESSES_ENGINE } from './contact-addresses-engine.token';
import {
  agreeToTerms,
  getTerms,
  hashedLookup,
  newClientSecret,
  registerWithIdentityServer,
  requestEmailToken,
} from './identity-server-http';
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

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

interface OfferedPolicy {
  readonly policy: IdentityPolicy;
  readonly urls: readonly string[];
}

/** Which identity server an account uses, and the access it needs to talk to it. */
@Injectable({ providedIn: 'root' })
export class IdentityServerService {
  private readonly engine = inject(CONTACT_ADDRESSES_ENGINE);
  private readonly session = inject(SessionStateService);
  // Memory only: an identity access token is never persisted or logged.
  private readonly tokens = new Map<string, string>();
  // One account's identity calls run in turn, so calls queued behind a registration reuse its token.
  private readonly queues = new Map<string, Promise<unknown>>();

  choice(
    accountId: string,
  ): Observable<IdentityServerChoice | IdentityServerRefused> {
    return this.engine.identityServerSetting(accountId).pipe(
      unwrapEngineResult(),
      map(({ account, wellKnown }): IdentityServerChoice => {
        if (account) {
          return account.baseUrl
            ? { kind: 'set', url: account.baseUrl, source: 'account' }
            : { kind: 'off' };
        }
        return wellKnown && isHttps(wellKnown)
          ? { kind: 'set', url: wellKnown, source: 'well-known' }
          : { kind: 'none' };
      }),
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  /** Whether `url` is an https identity server, without touching any account. */
  check(
    url: string,
  ): Observable<
    { readonly kind: 'ok'; readonly url: string } | IdentityServerRefused
  > {
    return defer(() => {
      const base = normalizeUrl(url);
      if (!isHttps(base)) return of(refused('not-https'));
      return from(probe(base)).pipe(
        switchMap((answer) =>
          of(
            answer === 'ok'
              ? ({ kind: 'ok', url: base } as const)
              : refused(
                  answer === 'unreachable'
                    ? 'unreachable'
                    : 'not-identity-server',
                ),
          ),
        ),
      );
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
      this.requireLive(accountId);
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
          return this.engine.setIdentityServer(accountId, base).pipe(
            unwrapEngineResult(),
            map(() => ({ kind: 'saved', url: base }) as const),
          );
        }),
      );
    }).pipe(catchError((err: unknown) => of(refusalOf(err))));
  }

  turnOff(
    accountId: string,
  ): Observable<{ readonly kind: 'saved' } | IdentityServerRefused> {
    return this.engine.setIdentityServer(accountId, null).pipe(
      unwrapEngineResult(),
      map(() => ({ kind: 'saved' }) as const),
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  terms(accountId: string, url: string): Observable<TermsCheck> {
    const base = normalizeUrl(url);
    return defer(() => {
      this.requireLive(accountId);
      return forkJoin([
        getTerms(base),
        this.engine.acceptedTerms(accountId).pipe(unwrapEngineResult()),
      ]);
    }).pipe(
      map(([policies, accepted]): TermsCheck => {
        const missing = offeredPolicies(policies)
          .filter(({ urls }) => !urls.some((u) => accepted.includes(u)))
          .map(({ policy }) => policy);
        return missing.length
          ? { kind: 'needs-consent', policies: missing }
          : { kind: 'accepted' };
      }),
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  acceptTerms(
    accountId: string,
    url: string,
    policies: readonly IdentityPolicy[],
  ): Observable<{ readonly kind: 'accepted' } | IdentityServerRefused> {
    const urls = policies.map((policy) => policy.url);
    return this.withToken(accountId, url, (token, base) =>
      agreeToTerms(base, token, urls),
    ).pipe(
      switchMap(() => this.engine.acceptedTerms(accountId)),
      unwrapEngineResult(),
      switchMap((accepted) =>
        this.engine.setAcceptedTerms(accountId, [
          ...new Set([...accepted, ...urls]),
        ]),
      ),
      unwrapEngineResult(),
      map(() => ({ kind: 'accepted' }) as const),
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  findable(
    accountId: string,
    url: string,
    emails: readonly string[],
  ): Observable<
    | { readonly kind: 'loaded'; readonly published: ReadonlySet<string> }
    | { readonly kind: 'terms-needed' }
    | IdentityServerRefused
  > {
    if (emails.length === 0) {
      return of({ kind: 'loaded', published: new Set<string>() } as const);
    }
    return this.withToken(accountId, url, async (token, base) => {
      const found = await hashedLookup(base, token, emails);
      return {
        kind: 'loaded',
        published: new Set(
          found
            .filter(({ mxid }) => mxid === accountId)
            .map(({ address }) => address),
        ),
      } as const;
    }).pipe(
      catchError((err: unknown) =>
        of(
          isTermsNotSigned(err)
            ? ({ kind: 'terms-needed' } as const)
            : refusalOf(err),
        ),
      ),
    );
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
        clientSecret: newClientSecret(),
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
    return this.withToken(
      pending.accountId,
      pending.url,
      async (token, base) => {
        await unwrap(
          this.engine.bindThreePid(pending.accountId, {
            sid: pending.sid,
            clientSecret: pending.clientSecret,
            idServer: new URL(base).host,
            idAccessToken: token,
          }),
        );
        return { kind: 'published' } as const;
      },
    ).pipe(
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
    return defer(() =>
      this.inTurn(accountId, () =>
        unwrap(
          this.engine.unbindThreePid(accountId, {
            medium: 'email',
            address: email,
            idServer: normalizeUrl(url).replace(/^https?:\/\//, ''),
          }),
        ),
      ),
    ).pipe(
      // 'no-support' counts as unpublished so such a server cannot block changing servers; the UI re-reads findable.
      map(() => ({ kind: 'unpublished' }) as const),
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  unpublishAll(
    accountId: string,
    url: string,
    emails: readonly string[],
  ): Observable<{ readonly kind: 'unpublished' } | IdentityServerRefused> {
    return from(emails).pipe(
      concatMap((email) => this.unpublish(accountId, url, email)),
      takeWhile((result) => result.kind === 'unpublished', true),
      last(undefined, { kind: 'unpublished' } as const),
    );
  }

  private requestLink(pending: PendingPublish): Observable<PublishLinkResult> {
    return this.withToken(
      pending.accountId,
      pending.url,
      async (token, base) => {
        const sid = await requestEmailToken(base, token, pending);
        return { kind: 'sent', pending: { ...pending, sid } } as const;
      },
    );
  }

  /** Runs `call` with an identity access token, registering once and renewing it after a 401. */
  private withToken<T>(
    accountId: string,
    url: string,
    call: (token: string, base: string) => Promise<T>,
  ): Observable<T> {
    return defer(() => {
      this.requireLive(accountId);
      const base = normalizeUrl(url);
      const key = `${accountId}\n${base}`;
      const fresh = async (): Promise<string> => {
        const token = await registerWithIdentityServer(
          base,
          await unwrap(this.engine.openIdToken(accountId)),
        );
        this.tokens.set(key, token);
        return token;
      };
      return from(
        this.inTurn(accountId, async () => {
          // Again here: the account may have gone while this call waited its turn.
          this.requireLive(accountId);
          try {
            return await call(this.tokens.get(key) ?? (await fresh()), base);
          } catch (err) {
            if (!isUnauthorized(err)) throw err;
            this.tokens.delete(key);
            return call(await fresh(), base);
          }
        }),
      );
    });
  }

  /** Throws before any identity-server call for an account without a live client. */
  private requireLive(accountId: string): void {
    if (!this.session.status(accountId)) throw new EngineRequestError(NOT_LIVE);
  }

  /** Runs `run` once the account's earlier identity calls have settled. */
  private inTurn<T>(accountId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(accountId) ?? Promise.resolve()).then(
      run,
      run,
    );
    this.queues.set(
      accountId,
      next.catch(() => undefined),
    );
    return next;
  }
}

function unwrap<T>(source: Observable<EngineResult<T>>): Promise<T> {
  return firstValueFrom(source.pipe(unwrapEngineResult()));
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function answerOf(err: unknown): MatrixRequestFailureMetadata | undefined {
  return err instanceof EngineRequestError ? err.failure.diagnostic : undefined;
}

function isUnauthorized(err: unknown): boolean {
  const answer = answerOf(err);
  return answer?.httpStatus === 401 || answer?.errcode === 'M_UNAUTHORIZED';
}

// Synapse 1.161 + Sydent 2.6.1 answer a bind before the link is opened with 400 M_SESSION_NOT_VALIDATED.
function isNotValidated(err: unknown): boolean {
  return answerOf(err)?.errcode === 'M_SESSION_NOT_VALIDATED';
}

// Sydent also asks again after changing its policies, when addresses may still be bound.
function isTermsNotSigned(err: unknown): boolean {
  return answerOf(err)?.errcode === 'M_TERMS_NOT_SIGNED';
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

// Consent is recorded as URLs only, so a version bump served at the same URL is not
// asked again (protocol limit); a new version at a new URL is.
function offeredPolicies(
  policies: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
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
  if (
    err instanceof EngineRequestError &&
    err.failure.code === 'account-not-live'
  ) {
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
