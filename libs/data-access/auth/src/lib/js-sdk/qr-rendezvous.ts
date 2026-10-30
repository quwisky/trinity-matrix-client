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
  preloadCryptoWasm,
} from '@trinity/data-access/matrix-client';
import {
  engineFail,
  engineOk,
  verifiedEndpoints,
  type EngineResult,
} from '@trinity/util/matrix';
import { Observable, defer, firstValueFrom, of, type Subscriber } from 'rxjs';
import type {
  QrLinkUpdate,
  QrSignInAnswer,
  QrSignInUpdate,
} from '../auth-engine';
import type { AuthMetadata } from '../auth-metadata';
import { revokeToken } from '../oauth-http';
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
  code: string;
  approve: null;
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
        // The server the other device reports is not checked: TypeScript checks the account
        // itself once `done` hands the session over.
        await run.step(flow.negotiateProtocols());
        const typed = await run.pause('code', {
          kind: 'enter-check-code',
          flowId: run.id,
        });
        // Security: no grant is asked for until the person types the code the other device
        // shows. A wrong code may mean someone else holds the channel, so it ends the flow.
        if (!sameCheckCode(typed, required(flow.checkCode))) {
          await flow
            .cancel(ClientRendezvousFailureReason.InsecureChannelDetected)
            .catch(() => undefined);
          run.fail(ClientRendezvousFailureReason.InsecureChannelDetected, true);
          return;
        }
        const deviceId = newDeviceId();
        // Only the fields the SDK reads; TypeScript verified the endpoints.
        const metadata = request.grantMetadata as ValidatedAuthMetadata;
        const { clientId } = request;
        let userCode: string | undefined;
        try {
          ({ userCode } = await run.step(
            flow.deviceAuthorizationGrant({ metadata, clientId, deviceId }),
          ));
        } catch (error: unknown) {
          if (!isClientRejection(error)) throw error;
          run.finish({ kind: 'client-rejected' });
          return;
        }
        run.emit({
          kind: 'waiting-for-approval',
          userCode: required(userCode),
        });
        const tokens = required(
          await flow.completeLoginOnNewDevice({ clientId }),
        );
        const issuedAt = Date.now();
        // Security: until `done` hands the session over, ending the flow revokes them.
        run.discardUnlessDelivered(() =>
          revokeGrant(request.grantMetadata, clientId, tokens),
        );
        run.emit({ kind: 'signing-in' });
        const who = await run.step(
          createClient({
            baseUrl,
            accessToken: tokens.access_token,
          }).whoami(),
        );
        if (!who.device_id) {
          throw new Error('The provider returned no device for this session.');
        }
        const done = {
          kind: 'done',
          session: {
            homeserverUrl: baseUrl,
            userId: who.user_id,
            deviceId: who.device_id,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            accessTokenExpiresAt:
              tokens.expires_in === undefined
                ? null
                : issuedAt + tokens.expires_in * 1000,
          },
        } as const;
        // The session exists, so a failed secrets stage still hands it over, unverified.
        run.failAs = done;
        // whoami created the device, which the existing device waits for before it sends.
        const { secrets } = await run.step(flow.shareSecrets());
        // Security: held for this user and device only; the start of that session takes them.
        if (secrets) {
          this.clients.holdLinkedSecrets(who.user_id, who.device_id, secrets);
        }
        run.finish(done);
      });
      return () => run.teardown();
    });
  }

  answerQrSignIn(
    flowId: string,
    answer: QrSignInAnswer,
  ): Observable<EngineResult<null>> {
    return this.answer(flowId, 'code', answer.checkCode);
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
        run.emit({ kind: 'check-code', code: required(flow.checkCode) });
        // Receives the new device's grant request; it sends only refusals.
        const { verificationUri } = await run.step(
          flow.deviceAuthorizationGrant(),
        );
        // Security: nothing beyond the protocol offer leaves this device until TypeScript has
        // checked the approval link and the identity and the person has continued.
        await run.pause('approve', {
          kind: 'approve',
          flowId: run.id,
          verificationUri: required(verificationUri),
        });
        // From here a cancel must reach the session at once: shareSecrets sends the secrets
        // unless the session is already cancelled, and a decline PUT first could let them out.
        run.declineOnCancel = false;
        run.emit({ kind: 'sharing-secrets' });
        await run.step(flow.shareSecrets());
        run.finish({ kind: 'done' });
      });
      return () => run.teardown();
    });
  }

  confirmQrLink(flowId: string): Observable<EngineResult<null>> {
    return this.answer(flowId, 'approve', null);
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
  private discard?: () => void;

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

  /** Runs `discard` if the flow ends without delivering its outcome, or now if it has ended. */
  discardUnlessDelivered(discard: () => void): void {
    if (this.ended) {
      discard();
      throw STOPPED;
    }
    this.discard = discard;
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
    this.discard = undefined;
    this.emit(state);
    this.subscriber.complete();
  }

  fail(error: unknown, channelEnded = false): void {
    if (this.ended) return;
    this.channelEnded = channelEnded || error instanceof RendezvousError;
    if (this.failAs) {
      this.discard = undefined;
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
    this.discard?.();
    this.discard = undefined;
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

/** Whether the two digits typed are the check code shown, which may lack its leading zero. */
function sameCheckCode(typed: unknown, shown: string): boolean {
  return (
    typeof typed === 'string' &&
    /^\d{2}$/.test(typed) &&
    /^\d{1,2}$/.test(shown) &&
    Number(typed) === Number(shown)
  );
}

/** Revokes a grant's tokens at the revocation endpoint the issuer confirms. Best effort. */
function revokeGrant(
  metadata: AuthMetadata,
  clientId: string,
  tokens: { access_token: string; refresh_token?: string },
): void {
  void verifiedEndpoints(metadata)
    .then(({ revocationEndpoint }) => {
      if (!revocationEndpoint) return;
      return Promise.all([
        revokeToken(
          revocationEndpoint,
          clientId,
          tokens.access_token,
          'access_token',
        ),
        tokens.refresh_token &&
          revokeToken(
            revocationEndpoint,
            clientId,
            tokens.refresh_token,
            'refresh_token',
          ),
      ]);
    })
    .catch(() => undefined);
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
