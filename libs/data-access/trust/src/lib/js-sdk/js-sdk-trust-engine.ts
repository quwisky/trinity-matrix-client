import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  MatrixError,
  Method,
  type MatrixClient,
} from 'matrix-js-sdk';
import { type CryptoApi, CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import {
  NEVER,
  type Observable,
  asapScheduler,
  catchError,
  concat,
  debounceTime,
  defer,
  distinctUntilChanged,
  from,
  fromEventPattern,
  map,
  merge,
  of,
  startWith,
  switchMap,
} from 'rxjs';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import { DEFAULT_KEY_EVENT, withTimeout } from '../recovery-reset';
import type {
  OwnIdentityCheck,
  TrustEngine,
  TrustFacts,
} from '../trust-engine';
import {
  readPublishedMasterKey,
  readThisDeviceVerified,
} from '../trust-snapshot';

/** The crypto and account-data events that can move an account's facts. */
const FACT_EVENTS = [
  CryptoEvent.KeysChanged,
  CryptoEvent.UserTrustStatusChanged,
  CryptoEvent.KeyBackupStatus,
  CryptoEvent.DevicesUpdated,
  // Restored /sync may contain old secrets until fresh account data arrives.
  ClientEvent.AccountData,
] as const;

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const CRYPTO_NOT_READY: EngineFailure = {
  kind: 'unexpected',
  code: 'crypto-not-ready',
  diagnostic: { kind: 'unexpected' },
};

/** `request-failed` with privacy-safe metadata only: no message, body or secret. */
function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return { kind, code: 'request-failed', diagnostic };
}

async function readFacts(
  client: MatrixClient,
  crypto: CryptoApi,
): Promise<TrustFacts> {
  // Today's read order: readiness first, then this device, then the key status.
  const [crossSigningReady, secretStorageReady, backupVersion, defaultKeyId] =
    await Promise.all([
      crypto.isCrossSigningReady(),
      crypto.isSecretStorageReady(),
      crypto.getActiveSessionBackupVersion(),
      client.secretStorage.getDefaultKeyId(),
    ]);
  const thisDeviceCrossSigned = await readThisDeviceVerified(client, crypto);
  const status = await crypto.getCrossSigningStatus();
  const cached = status.privateKeysCachedLocally;
  return {
    crossSigningReady,
    secretStorageReady,
    keyBackupActive: backupVersion !== null,
    hasDefaultKey: !!defaultKeyId,
    thisDeviceCrossSigned,
    crossSigning: {
      publicKeysOnDevice: status.publicKeysOnDevice,
      privateKeysInSecretStorage: status.privateKeysInSecretStorage,
      privateKeysCachedLocally: {
        masterKey: cached.masterKey,
        selfSigningKey: cached.selfSigningKey,
        userSigningKey: cached.userSigningKey,
      },
    },
  };
}

function changesOf(client: MatrixClient): Observable<void> {
  return merge(
    ...FACT_EVENTS.map((event) =>
      fromEventPattern<unknown>(
        (handler) => client.on(event as never, handler as never),
        (handler) => client.off(event as never, handler as never),
      ),
    ),
  ).pipe(map(() => undefined));
}

/** {@link TrustEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkTrustEngine implements TrustEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  facts(accountId: string): Observable<EngineResult<TrustFacts>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(engineFail(NOT_LIVE)), NEVER);
      const crypto = client.getCrypto();
      if (!crypto) return concat(of(engineFail(CRYPTO_NOT_READY)), NEVER);
      // A burst within one microtask starts one read; an overtaken read's result is dropped.
      return changesOf(client).pipe(
        startWith(undefined),
        debounceTime(0, asapScheduler),
        switchMap(() =>
          from(readFacts(client, crypto)).pipe(
            map((facts) => engineOk(facts)),
            catchError((error: unknown) =>
              of(engineFail(requestFailed(error))),
            ),
          ),
        ),
        distinctUntilChanged<EngineResult<TrustFacts>>(plainEqual),
      );
    });
  }

  ownIdentityCheck(
    accountId: string,
  ): Observable<EngineResult<OwnIdentityCheck>> {
    return this.request(accountId, async (client, crypto) => {
      // First: for the own user this also re-queries the published identity, so the
      // local reads below are judged against the server's copy.
      const identityKnown = await withTimeout(
        crypto.userHasCrossSigningKeys(undefined, true),
      );
      const publishedMasterKey = await readPublishedMasterKey(client);
      const [localMasterKey, facts] = await Promise.all([
        crypto.getCrossSigningKeyId(),
        readFacts(client, crypto),
      ]);
      return {
        identityKnown,
        publishedMasterKey,
        localMasterKey: localMasterKey ?? null,
        facts,
      };
    });
  }

  publishedMasterKey(
    accountId: string,
  ): Observable<EngineResult<string | null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      return from(readPublishedMasterKey(client)).pipe(
        map((key) => engineOk(key)),
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }

  serverDefaultKeyId(
    accountId: string,
  ): Observable<EngineResult<string | null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      const userId = client?.getUserId();
      if (!client || !userId) return of(engineFail(NOT_LIVE));
      // The crypto-flow deadline rather than the client's 30 s default: an unanswered
      // socket must not hold first-run setup.
      const read = withTimeout(
        client.http.authedRequest<{ key?: unknown }>(
          Method.Get,
          `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(DEFAULT_KEY_EVENT)}`,
        ),
      );
      return from(read).pipe(
        map(({ key }) => engineOk(typeof key === 'string' ? key : null)),
        catchError((error: unknown) =>
          of(
            error instanceof MatrixError && error.errcode === 'M_NOT_FOUND'
              ? engineOk(null)
              : engineFail(requestFailed(error)),
          ),
        ),
      );
    });
  }

  private request<T>(
    accountId: string,
    run: (client: MatrixClient, crypto: CryptoApi) => Promise<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      const crypto = client.getCrypto();
      if (!crypto) return of(engineFail(CRYPTO_NOT_READY));
      return from(run(client, crypto)).pipe(
        map((value) => engineOk(value)),
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }
}
