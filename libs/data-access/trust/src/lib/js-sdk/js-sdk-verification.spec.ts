import { TestBed } from '@angular/core/testing';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api';
import { firstValueFrom, type Subscription } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { assertPlainData } from '@trinity/util/matrix';
import { fakeEmitter } from '@trinity/testing';
import type { VerificationSnapshot } from '../trust-engine';
import { JsSdkTrustEngine } from './js-sdk-trust-engine';

const ME = '@me:hs';

function fakeSas() {
  return {
    sas: {
      emoji: [
        ['🐶', 'Dog'],
        ['🐱', 'Cat'],
      ] as [string, string][],
    },
    confirm: vi.fn().mockResolvedValue(undefined),
    mismatch: vi.fn(),
    cancel: vi.fn(),
  };
}

function fakeVerifier() {
  const e = fakeEmitter();
  return {
    ...e,
    verify: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    getShowSasCallbacks: () => null,
    getReciprocateQrCodeCallbacks: () => null,
  };
}

let flows = 0;

function fakeRequest(
  opts: {
    phase?: VerificationPhase;
    otherDeviceId?: string;
    isSelfVerification?: boolean;
    supportedMethods?: string[];
  } = {},
) {
  const e = fakeEmitter();
  let verifier: ReturnType<typeof fakeVerifier> | null = null;
  const req = {
    ...e,
    transactionId: `txn-${++flows}`,
    phase: opts.phase ?? VerificationPhase.Requested,
    initiatedByMe: false,
    isSelfVerification: opts.isSelfVerification ?? true,
    otherUserId: ME,
    otherDeviceId: opts.otherDeviceId ?? 'OTHER',
    cancellationCode: null as string | null,
    accept: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    startVerification: vi.fn(),
    generateQRCode: vi.fn(),
    scanQRCode: vi.fn(),
    otherPartySupportsMethod: vi.fn((method: string) =>
      (opts.supportedMethods ?? []).includes(method),
    ),
    get verifier() {
      return verifier;
    },
    attachVerifier(v: ReturnType<typeof fakeVerifier>) {
      verifier = v;
    },
    setPhase(p: VerificationPhase) {
      req.phase = p;
      e.emit(VerificationRequestEvent.Change);
    },
  };
  return req;
}

type FakeRequest = ReturnType<typeof fakeRequest>;

let subscriptions: Subscription[] = [];

afterEach(() => {
  for (const subscription of subscriptions) subscription.unsubscribe();
  subscriptions = [];
  TestBed.resetTestingModule();
});

function setup({ inProgress }: { inProgress?: FakeRequest } = {}) {
  const crypto = {
    userHasCrossSigningKeys: vi.fn().mockResolvedValue(true),
    requestOwnUserVerification: vi.fn(),
    requestVerificationDM: vi.fn(),
    getVerificationRequestsToDeviceInProgress: vi.fn(() =>
      inProgress ? [inProgress] : [],
    ),
  };
  const client = {
    ...fakeEmitter(),
    getCrypto: () => crypto,
    getUserId: () => ME,
  };
  const clients = { current: client as object | null };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (id: string) => (id === ME ? clients.current : null),
        },
      },
    ],
  });
  const engine = TestBed.inject(JsSdkTrustEngine);
  const snapshots: (VerificationSnapshot | null)[] = [];
  const watch = () => {
    subscriptions.push(
      engine.verification(ME).subscribe((snapshot) => {
        assertPlainData(snapshot);
        snapshots.push(snapshot);
      }),
    );
  };
  const latest = () => snapshots.at(-1) ?? null;
  const receive = (request: FakeRequest) =>
    client.emit(CryptoEvent.VerificationRequestReceived, request);
  return { engine, crypto, client, clients, watch, latest, receive };
}

describe('JsSdkTrustEngine verification', () => {
  it('takes up a to-device request already in progress on subscribe', () => {
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    const { watch, latest } = setup({ inProgress: request });

    watch();

    expect(latest()).toMatchObject({
      flowId: request.transactionId,
      phase: 'ready',
      initiatedByMe: false,
    });
  });

  it('ignores a new incoming request while one is live, and takes one after it ends', () => {
    const { watch, latest, receive } = setup();
    watch();
    const first = fakeRequest({ otherDeviceId: 'A' });

    receive(first);
    receive(fakeRequest({ otherDeviceId: 'B' }));
    expect(latest()?.otherDeviceId).toBe('A');

    first.setPhase(VerificationPhase.Cancelled);
    receive(fakeRequest({ otherDeviceId: 'C' }));
    expect(latest()?.otherDeviceId).toBe('C');
  });

  it('forgets the request when the last subscriber leaves, without cancelling it', async () => {
    const { engine, crypto, watch, latest } = setup();
    const request = fakeRequest({ isSelfVerification: false });
    crypto.requestVerificationDM.mockResolvedValue(request);
    watch();
    await firstValueFrom(engine.requestUserVerification(ME, '@bob:hs', '!dm'));
    expect(latest()?.flowId).toBe(request.transactionId);

    for (const subscription of subscriptions) subscription.unsubscribe();
    watch();

    expect(latest()).toBeNull();
    expect(request.cancel).not.toHaveBeenCalled();
    request.setPhase(VerificationPhase.Cancelled);
    expect(latest()).toBeNull();
  });

  it('takes up a to-device request still in progress when subscribed again', () => {
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    const { watch, latest } = setup({ inProgress: request });
    watch();
    for (const subscription of subscriptions) subscription.unsubscribe();

    watch();

    expect(latest()?.flowId).toBe(request.transactionId);
  });

  it('keeps the request while another subscriber remains', () => {
    const { engine, watch, latest, receive } = setup();
    watch();
    const other = engine.verification(ME).subscribe();
    const request = fakeRequest();
    receive(request);

    other.unsubscribe();

    expect(latest()?.flowId).toBe(request.transactionId);
  });

  it('stops listening for requests on unsubscribe', () => {
    const { engine, client } = setup();
    const subscription = engine.verification(ME).subscribe();

    subscription.unsubscribe();

    expect(client.listenerCount(CryptoEvent.VerificationRequestReceived)).toBe(
      0,
    );
  });

  it('emits null for an account that is not live', async () => {
    const { engine } = setup();

    expect(await firstValueFrom(engine.verification('@nobody:hs'))).toBeNull();
  });

  it('reports the methods the other side supports', () => {
    const { watch, latest, receive } = setup();
    watch();

    receive(
      fakeRequest({
        phase: VerificationPhase.Ready,
        supportedMethods: ['m.sas.v1', 'm.qr_code.show.v1'],
      }),
    );

    expect(latest()?.theirMethods).toEqual(['m.sas.v1', 'm.qr_code.show.v1']);
  });

  it('starts SAS, drives the verifier and publishes the emoji', async () => {
    const { engine, watch, latest, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    receive(request);
    const verifier = fakeVerifier();
    request.startVerification.mockResolvedValue(verifier);

    expect(
      await firstValueFrom(engine.startSas(ME, request.transactionId)),
    ).toEqual({
      ok: true,
      value: null,
    });
    request.setPhase(VerificationPhase.Started);

    expect(request.startVerification).toHaveBeenCalledWith('m.sas.v1');
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(latest()).toMatchObject({ phase: 'started', sas: null });

    const sas = fakeSas();
    verifier.emit(VerifierEvent.ShowSas, sas);
    expect(latest()?.sas).toEqual({
      emoji: [
        { glyph: '🐶', name: 'Dog' },
        { glyph: '🐱', name: 'Cat' },
      ],
    });

    await firstValueFrom(engine.confirmSas(ME, request.transactionId));
    expect(sas.confirm).toHaveBeenCalledOnce();
    await firstValueFrom(engine.mismatchSas(ME, request.transactionId));
    expect(sas.mismatch).toHaveBeenCalledOnce();
  });

  it('attaches to a verifier the other device started', () => {
    const { watch, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    receive(request);
    const verifier = fakeVerifier();

    request.attachVerifier(verifier);
    request.setPhase(VerificationPhase.Started);

    expect(verifier.verify).toHaveBeenCalledOnce();
  });

  it('returns the QR payload as base64 once and never publishes it', async () => {
    const { engine, watch, latest, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    receive(request);
    request.generateQRCode.mockResolvedValue(
      new Uint8ClampedArray([0, 255, 7, 128]),
    );

    expect(
      await firstValueFrom(engine.showQr(ME, request.transactionId)),
    ).toEqual({
      ok: true,
      value: { qr: 'AP8HgA==' },
    });
    expect(JSON.stringify(latest())).not.toContain('AP8HgA==');
  });

  it('reports an empty QR payload as qr-unavailable', async () => {
    const { engine, watch, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    receive(request);
    request.generateQRCode.mockResolvedValue(undefined);

    expect(
      await firstValueFrom(engine.showQr(ME, request.transactionId)),
    ).toMatchObject({ ok: false, failure: { code: 'qr-unavailable' } });
  });

  it('does not return a QR payload generated after the request has started', async () => {
    const { engine, watch, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    receive(request);
    let resolveQr!: (payload: Uint8ClampedArray) => void;
    request.generateQRCode.mockReturnValue(
      new Promise((resolve) => (resolveQr = resolve)),
    );

    const shown = firstValueFrom(engine.showQr(ME, request.transactionId));
    request.attachVerifier(fakeVerifier());
    request.setPhase(VerificationPhase.Started);
    resolveQr(new Uint8ClampedArray([1, 2, 3]));

    expect(await shown).toMatchObject({
      ok: false,
      failure: { code: 'verification-gone' },
    });
  });

  it('passes scanned bytes to the SDK unchanged and drives its verifier', async () => {
    const { engine, watch, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Ready });
    receive(request);
    const verifier = fakeVerifier();
    request.scanQRCode.mockResolvedValue(verifier);

    await firstValueFrom(engine.scanQr(ME, request.transactionId, 'AP8HgA=='));

    expect(request.scanQRCode).toHaveBeenCalledWith(
      new Uint8ClampedArray([0, 255, 7, 128]),
    );
    expect(verifier.verify).toHaveBeenCalledOnce();
  });

  it('cancels a late QR verifier instead of attaching it to a replacement request', async () => {
    const { engine, watch, latest, receive } = setup();
    watch();
    const old = fakeRequest({ phase: VerificationPhase.Ready });
    receive(old);
    let resolveScan!: (verifier: ReturnType<typeof fakeVerifier>) => void;
    old.scanQRCode.mockReturnValue(
      new Promise((resolve) => (resolveScan = resolve)),
    );
    const scan = firstValueFrom(
      engine.scanQr(ME, old.transactionId, 'AP8HgA=='),
    );

    old.setPhase(VerificationPhase.Cancelled);
    receive(
      fakeRequest({
        phase: VerificationPhase.Ready,
        otherDeviceId: 'REPLACEMENT',
      }),
    );
    const stale = fakeVerifier();
    resolveScan(stale);

    // Silent, as before the engine: the scan reports success and nothing is taken up.
    expect(await scan).toEqual({ ok: true, value: null });
    expect(stale.cancel).toHaveBeenCalledOnce();
    expect(stale.verify).not.toHaveBeenCalled();
    expect(latest()).toMatchObject({
      phase: 'ready',
      otherDeviceId: 'REPLACEMENT',
    });
  });

  it('asks before reciprocating a scan and confirms through the SDK callback', async () => {
    const { engine, watch, latest, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    request.attachVerifier(verifier);
    receive(request);
    const qr = { confirm: vi.fn(), cancel: vi.fn() };

    verifier.emit(VerifierEvent.ShowReciprocateQr, qr);
    expect(latest()?.qrScannedByOther).toBe(true);

    await firstValueFrom(engine.confirmQr(ME, request.transactionId));
    expect(qr.confirm).toHaveBeenCalledOnce();
    expect(latest()?.qrScannedByOther).toBe(false);
    expect(
      await firstValueFrom(engine.confirmQr(ME, request.transactionId)),
    ).toMatchObject({ ok: false, failure: { code: 'verification-gone' } });
  });

  it('cancels the verifier with an Error, then the request', async () => {
    const { engine, watch, receive } = setup();
    watch();
    const request = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    request.attachVerifier(verifier);
    receive(request);

    await firstValueFrom(engine.cancelVerification(ME, request.transactionId));

    expect(verifier.cancel).toHaveBeenCalledWith(expect.any(Error));
    expect(request.cancel).toHaveBeenCalledOnce();
  });

  it('publishes a protocol timeout as its cancellation code', () => {
    const { watch, latest, receive } = setup();
    watch();
    const request = fakeRequest();
    receive(request);

    request.cancellationCode = 'm.timeout';
    request.setPhase(VerificationPhase.Cancelled);

    expect(latest()).toMatchObject({
      phase: 'cancelled',
      cancellation: { code: 'm.timeout' },
    });
  });

  it('refuses a command for a flow that is not the current one', async () => {
    const { engine, watch, receive } = setup();
    watch();
    const request = fakeRequest();
    receive(request);

    expect(
      await firstValueFrom(engine.acceptVerification(ME, 'other')),
    ).toMatchObject({
      ok: false,
      failure: { code: 'verification-gone' },
    });
    expect(request.accept).not.toHaveBeenCalled();
  });

  it('takes up its own request so the snapshot shows it', async () => {
    const { engine, crypto, watch, latest } = setup();
    watch();
    const request = fakeRequest();
    crypto.requestOwnUserVerification.mockResolvedValue(request);

    expect(await firstValueFrom(engine.requestOwnVerification(ME))).toEqual({
      ok: true,
      value: { flowId: request.transactionId },
    });
    expect(latest()?.flowId).toBe(request.transactionId);
  });

  describe('a DM verification request', () => {
    it('waits for the user identity before sending', async () => {
      const { engine, crypto, client, watch, latest } = setup();
      watch();
      let known = false;
      crypto.userHasCrossSigningKeys.mockImplementation(async () => known);
      const request = fakeRequest({ isSelfVerification: false });
      crypto.requestVerificationDM.mockResolvedValue(request);
      const sent = firstValueFrom(
        engine.requestUserVerification(ME, '@bob:hs', '!dm'),
      );
      await Promise.resolve();
      expect(crypto.requestVerificationDM).not.toHaveBeenCalled();

      known = true;
      client.emit(CryptoEvent.UserTrustStatusChanged, '@bob:hs', {});

      await vi.waitFor(
        () =>
          expect(crypto.requestVerificationDM).toHaveBeenCalledWith(
            '@bob:hs',
            '!dm',
          ),
        { timeout: 500 },
      );
      expect(await sent).toEqual({
        ok: true,
        value: { flowId: request.transactionId },
      });
      expect(crypto.requestVerificationDM).toHaveBeenCalledWith(
        '@bob:hs',
        '!dm',
      );
      expect(latest()?.flowId).toBe(request.transactionId);
    });

    it('reports a failed identity lookup as a failure value', async () => {
      const { engine, crypto } = setup();
      crypto.userHasCrossSigningKeys.mockRejectedValue(new Error('store'));

      expect(
        await firstValueFrom(
          engine.requestUserVerification(ME, '@bob:hs', '!dm'),
        ),
      ).toMatchObject({ ok: false, failure: { code: 'request-failed' } });
      expect(crypto.requestVerificationDM).not.toHaveBeenCalled();
    });

    it('does not send after the client is replaced during identity lookup', async () => {
      const { engine, crypto, clients } = setup();
      let ready!: (known: boolean) => void;
      crypto.userHasCrossSigningKeys.mockReturnValue(
        new Promise<boolean>((resolve) => (ready = resolve)),
      );
      const sent = firstValueFrom(
        engine.requestUserVerification(ME, '@bob:hs', '!dm'),
      );

      clients.current = { replaced: true };
      ready(true);

      expect(await sent).toMatchObject({
        ok: false,
        failure: { code: 'account-not-live' },
      });
      expect(crypto.requestVerificationDM).not.toHaveBeenCalled();
    });

    it.each(['unsubscribe', 'client replacement'])(
      'cancels a request that arrives after %s, without taking it up',
      async (transition) => {
        const { engine, crypto, clients, watch, latest } = setup();
        watch();
        const request = fakeRequest();
        let send!: (request: FakeRequest) => void;
        crypto.requestVerificationDM.mockReturnValue(
          new Promise((resolve) => (send = resolve)),
        );
        const results: unknown[] = [];
        const attempt = engine
          .requestUserVerification(ME, '@bob:hs', '!dm')
          .subscribe((result) => results.push(result));
        await vi.waitFor(() =>
          expect(crypto.requestVerificationDM).toHaveBeenCalled(),
        );

        if (transition === 'unsubscribe') attempt.unsubscribe();
        else clients.current = { replaced: true };
        send(request);

        await vi.waitFor(() => expect(request.cancel).toHaveBeenCalledOnce());
        expect(latest()).toBeNull();
        if (transition === 'client replacement') {
          expect(results).toEqual([
            expect.objectContaining({
              ok: false,
              failure: expect.objectContaining({ code: 'account-not-live' }),
            }),
          ]);
        }
        attempt.unsubscribe();
      },
    );
  });
});
