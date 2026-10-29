import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  MatrixError,
  Method,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  type CryptoApi,
  CryptoEvent,
  type VerificationRequest,
  VerificationPhase,
} from 'matrix-js-sdk/lib/crypto-api';
import {
  NEVER,
  Observable,
  asapScheduler,
  catchError,
  concat,
  debounceTime,
  defer,
  distinctUntilChanged,
  filter,
  finalize,
  from,
  fromEventPattern,
  map,
  merge,
  of,
  startWith,
  Subject,
  switchMap,
  take,
} from 'rxjs';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
  type UiaPasswordPrompt,
  describeMatrixRequestFailure,
  driveUia,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import { DEFAULT_KEY_EVENT, withTimeout } from '../recovery-reset';
import type {
  InteractiveUpdate,
  OwnDevice,
  OwnIdentityCheck,
  TrustEngine,
  TrustFacts,
  UserTrustFacts,
  VerificationSnapshot,
} from '../trust-engine';
import {
  readPublishedMasterKey,
  readThisDeviceVerified,
} from '../trust-snapshot';
import {
  ClientVerification,
  flowIdOf,
  isTerminal,
} from './js-sdk-verification';

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

const VERIFICATION_GONE: EngineFailure = {
  kind: 'unexpected',
  code: 'verification-gone',
  diagnostic: { kind: 'unexpected' },
};

const QR_UNAVAILABLE: EngineFailure = {
  kind: 'unexpected',
  code: 'qr-unavailable',
  diagnostic: { kind: 'unexpected' },
};

const toBase64 = (bytes: Uint8ClampedArray): string =>
  btoa(String.fromCharCode(...bytes));

const fromBase64 = (base64: string): Uint8ClampedArray =>
  Uint8ClampedArray.from(atob(base64), (char) => char.charCodeAt(0));

/** `request-failed` with privacy-safe metadata only: no message, body or secret. */
function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return { kind, code: 'request-failed', diagnostic };
}

/** A failure a step throws on purpose, as opposed to an SDK error. */
function isFailure(error: unknown): error is EngineFailure {
  return [
    NOT_LIVE,
    CRYPTO_NOT_READY,
    VERIFICATION_GONE,
    QR_UNAVAILABLE,
  ].includes(error as EngineFailure);
}

const OWN_DEVICE: EngineFailure = {
  kind: 'unexpected',
  code: 'unsupported',
  diagnostic: { kind: 'unexpected' },
};

const PROMPT_GONE: EngineFailure = {
  kind: 'unexpected',
  code: 'prompt-gone',
  diagnostic: { kind: 'unexpected' },
};

const UNVERIFIED: UserTrustFacts = {
  verified: false,
  wasVerified: false,
  needsApproval: false,
};

/** A command failure: the UIA outcomes and M_FORBIDDEN by code, else {@link requestFailed}. */
function commandFailed(error: unknown): EngineFailure {
  const uia =
    error instanceof UiaCancelledError
      ? 'uia-cancelled'
      : error instanceof UiaUnsupportedError
        ? 'uia-unsupported'
        : error instanceof UiaAttemptsExceededError
          ? 'uia-attempts-exceeded'
          : null;
  if (uia)
    return {
      kind: 'unexpected',
      code: uia,
      diagnostic: { kind: 'unexpected' },
    };
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return diagnostic.errcode === 'M_FORBIDDEN'
    ? { kind, code: 'forbidden', diagnostic }
    : { kind, code: 'request-failed', diagnostic };
}

async function readDevices(client: MatrixClient): Promise<OwnDevice[]> {
  const userId = client.getUserId();
  const currentId = client.getDeviceId();
  const crypto = client.getCrypto();
  const { devices } = await client.getDevices();
  return Promise.all(
    devices.map(async (device): Promise<OwnDevice> => {
      // Decorative: a store error on one device must not fail the whole list.
      const status =
        crypto && userId
          ? await crypto
              .getDeviceVerificationStatus(userId, device.device_id)
              .catch(() => null)
          : null;
      return {
        deviceId: device.device_id,
        displayName: device.display_name || null,
        lastSeenTs: device.last_seen_ts ?? null,
        lastSeenIp: device.last_seen_ip ?? null,
        isCurrent: device.device_id === currentId,
        verified: status?.isVerified() ?? false,
      };
    }),
  );
}

async function readUserTrust(
  crypto: CryptoApi,
  userId: string,
): Promise<UserTrustFacts> {
  try {
    const status = await crypto.getUserVerificationStatus(userId);
    return {
      verified: status.isCrossSigningVerified(),
      wasVerified: status.wasCrossSigningVerified(),
      needsApproval: status.needsUserApproval,
    };
  } catch {
    // Decorative: a failed read shows the user as unverified.
    return UNVERIFIED;
  }
}

/** Re-reads `read` on each `changes`, one read per burst, dropping an overtaken read. */
function readOnChange<T>(
  changes: Observable<unknown>,
  read: () => Promise<EngineResult<T>>,
): Observable<EngineResult<T>> {
  return changes.pipe(
    startWith(undefined),
    debounceTime(0, asapScheduler),
    switchMap(() => from(read())),
    distinctUntilChanged<EngineResult<T>>(plainEqual),
  );
}

function eventsOf<A extends unknown[]>(
  client: MatrixClient,
  event: string,
): Observable<A> {
  return fromEventPattern<A>(
    (handler) => client.on(event as never, handler as never),
    (handler) => client.off(event as never, handler as never),
    (...args: unknown[]) => args as A,
  );
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
  /** Per client, so a replaced client under the same account starts with none. */
  private readonly verifications = new WeakMap<
    MatrixClient,
    ClientVerification
  >();
  /** Open password prompts by id, answered through {@link answerPrompt}. */
  private readonly prompts = new Map<
    string,
    { readonly accountId: string; answer(password: string | null): void }
  >();
  private promptSequence = 0;
  /** Account ids whose device list this engine just changed, so open lists read again. */
  private readonly devicesChanged = new Subject<string>();
  /** `accountId\nuserId` pairs whose identity this engine just pinned or withdrew. */
  private readonly identitiesChanged = new Subject<string>();

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

  verification(accountId: string): Observable<VerificationSnapshot | null> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      const crypto = client?.getCrypto();
      const userId = client?.getUserId();
      if (!client || !crypto || !userId) return concat(of(null), NEVER);
      const state = this.verificationOf(client);
      const incoming = (request: VerificationRequest): void =>
        state.offer(request);
      state.watch();
      client.on(CryptoEvent.VerificationRequestReceived, incoming);
      // Takes up a request that predates the listener, e.g. sent during a reload.
      const inProgress =
        crypto.getVerificationRequestsToDeviceInProgress(userId)[0];
      if (inProgress) state.offer(inProgress);
      return state.snapshot.pipe(
        finalize(() => {
          client.off(CryptoEvent.VerificationRequestReceived, incoming);
          state.unwatch();
        }),
      );
    });
  }

  requestOwnVerification(
    accountId: string,
  ): Observable<EngineResult<{ readonly flowId: string }>> {
    return this.request(accountId, async (client, crypto) => {
      const request = await crypto.requestOwnUserVerification();
      if (this.clients.clientFor(accountId) !== client) {
        void request.cancel().catch(() => undefined);
        throw NOT_LIVE;
      }
      this.verificationOf(client).adopt(request);
      return { flowId: flowIdOf(request) };
    });
  }

  requestUserVerification(
    accountId: string,
    userId: string,
    roomId: string,
  ): Observable<EngineResult<{ readonly flowId: string }>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      const crypto = client.getCrypto();
      if (!crypto) return of(engineFail(CRYPTO_NOT_READY));
      const current = () => this.clients.clientFor(accountId) === client;
      const identity = fromEventPattern<string>(
        (handler) => client.on(CryptoEvent.UserTrustStatusChanged, handler),
        (handler) => client.off(CryptoEvent.UserTrustStatusChanged, handler),
        // The event also carries the trust level; only the user id matters here.
        (changed: string) => changed,
      ).pipe(
        filter((changed) => changed === userId),
        startWith(userId),
        // The encrypted DM makes the client track this user. Wait for the identity to
        // reach Rust crypto; an uncached HTTP key lookup is not enough.
        switchMap(() => crypto.userHasCrossSigningKeys(userId)),
        filter((known) => known || !current()),
        take(1),
      );
      return identity.pipe(
        switchMap(() =>
          current()
            ? this.sendUserVerification(client, crypto, userId, roomId, current)
            : of(engineFail(NOT_LIVE)),
        ),
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }

  acceptVerification(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.onFlow(accountId, flowId, async (request) => {
      await request.accept();
    });
  }

  startSas(accountId: string, flowId: string): Observable<EngineResult<null>> {
    return this.onFlow(accountId, flowId, async (request, state) => {
      state.attach(await request.startVerification('m.sas.v1'));
    });
  }

  confirmSas(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.onFlow(accountId, flowId, async (_request, state) => {
      const sas = state.sas();
      if (!sas) throw VERIFICATION_GONE;
      await sas.confirm();
    });
  }

  mismatchSas(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.onFlow(accountId, flowId, async (_request, state) => {
      state.sas()?.mismatch();
    });
  }

  showQr(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<{ readonly qr: string }>> {
    return this.onFlow(accountId, flowId, async (request, state) => {
      const data = await request.generateQRCode();
      if (!data?.length) throw QR_UNAVAILABLE;
      if (
        state.request !== request ||
        request.phase !== VerificationPhase.Ready
      ) {
        throw VERIFICATION_GONE;
      }
      return { qr: toBase64(data) };
    });
  }

  scanQr(
    accountId: string,
    flowId: string,
    qr: string,
  ): Observable<EngineResult<null>> {
    return this.onFlow(accountId, flowId, async (request, state) => {
      const verifier = await request.scanQRCode(fromBase64(qr));
      if (state.request !== request || isTerminal(request)) {
        verifier.cancel(
          new Error('The verification request changed while scanning.'),
        );
        return;
      }
      state.attach(verifier);
    });
  }

  confirmQr(accountId: string, flowId: string): Observable<EngineResult<null>> {
    return this.onFlow(accountId, flowId, async (_request, state) => {
      if (!state.confirmQr()) throw VERIFICATION_GONE;
    });
  }

  cancelVerification(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.onFlow(accountId, flowId, async (request, state) => {
      state.cancelVerifier();
      if (!isTerminal(request)) await request.cancel();
    });
  }

  private verificationOf(client: MatrixClient): ClientVerification {
    let state = this.verifications.get(client);
    if (!state) {
      state = new ClientVerification();
      this.verifications.set(client, state);
    }
    return state;
  }

  private sendUserVerification(
    client: MatrixClient,
    crypto: CryptoApi,
    userId: string,
    roomId: string,
    current: () => boolean,
  ): Observable<EngineResult<{ readonly flowId: string }>> {
    return new Observable((subscriber) => {
      crypto.requestVerificationDM(userId, roomId).then(
        (request) => {
          // SDK sends cannot be aborted: a late or orphaned request is cancelled, not taken up.
          if (!current() || subscriber.closed) {
            void request.cancel().catch(() => undefined);
            subscriber.next(engineFail(NOT_LIVE));
            subscriber.complete();
            return;
          }
          this.verificationOf(client).adopt(request);
          subscriber.next(engineOk({ flowId: flowIdOf(request) }));
          subscriber.complete();
        },
        (error: unknown) => {
          subscriber.next(engineFail(requestFailed(error)));
          subscriber.complete();
        },
      );
    });
  }

  /** Runs `step` on the current request of `flowId`; `verification-gone` when it is not. */
  private onFlow<T>(
    accountId: string,
    flowId: string,
    step: (
      request: VerificationRequest,
      state: ClientVerification,
    ) => Promise<T>,
  ): Observable<EngineResult<T extends void ? null : T>> {
    return this.request(accountId, async (client) => {
      const state = this.verificationOf(client);
      const request = state.find(flowId);
      if (!request) throw VERIFICATION_GONE;
      const value = await step(request, state);
      return (value ?? null) as T extends void ? null : T;
    });
  }

  ownDevices(
    accountId: string,
  ): Observable<EngineResult<readonly OwnDevice[]>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(engineFail(NOT_LIVE)), NEVER);
      const me = client.getUserId();
      // The initial bulk fetch is not a change: the first read covers it.
      const ownListChanged = eventsOf<[string[], boolean?]>(
        client,
        CryptoEvent.DevicesUpdated,
      ).pipe(
        filter(([users, initial]) => !initial && !!me && users.includes(me)),
      );
      return readOnChange(
        merge(ownListChanged, this.touched(this.devicesChanged, accountId)),
        () =>
          readDevices(client).then(
            (devices) => engineOk(devices),
            (error: unknown) => engineFail(requestFailed(error)),
          ),
      );
    });
  }

  renameDevice(
    accountId: string,
    deviceId: string,
    name: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, false, async (client) => {
      await client.setDeviceDetails(deviceId, { display_name: name });
      this.devicesChanged.next(accountId);
    });
  }

  deleteDevice(
    accountId: string,
    deviceId: string,
  ): Observable<InteractiveUpdate<null>> {
    return this.interactive(accountId, async (client, prompt) => {
      // Signing this device out is logout, not device management.
      if (deviceId === client.getDeviceId()) return engineFail(OWN_DEVICE);
      await driveUia(
        (auth) => client.deleteDevice(deviceId, auth ?? undefined),
        {
          password: { user: client.getUserId() ?? '', prompt },
        },
      );
      this.devicesChanged.next(accountId);
      return engineOk(null);
    });
  }

  preAuthenticate(
    accountId: string,
  ): Observable<InteractiveUpdate<{ readonly password: string | null }>> {
    return this.interactive(accountId, async (client, prompt) => {
      const { password } = await driveUia(
        (auth) => client.deleteMultipleDevices([], auth ?? undefined),
        { password: { user: client.getUserId() ?? '', prompt } },
      );
      return engineOk({ password });
    });
  }

  answerPrompt(
    accountId: string,
    promptId: string,
    password: string | null,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const prompt = this.prompts.get(promptId);
      if (prompt?.accountId !== accountId) return of(engineFail(PROMPT_GONE));
      prompt.answer(password);
      return of(engineOk(null));
    });
  }

  userTrust(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<UserTrustFacts>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(engineFail(NOT_LIVE)), NEVER);
      const crypto = client.getCrypto();
      if (!crypto) return concat(of(engineFail(CRYPTO_NOT_READY)), NEVER);
      const changed = eventsOf<[string]>(
        client,
        CryptoEvent.UserTrustStatusChanged,
      ).pipe(filter(([changedUser]) => changedUser === userId));
      return readOnChange(
        merge(
          changed,
          this.touched(this.identitiesChanged, `${accountId}\n${userId}`),
        ),
        () => readUserTrust(crypto, userId).then((trust) => engineOk(trust)),
      );
    });
  }

  pinIdentity(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, true, async (_client, crypto) => {
      await crypto.pinCurrentUserIdentity(userId);
      this.identitiesChanged.next(`${accountId}\n${userId}`);
    });
  }

  withdrawVerification(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, true, async (_client, crypto) => {
      await crypto.withdrawVerificationRequirement(userId);
      this.identitiesChanged.next(`${accountId}\n${userId}`);
    });
  }

  private touched(changes: Subject<string>, key: string): Observable<unknown> {
    return changes.pipe(filter((changed) => changed === key));
  }

  /** A one-result command; `needsCrypto` refuses an account without crypto. */
  private command(
    accountId: string,
    needsCrypto: boolean,
    run: (client: MatrixClient, crypto: CryptoApi) => Promise<void>,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      const crypto = client.getCrypto();
      if (needsCrypto && !crypto) return of(engineFail(CRYPTO_NOT_READY));
      return from(run(client, crypto as CryptoApi)).pipe(
        map(() => engineOk(null)),
        catchError((error: unknown) => of(engineFail(commandFailed(error)))),
      );
    });
  }

  /**
   * Runs a command that may raise password prompts. Each prompt is a `password-required`
   * update answered through {@link answerPrompt}; unsubscribing answers every open prompt
   * with a cancel, so the request is never sent on.
   */
  private interactive<T>(
    accountId: string,
    run: (
      client: MatrixClient,
      prompt: UiaPasswordPrompt,
    ) => Promise<EngineResult<T>>,
  ): Observable<InteractiveUpdate<T>> {
    return new Observable<InteractiveUpdate<T>>((subscriber) => {
      const done = (result: EngineResult<T>): void => {
        subscriber.next({ kind: 'done', result });
        subscriber.complete();
      };
      const client = this.clients.clientFor(accountId);
      if (!client) {
        done(engineFail(NOT_LIVE));
        return undefined;
      }
      const open = new Set<string>();
      let closed = false;
      const prompt: UiaPasswordPrompt = ({ rejected }) =>
        new Promise((resolve) => {
          if (closed) {
            resolve(null);
            return;
          }
          const promptId = `prompt-${++this.promptSequence}`;
          open.add(promptId);
          this.prompts.set(promptId, {
            accountId,
            answer: (password) => {
              this.prompts.delete(promptId);
              open.delete(promptId);
              resolve(password);
            },
          });
          subscriber.next({ kind: 'password-required', promptId, rejected });
        });
      run(client, prompt).then(done, (error: unknown) =>
        done(engineFail(commandFailed(error))),
      );
      return () => {
        closed = true;
        for (const promptId of open) this.prompts.get(promptId)?.answer(null);
      };
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
        catchError((error: unknown) =>
          of(engineFail(isFailure(error) ? error : requestFailed(error))),
        ),
      );
    });
  }
}
