import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api';
import { VerificationService } from './verification.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

// Minimal event emitter shaped like matrix-js-sdk's TypedEventEmitter.
function emitter() {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    on(evt: string, h: (...a: unknown[]) => void) {
      (handlers.get(evt) ?? handlers.set(evt, new Set()).get(evt)!).add(h);
    },
    off(evt: string, h: (...a: unknown[]) => void) {
      handlers.get(evt)?.delete(h);
    },
    emit(evt: string, ...args: unknown[]) {
      handlers.get(evt)?.forEach((h) => h(...args));
    },
  };
}

function fakeSas(
  emoji: [string, string][] = [
    ['🐶', 'Dog'],
    ['🐱', 'Cat'],
    ['🦁', 'Lion'],
    ['🐎', 'Horse'],
    ['🦄', 'Unicorn'],
    ['🐷', 'Pig'],
    ['🐘', 'Elephant'],
  ],
) {
  return {
    sas: { emoji },
    confirm: vi.fn().mockResolvedValue(undefined),
    mismatch: vi.fn(),
    cancel: vi.fn(),
  };
}

function fakeVerifier() {
  const e = emitter();
  let currentSas: ReturnType<typeof fakeSas> | null = null;
  let currentQr: {
    confirm: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  } | null = null;
  return {
    ...e,
    verify: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    getShowSasCallbacks: () => currentSas,
    getReciprocateQrCodeCallbacks: () => currentQr,
    showSas(sas: ReturnType<typeof fakeSas>) {
      currentSas = sas;
      e.emit(VerifierEvent.ShowSas, sas);
    },
    showReciprocateQr(qr: NonNullable<typeof currentQr>) {
      currentQr = qr;
      e.emit(VerifierEvent.ShowReciprocateQr, qr);
    },
    fireCancel() {
      e.emit(VerifierEvent.Cancel, new Error('x'));
    },
  };
}

function fakeRequest(
  opts: {
    phase?: VerificationPhase;
    initiatedByMe?: boolean;
    otherDeviceId?: string;
    cancellationCode?: string | null;
    otherUserId?: string;
    isSelfVerification?: boolean;
    supportedMethods?: string[];
  } = {},
) {
  const e = emitter();
  let verifier: ReturnType<typeof fakeVerifier> | null = null;
  const req = {
    ...e,
    phase: opts.phase ?? VerificationPhase.Requested,
    initiatedByMe: opts.initiatedByMe ?? false,
    isSelfVerification: opts.isSelfVerification ?? true,
    otherUserId: opts.otherUserId ?? '@me:hs',
    otherDeviceId: opts.otherDeviceId ?? 'OTHER',
    cancellationCode: opts.cancellationCode ?? null,
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

const activeUserId = signal<string | null>(null);

function setup(opts: { inProgress?: ReturnType<typeof fakeRequest> } = {}) {
  const crypto = {
    requestOwnUserVerification: vi.fn(),
    requestVerificationDM: vi.fn(),
    getVerificationRequestsToDeviceInProgress: vi.fn(() =>
      opts.inProgress ? [opts.inProgress] : [],
    ),
  };
  const client = {
    ...emitter(),
    getCrypto: () => crypto,
    getUserId: () => '@me:hs',
  };

  // The MatrixClient itself is a matrix-js-sdk object we must never build for real,
  // so we keep the hand-rolled emitter fake above and expose it through a ng-mocks
  // mock of MatrixClientService (its `isInitialized`/`instance` getters overridden).
  TestBed.configureTestingModule({
    providers: [
      VerificationService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as unknown as MatrixClient,
        // Writable so a test can drive an account switch; the projection re-wires off it.
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  return { svc: TestBed.inject(VerificationService), crypto, client, matrix };
}

describe('VerificationService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('adopts an in-progress request on connect', () => {
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      initiatedByMe: true,
    });
    const { svc } = setup({ inProgress: req });

    svc.connect();

    expect(svc.active()?.stage).toBe('ready');
    expect(svc.active()?.incoming).toBe(false);
  });

  it('surfaces an incoming verification request', () => {
    const { svc, client } = setup();
    svc.connect();

    client.emit(
      CryptoEvent.VerificationRequestReceived,
      fakeRequest({ otherDeviceId: 'PHONE' }),
    );

    expect(svc.active()).toMatchObject({
      stage: 'requested',
      incoming: true,
      otherDeviceId: 'PHONE',
    });
  });

  it('ignores a new incoming request while one is active', () => {
    const { svc, client } = setup();
    svc.connect();

    client.emit(
      CryptoEvent.VerificationRequestReceived,
      fakeRequest({ otherDeviceId: 'A' }),
    );
    client.emit(
      CryptoEvent.VerificationRequestReceived,
      fakeRequest({ otherDeviceId: 'B' }),
    );

    expect(svc.active()?.otherDeviceId).toBe('A'); // first one kept
  });

  it('starts a cross-user verification over a DM and adopts it', async () => {
    const { svc, crypto } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Requested,
      initiatedByMe: true,
      otherUserId: '@bob:hs',
      isSelfVerification: false,
    });
    crypto.requestVerificationDM.mockResolvedValue(req);

    await firstValueFrom(svc.startUserVerification('@bob:hs', '!dm:hs'));

    expect(crypto.requestVerificationDM).toHaveBeenCalledWith(
      '@bob:hs',
      '!dm:hs',
    );
    expect(svc.active()?.otherUserId).toBe('@bob:hs');
    expect(svc.active()?.isSelfVerification).toBe(false);
  });

  it('clears an active verification on disconnect even if connect never ran', async () => {
    // A verification can be started without connect(): startSelfVerification adopts the
    // request directly. The projection's reset only runs when listeners were attached,
    // so disconnect() has to clear unconditionally or the host keeps presenting a dead
    // request.
    const { svc, crypto } = setup();
    const req = fakeRequest({
      phase: VerificationPhase.Requested,
      initiatedByMe: true,
    });
    crypto.requestOwnUserVerification.mockResolvedValue(req);
    await firstValueFrom(svc.startSelfVerification());
    expect(svc.active()).not.toBeNull();

    svc.disconnect();

    expect(svc.active()).toBeNull();
  });

  it('drives the SAS flow: start → waiting → emoji shown', async () => {
    const { svc, crypto } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      initiatedByMe: true,
    });
    crypto.requestOwnUserVerification.mockResolvedValue(req);

    await firstValueFrom(svc.startSelfVerification());
    expect(svc.active()?.stage).toBe('ready');

    const verifier = fakeVerifier();
    req.startVerification.mockResolvedValue(verifier);
    await firstValueFrom(svc.startSas());
    req.setPhase(VerificationPhase.Started);

    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(svc.active()?.stage).toBe('waiting'); // started, no emoji yet

    verifier.showSas(fakeSas());
    expect(svc.active()?.stage).toBe('sas-shown');
    expect(svc.active()?.emoji).toHaveLength(7);
    expect(svc.active()?.emoji?.[0]).toEqual({ glyph: '🐶', name: 'Dog' });
  });

  it('offers QR directions only for self-verification methods the other device supports', () => {
    const { svc, client } = setup();
    svc.connect();
    client.emit(
      CryptoEvent.VerificationRequestReceived,
      fakeRequest({
        phase: VerificationPhase.Ready,
        supportedMethods: ['m.qr_code.scan.v1', 'm.qr_code.show.v1'],
      }),
    );

    expect(svc.active()).toMatchObject({
      qrShowAvailable: true,
      qrScanAvailable: true,
    });

    const crossUser = fakeRequest({
      phase: VerificationPhase.Ready,
      isSelfVerification: false,
      supportedMethods: ['m.qr_code.scan.v1', 'm.qr_code.show.v1'],
    });
    svc.dismiss();
    client.emit(CryptoEvent.VerificationRequestReceived, crossUser);

    expect(svc.active()).toMatchObject({
      qrShowAvailable: false,
      qrScanAvailable: false,
    });
  });

  it('does not expose QR bytes until the user explicitly asks to show them', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      supportedMethods: ['m.qr_code.scan.v1'],
    });
    const payload = new Uint8ClampedArray([0, 255, 7, 128]);
    req.generateQRCode.mockResolvedValue(payload);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    expect(svc.active()?.qrCodeData).toBeNull();
    await firstValueFrom(svc.showQr());

    expect(svc.active()?.stage).toBe('qr-shown');
    expect(svc.active()?.qrCodeData).toEqual(payload);
  });

  it('drops the sensitive QR payload once a verification method starts', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      supportedMethods: ['m.qr_code.scan.v1'],
    });
    req.generateQRCode.mockResolvedValue(new Uint8ClampedArray([1, 2, 3]));
    client.emit(CryptoEvent.VerificationRequestReceived, req);
    await firstValueFrom(svc.showQr());

    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    req.setPhase(VerificationPhase.Started);

    expect(svc.active()?.qrCodeData).toBeNull();
  });

  it('does not retain a QR payload generated after the request has started', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      supportedMethods: ['m.qr_code.scan.v1'],
    });
    let resolveQr!: (payload: Uint8ClampedArray) => void;
    req.generateQRCode.mockReturnValue(
      new Promise((resolve) => {
        resolveQr = resolve;
      }),
    );
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    const showQr = firstValueFrom(svc.showQr());
    req.attachVerifier(fakeVerifier());
    req.setPhase(VerificationPhase.Started);
    resolveQr(new Uint8ClampedArray([1, 2, 3]));
    await showQr;

    expect(svc.active()?.qrCodeData).toBeNull();
    expect(svc.active()?.stage).toBe('waiting');
  });

  it('drops the sensitive QR payload when the request is cancelled', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      supportedMethods: ['m.qr_code.scan.v1'],
    });
    req.generateQRCode.mockResolvedValue(new Uint8ClampedArray([1, 2, 3]));
    client.emit(CryptoEvent.VerificationRequestReceived, req);
    await firstValueFrom(svc.showQr());

    req.setPhase(VerificationPhase.Cancelled);

    expect(svc.active()?.qrCodeData).toBeNull();
    expect(svc.active()?.stage).toBe('cancelled');
  });

  it('keeps SAS available when QR generation has no usable payload', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      supportedMethods: ['m.qr_code.scan.v1'],
    });
    req.generateQRCode.mockResolvedValue(undefined);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    await expect(firstValueFrom(svc.showQr())).rejects.toThrow(
      /QR verification isn’t available/i,
    );
    expect(svc.active()?.stage).toBe('ready');
  });

  it('passes scanned bytes to the SDK unchanged and drives its verifier', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({
      phase: VerificationPhase.Ready,
      supportedMethods: ['m.qr_code.show.v1'],
    });
    const verifier = fakeVerifier();
    req.scanQRCode.mockResolvedValue(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);
    const payload = new Uint8ClampedArray([0, 255, 7, 128]);

    await firstValueFrom(svc.scanQr(payload));

    expect(req.scanQRCode).toHaveBeenCalledWith(payload);
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(svc.active()?.stage).toBe('waiting');
  });

  it('cancels a late QR verifier instead of attaching it to a replacement request', async () => {
    const { svc, client } = setup();
    svc.connect();
    const oldRequest = fakeRequest({
      phase: VerificationPhase.Ready,
      supportedMethods: ['m.qr_code.show.v1'],
    });
    let resolveScan!: (verifier: ReturnType<typeof fakeVerifier>) => void;
    oldRequest.scanQRCode.mockReturnValue(
      new Promise((resolve) => {
        resolveScan = resolve;
      }),
    );
    client.emit(CryptoEvent.VerificationRequestReceived, oldRequest);
    const scan = firstValueFrom(
      svc.scanQr(new Uint8ClampedArray([0, 255, 7, 128])),
    );

    oldRequest.setPhase(VerificationPhase.Cancelled);
    const replacement = fakeRequest({
      phase: VerificationPhase.Ready,
      otherDeviceId: 'REPLACEMENT',
    });
    client.emit(CryptoEvent.VerificationRequestReceived, replacement);
    const staleVerifier = fakeVerifier();
    resolveScan(staleVerifier);
    await scan;

    expect(staleVerifier.cancel).toHaveBeenCalledOnce();
    expect(staleVerifier.verify).not.toHaveBeenCalled();
    expect(svc.active()).toMatchObject({
      stage: 'ready',
      otherDeviceId: 'REPLACEMENT',
    });
  });

  it('asks before reciprocating a scan and confirms through the SDK callback', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);
    const qr = { confirm: vi.fn(), cancel: vi.fn() };

    verifier.showReciprocateQr(qr);
    expect(svc.active()?.stage).toBe('qr-confirm');

    await firstValueFrom(svc.confirmQr());
    expect(qr.confirm).toHaveBeenCalledOnce();
    expect(svc.active()?.stage).toBe('waiting');
  });

  it('confirms the SAS via the verifier callbacks', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    const sas = fakeSas();
    verifier.showSas(sas);
    expect(svc.active()?.sasConfirmed).toBe(false);
    await firstValueFrom(svc.confirmSas());

    expect(sas.confirm).toHaveBeenCalledOnce();
    // Our MAC is out but the other side hasn't answered, so the phase is still Started:
    // the flag is what lets the UI show the wait instead of asking again.
    expect(svc.active()?.stage).toBe('sas-shown');
    expect(svc.active()?.sasConfirmed).toBe(true);
  });

  // The spinner has to answer the click, not the round-trip: `confirm()` only resolves
  // once the MAC is queued, which on a slow link is exactly the gap we are covering.
  it('starts waiting as soon as the answer is given, not when it lands', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    const sas = fakeSas();
    let queueTheMac!: () => void;
    sas.confirm.mockReturnValue(
      new Promise<void>((resolve) => (queueTheMac = resolve)),
    );
    verifier.showSas(sas);

    const confirmed = firstValueFrom(svc.confirmSas());
    expect(svc.active()?.sasConfirmed).toBe(true);

    queueTheMac();
    await confirmed;
    expect(svc.active()?.sasConfirmed).toBe(true);
  });

  it('goes back to asking when the SAS is shown again', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    verifier.showSas(fakeSas());
    await firstValueFrom(svc.confirmSas());
    expect(svc.active()?.sasConfirmed).toBe(true);

    verifier.showSas(fakeSas());

    expect(svc.active()?.sasConfirmed).toBe(false);
  });

  // A stale wait carried into the next verification would show a spinner on a screen
  // that has not been answered yet — and hide the answer buttons with it.
  it('starts the next verification asking, not waiting', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    verifier.showSas(fakeSas());
    await firstValueFrom(svc.confirmSas());
    expect(svc.active()?.sasConfirmed).toBe(true);

    // The first one ends, so the next incoming request is adopted in its place.
    req.setPhase(VerificationPhase.Cancelled);
    client.emit(
      CryptoEvent.VerificationRequestReceived,
      fakeRequest({ phase: VerificationPhase.Requested }),
    );

    expect(svc.active()?.stage).toBe('requested');
    expect(svc.active()?.sasConfirmed).toBe(false);
  });

  it('drops back to asking when confirming the SAS fails', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    const sas = fakeSas();
    sas.confirm.mockRejectedValue(new Error('offline'));
    verifier.showSas(sas);

    await expect(firstValueFrom(svc.confirmSas())).rejects.toThrow(/offline/);
    expect(svc.active()?.sasConfirmed).toBe(false);
  });

  it('cancels with an Error and cancels the request', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    await firstValueFrom(svc.cancel());

    expect(verifier.cancel).toHaveBeenCalledWith(expect.any(Error));
    expect(req.cancel).toHaveBeenCalledOnce();
  });

  it('maps a mismatched-SAS cancellation to a friendly reason', () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ cancellationCode: 'm.mismatched_sas' });
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    req.setPhase(VerificationPhase.Cancelled);

    expect(svc.active()?.stage).toBe('cancelled');
    expect(svc.active()?.cancelReason).toMatch(/did not match/i);
  });

  it('reflects the done stage and dismiss() clears it', () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest();
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    req.setPhase(VerificationPhase.Done);
    expect(svc.active()?.stage).toBe('done');

    svc.dismiss();
    expect(svc.active()).toBeNull();
  });

  it('errors when an action runs with no verification in progress', async () => {
    const { svc } = setup();
    await expect(firstValueFrom(svc.accept())).rejects.toThrow(
      /no verification/i,
    );
  });

  it('rebinds the incoming-request listener onto the newly-active account on a switch', () => {
    // Asserted by behaviour rather than by spying on on/off: after the switch, a request
    // arriving on the OLD client must be ignored and one on the new client adopted.
    const { svc, client, matrix } = setup();
    activeUserId.set('@a:hs');
    svc.connect();
    TestBed.inject(ApplicationRef).tick(); // effect's first run: still A

    const clientB = {
      ...emitter(),
      getCrypto: () => ({
        getVerificationRequestsToDeviceInProgress: vi.fn(() => []),
      }),
      getUserId: () => '@b:hs',
    };
    ngMocks.stubMember(matrix, 'instance', clientB as unknown as MatrixClient);
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();

    client.emit(
      CryptoEvent.VerificationRequestReceived,
      fakeRequest({
        phase: VerificationPhase.Requested,
        otherUserId: '@old:hs',
      }),
    );
    expect(svc.active()).toBeNull(); // the old client no longer reaches us

    clientB.emit(
      CryptoEvent.VerificationRequestReceived,
      fakeRequest({
        phase: VerificationPhase.Requested,
        otherUserId: '@new:hs',
      }),
    );
    expect(svc.active()?.otherUserId).toBe('@new:hs');
  });
});
