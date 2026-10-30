import { Injectable, inject } from '@angular/core';
import {
  Observable,
  Subscription,
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  finalize,
  map,
  of,
  pipe,
  switchMap,
  take,
  takeWhile,
  tap,
  throwIfEmpty,
  type MonoTypeOperatorFunction,
} from 'rxjs';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import {
  SessionStorageService,
  sameHomeserver,
} from '@trinity/platform-native';
import {
  unwrapEngineResult,
  type MatrixSession,
  type OidcSessionBinding,
} from '@trinity/util/matrix';
import { AUTH_ENGINE } from '../auth-engine.token';
import type { QrSignInUpdate } from '../auth-engine';
import type { AuthMetadata } from '../auth-metadata';
import { AuthService } from '../auth.service';
import {
  UnacceptableAccountError,
  refusedBeforeSaving,
} from '../account-establishment';
import { OidcClientService } from '../oidc-client.service';
import { QR_LINK_IDENTITY_CHECK } from './qr-link-identity-check.port';
import {
  DeviceGrantRejectedError,
  OtherServerError,
  QrAccountAlreadyStoredError,
  qrSignInFailureOf,
  type ExistingDeviceState,
  type NewDeviceState,
  type QrSignInFailure,
} from './qr-sign-in.model';

/** The new device's side of a sign-in, with the typed check code as its input. */
export interface NewDeviceQrSignIn {
  readonly state$: Observable<NewDeviceState>;
  /** Answers the code step with the digits typed; ignored at any other step. */
  enterCheckCode(code: string): void;
}

/** The existing device's side of a link, with the person's Continue as its input. */
export interface ExistingDeviceLink {
  readonly state$: Observable<ExistingDeviceState>;
  /** Continues the link at the `approve` step; ignored at any other step. */
  approve(): void;
}

/** Links devices as the one account it was created for. */
export interface QrDeviceLinker {
  readonly accountId: string;
  /** Links the device whose code this device scanned; `state$` is cold. */
  link(qrBytes: Uint8Array): ExistingDeviceLink;
}

/**
 * Sign-in by QR code (MSC4108): a new device shows the code, an existing device scans it.
 * The engine runs the rendezvous; every security decision is made here.
 */
@Injectable({ providedIn: 'root' })
export class QrSignInService {
  private readonly engine = inject(AUTH_ENGINE);
  private readonly auth = inject(AuthService);
  private readonly oidc = inject(OidcClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly sessionEngine = inject(SESSION_ENGINE);
  private readonly sessionState = inject(SessionStateService);
  private readonly identity = inject(QR_LINK_IDENTITY_CHECK);

  /**
   * `state$` is cold: each subscription shows a new code, and unsubscribing cancels the
   * sign-in. The session the engine hands over is added as an account only on the homeserver
   * signed in to, for an account on `serverName`, the server entered, that this device does
   * not store yet. Until it is handed to establishing, any failure or unsubscribe signs it out
   * again; from then on establishing owns it, as for every sign-in.
   */
  signInByShowingCode(
    homeserverUrl: string,
    serverName: string,
  ): NewDeviceQrSignIn {
    let current: ((code: string) => void) | undefined;
    const state$ = defer(() => {
      let metadata: AuthMetadata;
      let grantMetadata: AuthMetadata;
      let retried = false;
      let waiting: string | null = null;
      let handedOver: MatrixSession | null = null;
      let owned = false;
      const answers = new Subscription();
      const answer = (code: string) => {
        const flowId = waiting;
        waiting = null;
        if (flowId === null) return;
        answers.add(
          this.engine.answerQrSignIn(flowId, { checkCode: code }).subscribe(),
        );
      };
      current = answer;
      // Pinned before any session exists, so every sign-out revokes at the pinned provider.
      const signIn = (clientId: string): Observable<NewDeviceState> =>
        this.oidc.deviceGrantBinding(grantMetadata, clientId).pipe(
          oneValue(),
          switchMap((binding) =>
            this.engine
              .signInWithQr(homeserverUrl, { grantMetadata, clientId })
              .pipe(switchMap((update) => onUpdate(update, binding))),
          ),
        );
      const onUpdate = (
        update: QrSignInUpdate,
        binding: OidcSessionBinding,
      ): Observable<NewDeviceState> => {
        waiting = update.kind === 'enter-check-code' ? update.flowId : null;
        switch (update.kind) {
          case 'showing-code':
            return of({
              kind: 'showing-code',
              qr: fromBase64(update.qr),
              expiresAt: update.expiresAt,
            });
          case 'enter-check-code':
            return of({ kind: 'enter-check-code' });
          case 'client-rejected':
            // A cached client the provider no longer accepts: register once more and start over.
            if (retried) throw new DeviceGrantRejectedError();
            retried = true;
            return this.oidc
              .forgetDeviceGrantClientId(metadata, homeserverUrl)
              .pipe(
                oneValue(),
                switchMap(() =>
                  this.oidc.deviceGrantClientId(metadata, homeserverUrl),
                ),
                oneValue(),
                switchMap(signIn),
              );
          case 'done': {
            const { session } = update;
            handedOver = {
              baseUrl: session.homeserverUrl,
              userId: session.userId,
              deviceId: session.deviceId,
              accessToken: session.accessToken,
              ...(session.refreshToken
                ? { refreshToken: session.refreshToken }
                : {}),
              oidc: binding,
            };
            if (!sameHomeserver(session.homeserverUrl, homeserverUrl)) {
              throw new OtherServerError();
            }
            return this.storage.record(session.userId).pipe(
              oneValue(),
              switchMap((stored) => {
                if (stored) throw new QrAccountAlreadyStoredError();
                // From here establishing owns it and hands a refused session back itself.
                owned = true;
                return this.auth
                  .establishDeviceGrant(
                    homeserverUrl,
                    {
                      user_id: session.userId,
                      device_id: session.deviceId,
                      access_token: session.accessToken,
                      ...(session.refreshToken
                        ? { refresh_token: session.refreshToken }
                        : {}),
                      ...(session.accessTokenExpiresAt !== null
                        ? { accessTokenExpiresAt: session.accessTokenExpiresAt }
                        : {}),
                      oidc: binding,
                    },
                    serverName,
                  )
                  .pipe(
                    // Refused before anything was stored: the engine must still drop what
                    // it holds for this user and device, so sign out here too.
                    tap({
                      next: (outcome) => {
                        if (refusedBeforeSaving(outcome)) owned = false;
                      },
                      error: (error: unknown) => {
                        if (error instanceof UnacceptableAccountError) {
                          owned = false;
                        }
                      },
                    }),
                  );
              }),
              oneValue(),
              map((outcome): NewDeviceState => {
                if (outcome.kind !== 'ready') {
                  throw new Error(
                    `The QR sign-in did not start (${outcome.kind}).`,
                  );
                }
                return { kind: 'done' };
              }),
            );
          }
          default:
            return of(update);
        }
      };
      return concat(
        of<NewDeviceState>({ kind: 'creating' }),
        this.engine.authMetadata(homeserverUrl).pipe(
          unwrapEngineResult(),
          switchMap((found) => {
            if (!found) throw new Error('The server has no OAuth metadata.');
            metadata = found;
            return this.oidc.deviceGrantMetadata(metadata);
          }),
          oneValue(),
          switchMap((verified) => {
            grantMetadata = verified;
            return this.oidc.deviceGrantClientId(metadata, homeserverUrl);
          }),
          oneValue(),
          switchMap(signIn),
        ),
      ).pipe(
        catchError((error: unknown) =>
          of<NewDeviceState>({
            kind: 'failed',
            reason: newDeviceFailure(error),
          }),
        ),
        finalize(() => {
          if (current === answer) current = undefined;
          answers.unsubscribe();
          if (handedOver && !owned) {
            this.sessionEngine
              .logoutSession(handedOver)
              .subscribe({ error: () => undefined });
          }
        }),
      );
    });
    return { state$, enterCheckCode: (code) => current?.(code) };
  }

  /**
   * Captures the active account now, so a link started from it never runs as an account
   * switched to later. Null when no account is live.
   */
  linkerForActiveAccount(): QrDeviceLinker | null {
    const accountId = this.sessionState.activeAccountId();
    if (!accountId || !this.sessionState.accountIds().includes(accountId)) {
      return null;
    }
    return { accountId, link: (qrBytes) => this.link(accountId, qrBytes) };
  }

  /**
   * `state$` is cold: each subscription is one link. At the engine's `approve` pause the link
   * goes on only once the approval link is on the account's own server, this device holds the
   * published identity, and the person continues with `approve`.
   */
  private link(accountId: string, qrBytes: Uint8Array): ExistingDeviceLink {
    let current: (() => void) | undefined;
    const state$ = new Observable<ExistingDeviceState>((subscriber) => {
      const work = new Subscription();
      let paused: { flowId: string; verificationUri: string } | null = null;
      const approve = () => {
        const pause = paused;
        paused = null;
        if (!pause) return;
        // Before the confirm, so the engine's next update can never overtake it.
        subscriber.next({
          kind: 'approve-in-browser',
          verificationUri: pause.verificationUri,
        });
        work.add(
          this.engine.confirmQrLink(pause.flowId).subscribe((result) => {
            if (!result.ok) {
              subscriber.next({ kind: 'failed', reason: 'unknown' });
              subscriber.complete();
            }
          }),
        );
      };
      current = approve;
      work.add(
        this.engine
          .linkDeviceWithQr(accountId, toBase64(qrBytes))
          .pipe(
            switchMap((update): Observable<ExistingDeviceState> => {
              paused = null;
              if (update.kind !== 'approve') return of(update);
              const { flowId, verificationUri } = update;
              return this.approvalRefusal(accountId, verificationUri).pipe(
                map((reason): ExistingDeviceState => {
                  if (reason) return { kind: 'failed', reason };
                  paused = { flowId, verificationUri };
                  return { kind: 'approve', verificationUri };
                }),
              );
            }),
            catchError((error: unknown) =>
              of<ExistingDeviceState>({
                kind: 'failed',
                reason: qrSignInFailureOf(error),
              }),
            ),
            // Leaving the engine's flow before confirming declines and cancels it.
            takeWhile((state) => state.kind !== 'failed', true),
          )
          .subscribe({
            next: (state) => subscriber.next(state),
            complete: () => subscriber.complete(),
          }),
      );
      return () => {
        if (current === approve) current = undefined;
        work.unsubscribe();
      };
    });
    return { state$, approve: () => current?.() };
  }

  /** Why the link must not go on at `approve`, or null when it may. */
  private approvalRefusal(
    accountId: string,
    verificationUri: string,
  ): Observable<QrSignInFailure | null> {
    return this.onAccountServer(accountId, verificationUri).pipe(
      switchMap((onServer) =>
        onServer
          ? // Security: share only the identity the server publishes.
            this.identity.holdsPublishedIdentity(accountId).pipe(
              take(1),
              defaultIfEmpty(false),
              catchError(() => of(false)),
              map((held) => (held ? null : 'unknown')),
            )
          : of('insecure' as const),
      ),
    );
  }

  /** Security: the peer chooses the approval link, so it may open only on the account's server. */
  private onAccountServer(accountId: string, uri: string): Observable<boolean> {
    return this.storage.record(accountId).pipe(
      oneValue(),
      switchMap((stored) => {
        if (!stored) throw new Error('The linking account is not stored.');
        return this.engine.authMetadata(stored.baseUrl);
      }),
      unwrapEngineResult(),
      oneValue(),
      map((metadata) => {
        const origin = originOf(uri);
        return (
          origin !== null &&
          [metadata?.issuer, metadata?.device_authorization_endpoint].some(
            (url) => url !== undefined && originOf(url) === origin,
          )
        );
      }),
    );
  }
}

/** The first value of a sign-in step; an empty step fails at once instead of stalling the flow. */
function oneValue<T>(): MonoTypeOperatorFunction<T> {
  return pipe(
    take(1),
    throwIfEmpty(() => new Error('The sign-in step returned nothing.')),
  );
}

/** An account the server check refused is on another server, as far as the new device can tell. */
function newDeviceFailure(error: unknown): QrSignInFailure {
  return error instanceof UnacceptableAccountError &&
    error.reason !== 'malformed'
    ? 'other-server'
    : qrSignInFailureOf(error);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
