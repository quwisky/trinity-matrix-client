import { Injectable, inject } from '@angular/core';
import { QrCodeData, QrCodeIntent } from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  OAuth2Error,
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
import {
  JS_SDK_CLIENTS,
  importLinkedSecrets,
} from '@trinity/data-access/matrix-client';
import {
  engineFail,
  engineOk,
  preloadCryptoWasm,
  type EngineResult,
} from '@trinity/util/matrix';
import { Observable, defer, firstValueFrom, of, type Subscriber } from 'rxjs';
import type {
  QrLinkAnswer,
  QrLinkUpdate,
  QrSignInAnswer,
  QrSignInUpdate,
} from '../auth-engine';
import type { AuthMetadata } from '../auth-metadata';
import {
  qrSignInFailureOf,
  type QrSignInFailure,
} from '../qr-sign-in/qr-sign-in.model';

// Thrown by the SDK's rendezvous session when the homeserver has no MSC4108 endpoint.
const INVALID_RENDEZVOUS_URI = 'Invalid rendezvous URI';
// Synapse keeps a rendezvous session for 60 s; used when the server sends no Expires header.
const CODE_LIFETIME_MS = 60_000;
const DEVICE_ID_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const STOPPED = Symbol('stopped');
const QR_FLOW_GONE = engineFail({
  kind: 'unexpected',
  code: 'qr-flow-gone',
  diagnostic: { kind: 'unexpected' },
});

export type QrRendezvousFlow = MSC4108SignInWithQR;
/** What a paused flow waits for, keyed by the pause. */
interface Answers {
  server: void;
  grant: string;
  established: string;
  'check-code': QrLinkAnswer;
}

/** Builds the SDK's MSC4108 objects; specs replace it with fakes. */
@Injectable({ providedIn: 'root' })
export class QrRendezvousFactory {
  /** Opens a rendezvous session on the homeserver for a device that shows the code. */
  async newDevice(
    homeserverUrl: string,
    onFailure: RendezvousFailureListener,
  ): Promise<{ flow: QrRendezvousFlow; expires: string | null }> {
    await firstValueFrom(preloadCryptoWasm());
    const client = createClient({ baseUrl: homeserverUrl });
    try {
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
      return { flow, expires };
    } finally {
      client.stopClient();
    }
  }

  /** Null when the base64 is not a code that a new device shows for MSC4108 sign-in. */
  async existingDevice(
    client: MatrixClient,
    qr: string,
    onFailure: RendezvousFailureListener,
  ): Promise<QrRendezvousFlow | null> {
    await firstValueFrom(preloadCryptoWasm());
    let code: QrCodeData;
    try {
      code = QrCodeData.fromBytes(fromBase64(qr));
    } catch {
      return null;
    }
    // An MSC4388 code has no rendezvous URL, and the SDK speaks only MSC4108.
    if (code.mode !== QrCodeIntent.Login || !code.rendezvousUrl) return null;
    const session = new MSC4108RendezvousSession({
      url: code.rendezvousUrl,
      onFailure,
    });
    const channel = new MSC4108SecureChannel(
      session,
      code.publicKey,
      onFailure,
    );
    return new MSC4108SignInWithQR(channel, true, client, onFailure);
  }
}

/** The QR members of the js-sdk auth engine: MSC4108 on the SDK's experimental rendezvous. */
@Injectable({ providedIn: 'root' })
export class JsSdkQrRendezvous {
  private readonly factory = inject(QrRendezvousFactory);
  private readonly clients = inject(JS_SDK_CLIENTS);
  private readonly runs = new Map<string, FlowRun<{ kind: string }>>();

  signInWithQr(
    baseUrl: string,
    request: {
      readonly grantMetadata: AuthMetadata;
      readonly clientId: string;
    },
  ): Observable<QrSignInUpdate> {
    return new Observable<QrSignInUpdate>((subscriber) => {
      const run = this.track(new FlowRun(subscriber));
      run.start(async () => {
        const { flow, expires } = await this.factory.newDevice(
          baseUrl,
          run.onFailure,
        );
        run.attach(flow);
        await run.step(flow.generateCode());
        run.emit({
          kind: 'showing-code',
          qr: toBase64(required(flow.code)),
          expiresAt: codeExpiry(expires),
        });
        const reported = await run.step(flow.negotiateProtocols());
        // The other device's account must be on the server entered before any grant is asked for.
        await run.pause('server', {
          kind: 'server-reported',
          flowId: run.id,
          serverName: reported.serverName ?? null,
        });
        run.emit({
          kind: 'confirm-check-code',
          code: required(flow.checkCode),
        });
        const deviceId = newDeviceId();
        // Only the fields the SDK reads; TypeScript verified the endpoints.
        const metadata = request.grantMetadata as ValidatedAuthMetadata;
        let clientId = request.clientId;
        let userCode: string | undefined;
        for (;;) {
          try {
            ({ userCode } = await run.step(
              flow.deviceAuthorizationGrant({ metadata, clientId, deviceId }),
            ));
            break;
          } catch (error: unknown) {
            if (!isClientRejection(error)) throw error;
            // Refused before anything was sent to the other device, so the grant can be
            // asked for again on the same flow, with the client TypeScript registers.
            clientId = await run.pause('grant', {
              kind: 'client-rejected',
              flowId: run.id,
            });
          }
        }
        run.emit({
          kind: 'waiting-for-approval',
          userCode: required(userCode),
        });
        const tokens = required(
          await run.step(flow.completeLoginOnNewDevice({ clientId })),
        );
        const issuedAt = Date.now();
        run.emit({
          kind: 'signing-in',
          tokens: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            accessTokenExpiresAt:
              tokens.expires_in === undefined
                ? null
                : issuedAt + tokens.expires_in * 1000,
          },
        });
        const who = await run.step(
          createClient({
            baseUrl,
            accessToken: tokens.access_token,
          }).whoami(),
        );
        if (!who.device_id) {
          throw new Error('The provider returned no device for this session.');
        }
        // The device must exist before shareSecrets: the existing device sends the secrets
        // only once it sees the new device on the server, and gives up after 10 s.
        const accountId = await run.pause('established', {
          kind: 'signed-in',
          flowId: run.id,
          userId: who.user_id,
          deviceId: who.device_id,
        });
        // The account is stored and running, so a failed secrets stage leaves it signed in
        // but unverified, for the app's usual verification prompt.
        run.failAs = { kind: 'done', verified: false };
        const { secrets } = await run.step(flow.shareSecrets());
        // Security: import only into the session the grant confirmed, the same account on the
        // same device, read now: it may have been replaced while the secrets were on their way.
        const client =
          accountId === who.user_id ? this.clients.clientFor(accountId) : null;
        const confirmed =
          client?.getUserId() === who.user_id &&
          client.getDeviceId() === who.device_id;
        const verified =
          secrets && client && confirmed
            ? await run.step(importLinkedSecrets(client, secrets))
            : false;
        run.finish({ kind: 'done', verified });
      });
      return () => run.teardown();
    });
  }

  answerQrSignIn(
    flowId: string,
    answer: QrSignInAnswer,
  ): Observable<EngineResult<null>> {
    return answer.kind === 'retry-grant'
      ? this.answer(flowId, 'grant', answer.clientId)
      : this.answer(flowId, 'server', undefined);
  }

  continueQrSignIn(
    flowId: string,
    accountId: string,
  ): Observable<EngineResult<null>> {
    return this.answer(flowId, 'established', accountId);
  }

  linkDeviceWithQr(accountId: string, qr: string): Observable<QrLinkUpdate> {
    return new Observable<QrLinkUpdate>((subscriber) => {
      const run = this.track(new FlowRun(subscriber));
      run.closesSession = false;
      run.start(async () => {
        run.emit({ kind: 'connecting' });
        const client = this.clients.clientFor(accountId);
        if (!client) throw new Error('The account is not signed in.');
        const flow = await this.factory.existingDevice(
          client,
          qr,
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
        // Security: nothing beyond the protocol offer leaves this device until the user
        // confirms that both devices show the same check code. A mismatch may mean a
        // man-in-the-middle holds the channel, so it ends the link before any secret is sent.
        const { match, identityHeld } = await run.pause('check-code', {
          kind: 'confirm-check-code',
          flowId: run.id,
          code: required(flow.checkCode),
        });
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
        if (!identityHeld) {
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
      return () => run.teardown();
    });
  }

  confirmQrLink(
    flowId: string,
    answer: QrLinkAnswer,
  ): Observable<EngineResult<null>> {
    return this.answer(flowId, 'check-code', answer);
  }

  private track<S extends { kind: string }>(run: FlowRun<S>): FlowRun<S> {
    this.runs.set(run.id, run);
    run.onTeardown = () => this.runs.delete(run.id);
    return run;
  }

  private answer<K extends keyof Answers>(
    flowId: string,
    pause: K,
    value: Answers[K],
  ): Observable<EngineResult<null>> {
    return defer(() =>
      of(
        this.runs.get(flowId)?.answer(pause, value)
          ? engineOk(null)
          : QR_FLOW_GONE,
      ),
    );
  }
}

/**
 * One subscription's flow. It reports only the first failure, stops at the next step once
 * ended, and on teardown tells the other device unless the flow finished or the channel
 * already ended.
 */
class FlowRun<S extends { kind: string }> {
  readonly id = crypto.randomUUID();
  private flow?: QrRendezvousFlow;
  private ended = false;
  private finished = false;
  private channelEnded = false;
  private released = false;
  private waiting?: { pause: string; resolve: (value: never) => void };

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
  onTeardown?: () => void;

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

  /** Emits `state` and resolves with the first answer to `pause`; other answers are refused. */
  pause<K extends keyof Answers>(pause: K, state: S): Promise<Answers[K]> {
    const answer = new Promise<Answers[K]>(
      (resolve) => (this.waiting = { pause, resolve }),
    );
    this.emit(state);
    return this.step(answer);
  }

  answer<K extends keyof Answers>(pause: K, value: Answers[K]): boolean {
    const waiting = this.waiting;
    if (this.ended || waiting?.pause !== pause) return false;
    this.waiting = undefined;
    (waiting.resolve as (value: Answers[K]) => void)(value);
    return true;
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
    this.waiting = undefined;
    this.onTeardown?.();
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

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
