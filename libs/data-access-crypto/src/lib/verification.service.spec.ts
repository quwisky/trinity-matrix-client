import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api';
import { VerificationService } from './verification.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

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
  return {
    ...e,
    verify: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    showSas(sas: ReturnType<typeof fakeSas>) {
      e.emit(VerifierEvent.ShowSas, sas);
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
  } = {},
) {
  const e = emitter();
  let verifier: ReturnType<typeof fakeVerifier> | null = null;
  const req = {
    ...e,
    phase: opts.phase ?? VerificationPhase.Requested,
    initiatedByMe: opts.initiatedByMe ?? false,
    isSelfVerification: true,
    otherUserId: '@me:hs',
    otherDeviceId: opts.otherDeviceId ?? 'OTHER',
    cancellationCode: opts.cancellationCode ?? null,
    accept: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    startVerification: vi.fn(),
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

function setup(opts: { inProgress?: ReturnType<typeof fakeRequest> } = {}) {
  const crypto = {
    requestOwnUserVerification: vi.fn(),
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
        activeUserId: signal<string | null>(null).asReadonly(),
      }),
    ],
  });
  return { svc: TestBed.inject(VerificationService), crypto, client };
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

  it('confirms the SAS via the verifier callbacks', async () => {
    const { svc, client } = setup();
    svc.connect();
    const req = fakeRequest({ phase: VerificationPhase.Started });
    const verifier = fakeVerifier();
    req.attachVerifier(verifier);
    client.emit(CryptoEvent.VerificationRequestReceived, req);

    const sas = fakeSas();
    verifier.showSas(sas);
    await firstValueFrom(svc.confirmSas());

    expect(sas.confirm).toHaveBeenCalledOnce();
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
});
