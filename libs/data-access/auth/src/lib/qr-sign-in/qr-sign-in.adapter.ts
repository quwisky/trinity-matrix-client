import { Injectable, inject } from '@angular/core';
import { QrCodeData, QrCodeIntent } from '@matrix-org/matrix-sdk-crypto-wasm';
import {
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
import { Observable, firstValueFrom, type Subscriber } from 'rxjs';
import { lacksAuthMetadata } from '../account-server-api';
import { QR_SIGN_IN_COMPLETION } from './qr-sign-in-completion.port';
import {
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
// Synapse keeps a rendezvous session for 60 s; the SDK does not expose the server's expiry.
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
  ): Promise<{ flow: QrRendezvousFlow; metadata: ValidatedAuthMetadata }> {
    await firstValueFrom(preloadCryptoWasm());
    const client = createClient({ baseUrl: homeserverUrl });
    try {
      const metadata = await client.getAuthMetadata();
      const session = new MSC4108RendezvousSession({ client, onFailure });
      const channel = new MSC4108SecureChannel(session, undefined, onFailure);
      const flow = new MSC4108SignInWithQR(
        channel,
        false,
        undefined,
        onFailure,
      );
      // Creates the session, which gives it the URL the code carries.
      await session.send('');
      return { flow, metadata };
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

  /** Cold: each subscription shows a new code. */
  signInByShowingCode(homeserverUrl: string): Observable<NewDeviceState> {
    return new Observable<NewDeviceState>((subscriber) => {
      const run = new FlowRun(subscriber);
      run.start(async () => {
        run.emit({ kind: 'creating' });
        const { flow, metadata } = await this.factory.newDevice(
          homeserverUrl,
          run.onFailure,
        );
        run.attach(flow);
        const clientId = await run.step(
          firstValueFrom(this.completion.deviceGrantClientId(metadata)),
        );
        await run.step(flow.generateCode());
        run.emit({
          kind: 'showing-code',
          qr: required(flow.code),
          expiresAt: Date.now() + CODE_LIFETIME_MS,
        });
        await run.step(flow.negotiateProtocols());
        run.emit({
          kind: 'confirm-check-code',
          code: required(flow.checkCode),
        });
        const { userCode } = await run.step(
          flow.deviceAuthorizationGrant({
            metadata,
            clientId,
            deviceId: newDeviceId(),
          }),
        );
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
        const client = await run.step(
          firstValueFrom(
            this.completion.completeDeviceGrant(
              tokens,
              clientId,
              metadata,
              homeserverUrl,
            ),
          ),
        );
        const { secrets } = await run.step(flow.shareSecrets());
        const verified = secrets
          ? await run.step(
              firstValueFrom(
                this.completion.importLinkedSecrets(client, secrets),
              ),
            )
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
        // From here a cancel must reach the session at once: shareSecrets sends the secrets
        // unless the session is already cancelled, and a decline PUT first could let them out.
        run.declineOnCancel = false;
        const { verificationUri } = await run.step(
          flow.deviceAuthorizationGrant(),
        );
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
  private respond?: (match: boolean) => void;

  /** Send a decline before cancelling, so the other device learns the user stopped. */
  declineOnCancel = false;

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
    await flow.close().catch(() => undefined);
  }
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
