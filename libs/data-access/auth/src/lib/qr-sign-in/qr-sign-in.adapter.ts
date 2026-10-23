import { Injectable, inject } from '@angular/core';
import { QrCodeData, QrCodeIntent } from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  OAuth2Error,
  OAuthGrantType,
  createClient,
  type MatrixClient,
  type ValidatedAuthMetadata,
} from 'matrix-js-sdk';
import {
  ClientRendezvousFailureReason,
  MSC4108FailureReason,
  MSC4108RendezvousSession,
  MSC4108SecureChannel,
  MSC4108SignInWithQR,
  RendezvousError,
  type RendezvousFailureListener,
} from 'matrix-js-sdk/lib/rendezvous';
import { preloadCryptoWasm } from '@trinity/util/matrix';
import {
  Observable,
  Subscription,
  firstValueFrom,
  take,
  type Subscriber,
} from 'rxjs';
import { verifyAccountServer } from '../account-establishment';
import { lacksAuthMetadata } from '../account-server-api';
import { AUTHENTICATION_HOMESERVER_DISCOVERY } from '../homeserver-discovery.port';
import {
  QR_LINK_IDENTITY_CHECK,
  QR_SIGN_IN_COMPLETION,
} from './qr-sign-in-completion.port';
import {
  DeviceGrantRejectedError,
  OtherServerError,
  qrSignInFailureOf,
  type ExistingDeviceState,
  type NewDeviceState,
  type QrSignInFailure,
} from './qr-sign-in.model';

// The message of the SDK's OAuth2Error.OpSupport, thrown for metadata that fails validation.
const INVALID_AUTH_METADATA =
  'Configured OAuth2 OP does not support required functions';

// Thrown by the SDK's rendezvous session when the homeserver has no MSC4108 endpoint.
const INVALID_RENDEZVOUS_URI = 'Invalid rendezvous URI';
// Synapse keeps a rendezvous session for 60 s; used when the server sends no Expires header.
const CODE_LIFETIME_MS = 60_000;
const DEVICE_ID_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const STOPPED = Symbol('stopped');

export type QrRendezvousFlow = MSC4108SignInWithQR;

/** Builds the SDK's MSC4108 objects; specs replace it with fakes. */
@Injectable({ providedIn: 'root' })
export class QrRendezvousFactory {
  /** Opens a rendezvous session on the homeserver for a device that shows the code. */
  async newDevice(
    homeserverUrl: string,
    onFailure: RendezvousFailureListener,
  ): Promise<{
    flow: QrRendezvousFlow;
    metadata: ValidatedAuthMetadata;
    expires: string | null;
  }> {
    await firstValueFrom(preloadCryptoWasm());
    const client = createClient({ baseUrl: homeserverUrl });
    try {
      const metadata = await client.getAuthMetadata();
      let expires: string | null = null;
      // The SDK keeps the Expires header of the session-creating POST to itself.
      const fetchFn: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === 'POST') expires = response.headers.get('expires');
        return response;
      };
      const session = new MSC4108RendezvousSession({
        client,
        onFailure,
        fetchFn,
      });
      const channel = new MSC4108SecureChannel(session, undefined, onFailure);
      const flow = new MSC4108SignInWithQR(
        channel,
        false,
        undefined,
        onFailure,
      );
      // Creates the session, which gives it the URL the code carries.
      await session.send('');
      return { flow, metadata, expires };
    } finally {
      client.stopClient();
    }
  }

  /** Null when the bytes are not a code that a new device shows for MSC4108 sign-in. */
  async existingDevice(
    client: MatrixClient,
    qrBytes: Uint8Array,
    onFailure: RendezvousFailureListener,
  ): Promise<QrRendezvousFlow | null> {
    await firstValueFrom(preloadCryptoWasm());
    let qr: QrCodeData;
    try {
      qr = QrCodeData.fromBytes(qrBytes);
    } catch {
      return null;
    }
    // An MSC4388 code has no rendezvous URL, and the SDK speaks only MSC4108.
    if (qr.mode !== QrCodeIntent.Login || !qr.rendezvousUrl) return null;
    const session = new MSC4108RendezvousSession({
      url: qr.rendezvousUrl,
      onFailure,
    });
    const channel = new MSC4108SecureChannel(session, qr.publicKey, onFailure);
    return new MSC4108SignInWithQR(channel, true, client, onFailure);
  }
}

/** The existing device's side of a link, with the check-code answer as its input. */
export interface ExistingDeviceLink {
  readonly state$: Observable<ExistingDeviceState>;
  confirmCheckCode(match: boolean): void;
}

/** The seam to the SDK's QR sign-in (MSC4108) support. */
@Injectable({ providedIn: 'root' })
export class QrSignInAdapter {
  private readonly factory = inject(QrRendezvousFactory);
  private readonly completion = inject(QR_SIGN_IN_COMPLETION);
  private readonly identity = inject(QR_LINK_IDENTITY_CHECK);
  private readonly discovery = inject(AUTHENTICATION_HOMESERVER_DISCOVERY);

  /**
   * Cold: each subscription shows a new code. `serverName` is the server the person entered;
   * the other device's account must be on it.
   */
  signInByShowingCode(
    homeserverUrl: string,
    serverName: string,
  ): Observable<NewDeviceState> {
    return new Observable<NewDeviceState>((subscriber) => {
      const run = new FlowRun(subscriber);
      run.start(async () => {
        run.emit({ kind: 'creating' });
        const { flow, metadata, expires } = await this.factory.newDevice(
          homeserverUrl,
          run.onFailure,
        );
        run.attach(flow);
        const grantMetadata = await run.read(
          this.completion.deviceGrantMetadata(metadata),
        );
        let clientId = await run.read(
          this.completion.deviceGrantClientId(metadata, homeserverUrl),
        );
        await run.step(flow.generateCode());
        run.emit({
          kind: 'showing-code',
          qr: required(flow.code),
          expiresAt: codeExpiry(expires),
        });
        const reported = await run.step(flow.negotiateProtocols());
        // The other device's account must be on the server entered before any grant is asked for.
        if (
          !(await run.step(
            this.isEnteredServer(
              reported.serverName,
              serverName,
              homeserverUrl,
            ),
          ))
        ) {
          throw new OtherServerError();
        }
        run.emit({
          kind: 'confirm-check-code',
          code: required(flow.checkCode),
        });
        const deviceId = newDeviceId();
        const grant = () =>
          run.step(
            flow.deviceAuthorizationGrant({
              metadata: grantMetadata,
              clientId,
              deviceId,
            }),
          );
        // A cached client the provider no longer accepts fails before anything is sent to
        // the other device, so the grant can be retried once on the same flow.
        const { userCode } = await grant().catch(async (error: unknown) => {
          if (!isClientRejection(error)) throw error;
          await run.read(
            this.completion.forgetDeviceGrantClientId(metadata, homeserverUrl),
          );
          clientId = await run.read(
            this.completion.deviceGrantClientId(metadata, homeserverUrl),
          );
          return grant().catch((retryError: unknown) => {
            throw isClientRejection(retryError)
              ? new DeviceGrantRejectedError()
              : retryError;
          });
        });
        run.emit({
          kind: 'waiting-for-approval',
          userCode: required(userCode),
        });
        const tokens = required(
          await run.step(flow.completeLoginOnNewDevice({ clientId })),
        );
        run.emit({ kind: 'signing-in' });
        // The device must exist before shareSecrets: the existing device sends the secrets
        // only once it sees the new device on the server, and gives up after 10 s.
        const client = await run.read(
          this.completion.completeDeviceGrant(
            tokens,
            clientId,
            grantMetadata,
            homeserverUrl,
          ),
        );
        // The account is stored and running, so a failed secrets stage leaves it signed in
        // but unverified, for the app's usual verification prompt.
        run.failAs = { kind: 'done', verified: false };
        const { secrets } = await run.step(flow.shareSecrets());
        const verified = secrets
          ? await run.read(this.completion.importLinkedSecrets(client, secrets))
          : false;
        run.finish({ kind: 'done', verified });
      });
      return () => run.teardown();
    });
  }

  /** `state$` is cold: each subscription is one link, and `confirmCheckCode` answers it. */
  linkByScanning(
    client: MatrixClient,
    qrBytes: Uint8Array,
  ): ExistingDeviceLink {
    let current: FlowRun<ExistingDeviceState> | undefined;
    const state$ = new Observable<ExistingDeviceState>((subscriber) => {
      const run = new FlowRun(subscriber);
      run.closesSession = false;
      current = run;
      run.start(async () => {
        run.emit({ kind: 'connecting' });
        const flow = await this.factory.existingDevice(
          client,
          qrBytes,
          run.onFailure,
        );
        if (!flow) {
          run.finish({ kind: 'not-sign-in-code' });
          return;
        }
        run.attach(flow);
        await run.step(flow.negotiateProtocols());
        // Only the existing device can send a decline, and only over a connected channel.
        // The new device receives it as user_cancelled, which it reports as declined.
        run.declineOnCancel = true;
        run.emit({
          kind: 'confirm-check-code',
          code: required(flow.checkCode),
        });
        // Security: nothing beyond the protocol offer leaves this device until the user
        // confirms that both devices show the same check code. A mismatch may mean a
        // man-in-the-middle holds the channel, so it ends the link before any secret is sent.
        const match = await run.step(run.awaitAnswer());
        if (!match) {
          await flow.declineLoginOnExistingDevice().catch(() => undefined);
          await flow
            .cancel(ClientRendezvousFailureReason.InsecureChannelDetected)
            .catch(() => undefined);
          run.fail(ClientRendezvousFailureReason.InsecureChannelDetected, true);
          return;
        }
        // Security: share only the identity the server publishes. Checked before the grant, so
        // a refusal leaves no approved device behind; it fails as `unknown` and, through
        // teardown, declines and cancels on the new device.
        if (!(await run.read(this.identity.holdsPublishedIdentity(client)))) {
          throw new Error(
            'This device does not hold the published cross-signing identity.',
          );
        }
        // From here a cancel must reach the session at once: shareSecrets sends the secrets
        // unless the session is already cancelled, and a decline PUT first could let them out.
        run.declineOnCancel = false;
        const { verificationUri } = await run.step(
          flow.deviceAuthorizationGrant(),
        );
        // Security: the peer chooses this link, so open it only on the account's own server.
        if (
          !(await run.step(onAccountServer(client, required(verificationUri))))
        ) {
          run.fail(ClientRendezvousFailureReason.InsecureChannelDetected);
          return;
        }
        run.emit({
          kind: 'approve-in-browser',
          verificationUri: required(verificationUri),
        });
        run.emit({ kind: 'sharing-secrets' });
        await run.step(flow.shareSecrets());
        run.finish({ kind: 'done' });
      });
      return () => {
        if (current === run) current = undefined;
        run.teardown();
      };
    });
    return {
      state$,
      confirmCheckCode: (match) => current?.answer(match),
    };
  }

  /** Whether an account on `reported` is accepted as one on the homeserver entered. */
  private async isEnteredServer(
    reported: string | undefined,
    entered: string,
    homeserverUrl: string,
  ): Promise<boolean> {
    if (!reported) return false;
    // A user ID's server name has no root dot.
    const userId = `@_:${reported.replace(/\.$/, '')}`;
    return firstValueFrom(
      verifyAccountServer(homeserverUrl, userId, this.discovery, entered),
    ).then(
      () => true,
      () => false,
    );
  }

  /**
   * Same checks as the SDK's isSignInWithQRAvailable, except that an unreachable server
   * rejects instead of resolving false, so "unreachable" differs from "not supported". A server
   * with no usable auth metadata (404, M_UNRECOGNIZED, invalid metadata) is "not supported".
   */
  async isAvailable(homeserverUrl: string): Promise<boolean> {
    const client = createClient({ baseUrl: homeserverUrl });
    try {
      const metadata = await client
        .getAuthMetadata()
        .catch((error: unknown) => {
          if (
            lacksAuthMetadata(error) ||
            (error instanceof Error && error.message === INVALID_AUTH_METADATA)
          ) {
            return null;
          }
          throw error;
        });
      if (!metadata) return false;
      if (
        !metadata.grant_types_supported.includes(
          OAuthGrantType.DeviceAuthorization,
        )
      ) {
        return false;
      }
      return await client.doesServerSupportUnstableFeature(
        'org.matrix.msc4108',
      );
    } finally {
      client.stopClient();
    }
  }
}

/**
 * One subscription's flow. It reports only the first failure, stops at the next step once
 * ended, and on teardown tells the other device unless the flow finished or the channel
 * already ended.
 */
class FlowRun<S extends { kind: string }> {
  private flow?: QrRendezvousFlow;
  private ended = false;
  private finished = false;
  private channelEnded = false;
  private released = false;
  private readonly reads = new Subscription();
  private respond?: (match: boolean) => void;

  /** Send a decline before cancelling, so the other device learns the user stopped. */
  declineOnCancel = false;
  /** Set once the flow's outcome stands: a later failure ends with it instead. */
  failAs?: S;
  /**
   * Delete the rendezvous session at the end. The existing device leaves that to the new
   * device, which reads the secrets only after the existing device has sent them. The SDK's
   * cancel still deletes it.
   */
  closesSession = true;

  constructor(
    private readonly subscriber: Subscriber<
      S | { kind: 'failed'; reason: QrSignInFailure }
    >,
  ) {}

  readonly onFailure: RendezvousFailureListener = (reason) =>
    this.fail(reason, true);

  start(body: () => Promise<void>): void {
    body().catch((error: unknown) => {
      if (error !== STOPPED) this.fail(error);
    });
  }

  attach(flow: QrRendezvousFlow): void {
    this.flow = flow;
    if (this.ended) {
      void this.release();
      throw STOPPED;
    }
  }

  async step<T>(work: Promise<T>): Promise<T> {
    const value = await work;
    if (this.ended) throw STOPPED;
    return value;
  }

  /** {@link step} for an observable, which teardown unsubscribes. */
  read<T>(source: Observable<T>): Promise<T> {
    return this.step(
      new Promise<T>((resolve, reject) => {
        this.reads.add(
          source.pipe(take(1)).subscribe({
            next: resolve,
            error: reject,
            complete: () =>
              reject(new Error('The sign-in step returned nothing.')),
          }),
        );
      }),
    );
  }

  /** Resolves with the first answer given after this call; earlier answers are ignored. */
  awaitAnswer(): Promise<boolean> {
    return new Promise((resolve) => (this.respond = resolve));
  }

  answer(match: boolean): void {
    const respond = this.respond;
    this.respond = undefined;
    respond?.(match);
  }

  emit(state: S): void {
    if (!this.ended) this.subscriber.next(state);
  }

  finish(state: S): void {
    this.finished = true;
    this.emit(state);
    this.subscriber.complete();
  }

  fail(error: unknown, channelEnded = false): void {
    if (this.ended) return;
    this.channelEnded = channelEnded || error instanceof RendezvousError;
    if (this.failAs) {
      this.subscriber.next(this.failAs);
      this.subscriber.complete();
      return;
    }
    const reason =
      error instanceof RendezvousError
        ? error.code
        : error instanceof Error && error.message === INVALID_RENDEZVOUS_URI
          ? ClientRendezvousFailureReason.HomeserverLacksSupport
          : error;
    this.subscriber.next({
      kind: 'failed',
      reason: qrSignInFailureOf(reason),
    });
    this.subscriber.complete();
  }

  teardown(): void {
    this.ended = true;
    this.reads.unsubscribe();
    this.respond = undefined;
    void this.release();
  }

  private async release(): Promise<void> {
    const flow = this.flow;
    if (!flow || this.released) return;
    this.released = true;
    if (!this.finished && !this.channelEnded) {
      if (this.declineOnCancel) {
        await flow.declineLoginOnExistingDevice().catch(() => undefined);
      }
      await flow
        .cancel(MSC4108FailureReason.UserCancelled)
        .catch(() => undefined);
    }
    if (this.closesSession) await flow.close().catch(() => undefined);
  }
}

/** The SDK's error for an OAuth error answer from the device-authorization endpoint. */
function isClientRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === OAuth2Error.InvalidDeviceAuthorizationResponse
  );
}

/** Whether a peer-sent link opens on the account's OAuth issuer or device endpoint. */
async function onAccountServer(
  client: MatrixClient,
  uri: string,
): Promise<boolean> {
  const metadata = await client.getAuthMetadata();
  const origin = originOf(uri);
  return (
    origin !== null &&
    [metadata.issuer, metadata.device_authorization_endpoint].some(
      (url) => url !== undefined && originOf(url) === origin,
    )
  );
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function codeExpiry(expires: string | null): number {
  const at = expires ? Date.parse(expires) : NaN;
  return Number.isNaN(at) ? Date.now() + CODE_LIFETIME_MS : at;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The rendezvous returned no value');
  return value;
}

function newDeviceId(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (byte) => DEVICE_ID_CHARS[byte % DEVICE_ID_CHARS.length],
  ).join('');
}
