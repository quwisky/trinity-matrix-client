import { Injectable, inject } from '@angular/core';
import {
  Observable,
  Subscription,
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  finalize,
  firstValueFrom,
  ignoreElements,
  of,
  pipe,
  switchMap,
  take,
  throwIfEmpty,
  type MonoTypeOperatorFunction,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { AUTH_ENGINE } from '../auth-engine.token';
import type { QrGrantTokens, QrSignInUpdate } from '../auth-engine';
import type { AuthMetadata } from '../auth-metadata';
import { AuthService } from '../auth.service';
import { verifyAccountServer } from '../account-establishment';
import { AUTHENTICATION_HOMESERVER_DISCOVERY } from '../homeserver-discovery.port';
import { OidcClientService } from '../oidc-client.service';
import { QR_LINK_IDENTITY_CHECK } from './qr-link-identity-check.port';
import {
  DeviceGrantRejectedError,
  OtherServerError,
  QrAccountAlreadyStoredError,
  qrSignInFailureOf,
  type ExistingDeviceState,
  type NewDeviceState,
} from './qr-sign-in.model';

/** The existing device's side of a link, with the check-code answer as its input. */
export interface ExistingDeviceLink {
  readonly state$: Observable<ExistingDeviceState>;
  confirmCheckCode(match: boolean): void;
}

/** Links devices as the one account it was created for. */
export interface QrDeviceLinker {
  readonly accountId: string;
  /** Links the device whose code this device scanned; `state$` is cold. */
  link(qrBytes: Uint8Array): ExistingDeviceLink;
}

/**
 * Sign-in by QR code (MSC4108): a new device shows the code, an existing device scans it.
 * The engine runs the rendezvous; every security decision is made here, while it waits.
 */
@Injectable({ providedIn: 'root' })
export class QrSignInService {
  private readonly engine = inject(AUTH_ENGINE);
  private readonly auth = inject(AuthService);
  private readonly oidc = inject(OidcClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly sessionState = inject(SessionStateService);
  private readonly identity = inject(QR_LINK_IDENTITY_CHECK);
  private readonly discovery = inject(AUTHENTICATION_HOMESERVER_DISCOVERY);

  /**
   * Cold: each subscription shows a new code; unsubscribing cancels the sign-in. The other
   * device must be signed in on `serverName`, the server entered. Until the account is being
   * established, any failure or unsubscribe revokes the tokens the grant issued.
   */
  signInByShowingCode(
    homeserverUrl: string,
    serverName: string,
  ): Observable<NewDeviceState> {
    return defer(() => {
      let metadata: AuthMetadata;
      let grantMetadata: AuthMetadata;
      let clientId = '';
      let retried = false;
      let tokens: QrGrantTokens | null = null;
      let owned = false;
      const onUpdate = (update: QrSignInUpdate): Observable<NewDeviceState> => {
        switch (update.kind) {
          case 'showing-code':
            return of({
              kind: 'showing-code',
              qr: fromBase64(update.qr),
              expiresAt: update.expiresAt,
            });
          case 'server-reported':
            return this.isEnteredServer(
              update.serverName,
              serverName,
              homeserverUrl,
            ).pipe(
              switchMap((entered) => {
                if (!entered) throw new OtherServerError();
                return this.engine.answerQrSignIn(update.flowId, {
                  kind: 'server-accepted',
                });
              }),
              ignoreElements(),
            );
          case 'client-rejected':
            // A cached client the provider no longer accepts: register once more and retry.
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
                switchMap((fresh) => {
                  clientId = fresh;
                  return this.engine.answerQrSignIn(update.flowId, {
                    kind: 'retry-grant',
                    clientId: fresh,
                  });
                }),
                ignoreElements(),
              );
          case 'signing-in':
            tokens = update.tokens;
            return of({ kind: 'signing-in' });
          case 'signed-in': {
            const issued = tokens;
            if (!issued) throw new Error('The QR sign-in issued no tokens.');
            return this.storage.record(update.userId).pipe(
              oneValue(),
              switchMap((stored) => {
                if (stored) throw new QrAccountAlreadyStoredError();
                return this.oidc.deviceGrantBinding(grantMetadata, clientId);
              }),
              oneValue(),
              switchMap((binding) => {
                owned = true;
                return this.auth.establishDeviceGrant(homeserverUrl, {
                  user_id: update.userId,
                  device_id: update.deviceId,
                  access_token: issued.accessToken,
                  ...(issued.refreshToken
                    ? { refresh_token: issued.refreshToken }
                    : {}),
                  ...(issued.accessTokenExpiresAt !== null
                    ? { accessTokenExpiresAt: issued.accessTokenExpiresAt }
                    : {}),
                  oidc: binding,
                });
              }),
              oneValue(),
              switchMap((outcome) => {
                if (outcome.kind !== 'ready') {
                  throw new Error(
                    `The QR sign-in did not start (${outcome.kind}).`,
                  );
                }
                // The device exists on the server now, so the engine may share the secrets.
                return this.engine.continueQrSignIn(
                  update.flowId,
                  outcome.accountId,
                );
              }),
              ignoreElements(),
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
          switchMap((id) => {
            clientId = id;
            return this.engine.signInWithQr(homeserverUrl, {
              grantMetadata,
              clientId,
            });
          }),
          // The engine waits at each pause, so a new update is a failure that ends the step.
          switchMap(onUpdate),
        ),
      ).pipe(
        catchError((error: unknown) =>
          of<NewDeviceState>({
            kind: 'failed',
            reason: qrSignInFailureOf(error),
          }),
        ),
        finalize(() => {
          if (!tokens || owned) return;
          this.oidc
            .revokeTokens(
              homeserverUrl,
              { issuer: grantMetadata.issuer, clientId },
              {
                accessToken: tokens.accessToken,
                ...(tokens.refreshToken
                  ? { refreshToken: tokens.refreshToken }
                  : {}),
              },
            )
            .subscribe({ error: () => undefined });
        }),
      );
    });
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

  /** `state$` is cold: each subscription is one link, and `confirmCheckCode` answers it. */
  private link(accountId: string, qrBytes: Uint8Array): ExistingDeviceLink {
    let current: ((match: boolean) => void) | undefined;
    const state$ = new Observable<ExistingDeviceState>((subscriber) => {
      const work = new Subscription();
      let waiting: string | null = null;
      const answer = (match: boolean) => {
        const flowId = waiting;
        waiting = null;
        if (flowId === null) return;
        // Security: share only the identity the server publishes, read before the grant.
        const identityHeld = match
          ? this.identity.holdsPublishedIdentity(accountId).pipe(
              take(1),
              defaultIfEmpty(false),
              catchError(() => of(false)),
            )
          : of(false);
        work.add(
          identityHeld
            .pipe(
              switchMap((held) =>
                this.engine.confirmQrLink(flowId, {
                  match,
                  identityHeld: held,
                }),
              ),
            )
            .subscribe(),
        );
      };
      current = answer;
      work.add(
        this.engine.linkDeviceWithQr(accountId, toBase64(qrBytes)).subscribe({
          next: (update) => {
            if (update.kind === 'confirm-check-code') {
              waiting = update.flowId;
              subscriber.next({
                kind: 'confirm-check-code',
                code: update.code,
              });
            } else {
              subscriber.next(update);
            }
          },
          error: (error: unknown) => subscriber.error(error),
          complete: () => subscriber.complete(),
        }),
      );
      return () => {
        if (current === answer) current = undefined;
        work.unsubscribe();
      };
    });
    return { state$, confirmCheckCode: (match) => current?.(match) };
  }

  /** Whether an account on `reported` is accepted as one on the homeserver entered. */
  private isEnteredServer(
    reported: string | null,
    entered: string,
    homeserverUrl: string,
  ): Observable<boolean> {
    if (!reported) return of(false);
    // A user ID's server name has no root dot.
    const userId = `@_:${reported.replace(/\.$/, '')}`;
    return defer(() =>
      firstValueFrom(
        verifyAccountServer(homeserverUrl, userId, this.discovery, entered),
      ).then(
        () => true,
        () => false,
      ),
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

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
