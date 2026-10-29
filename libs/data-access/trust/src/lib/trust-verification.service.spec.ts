import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import {
  Observable,
  Subject,
  firstValueFrom,
  of,
  throwError,
  type Subscription,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { type EngineResult, engineFail } from '@trinity/util/matrix';
import { FakeTrustEngine } from '../contract/fake-trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import { TrustDevicesService, type DeviceInfo } from './trust-devices.service';
import { TrustHealthService } from './trust-health.service';
import { TrustVerificationService } from './trust-verification.service';

const BOB = '@bob:contract.invalid';

function sessionWith(
  active: string | null,
  accounts: readonly string[],
  generation = 1,
) {
  return {
    activeAccountId: active,
    accounts: accounts.map((accountId) => ({
      accountId,
      deviceId: 'DEVICE',
      generation,
      syncState: 'syncing' as const,
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
    softLoggedOut: [],
  } satisfies SessionSnapshot;
}

const failure = (code: 'verification-gone' | 'request-failed') =>
  engineFail({
    kind: 'unexpected',
    code,
    diagnostic: { kind: 'unexpected' },
  });

let lifetimes: Subscription[] = [];

afterEach(() => {
  for (const lifetime of lifetimes) lifetime.unsubscribe();
  lifetimes = [];
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

function setup(
  opts: {
    /** Whether THIS device is verified; `null` is the unknown/unavailable health state. */
    thisDeviceVerified?: boolean | null;
    /** What the device list answers with. */
    devices?: Observable<DeviceInfo[]>;
  } = {},
) {
  const engine = new FakeTrustEngine();
  const alice = engine.alice;
  engine.publishIdentity(alice);
  engine.addAccount(BOB);
  const session = signal(sessionWith(alice, [alice, BOB]));
  const thisDeviceVerified = signal<boolean | null>(
    opts.thisDeviceVerified ?? null,
  );
  const list = vi.fn(() => opts.devices ?? of<DeviceInfo[]>([]));
  TestBed.configureTestingModule({
    providers: [
      TrustVerificationService,
      { provide: TRUST_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
      MockProvider(TrustHealthService, { thisDeviceVerified }),
      MockProvider(TrustDevicesService, { list }),
    ],
  });
  const svc = TestBed.inject(TrustVerificationService);
  return { svc, engine, alice, session, thisDeviceVerified, list };
}

/** Lets a queued reconcile publish the engine's latest snapshot. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

async function run(svc: TrustVerificationService): Promise<Subscription> {
  const lifetime = svc.runProjection().subscribe();
  lifetimes.push(lifetime);
  await settle();
  return lifetime;
}

/** Alice's own request, taken to `phase` by the other device. */
async function outgoing(
  { svc, engine, alice }: ReturnType<typeof setup>,
  change: Parameters<FakeTrustEngine['updateVerification']>[1] = {},
) {
  await firstValueFrom(svc.startSelfVerification());
  engine.updateVerification(alice, change);
  await settle();
}

async function incoming(
  { engine, alice }: ReturnType<typeof setup>,
  request: Parameters<FakeTrustEngine['receiveVerification']>[1] = {},
) {
  engine.receiveVerification(alice, request);
  await settle();
}

const READY_WITH_QR = {
  phase: 'ready',
  theirMethods: ['m.qr_code.scan.v1', 'm.qr_code.show.v1'],
} as const;

describe('TrustVerificationService', () => {
  it('takes up a request that predates the projection', async () => {
    const context = setup();
    await firstValueFrom(context.svc.startSelfVerification());
    context.engine.updateVerification(context.alice, { phase: 'ready' });

    await run(context.svc);

    expect(context.svc.active()).toMatchObject({
      stage: 'ready',
      incoming: false,
    });
  });

  it('surfaces an incoming verification request', async () => {
    const context = setup();
    await run(context.svc);

    await incoming(context, { otherDeviceId: 'PHONE' });

    expect(context.svc.active()).toMatchObject({
      stage: 'requested',
      incoming: true,
      otherDeviceId: 'PHONE',
    });
  });

  it('ignores a new incoming request while one is active', async () => {
    const context = setup();
    await run(context.svc);

    await incoming(context, { otherDeviceId: 'A' });
    await incoming(context, { otherDeviceId: 'B' });

    expect(context.svc.active()?.otherDeviceId).toBe('A');
  });

  it('starts a cross-user verification over a DM and adopts it', async () => {
    const context = setup();
    await run(context.svc);
    context.engine.addUserIdentity('@carol:hs');

    await firstValueFrom(
      context.svc.startUserVerification('@carol:hs', of('!dm:hs')),
    );
    await settle();

    expect(context.engine.sentDirectRequests).toEqual(['@carol:hs !dm:hs']);
    expect(context.svc.active()).toMatchObject({
      stage: 'requested',
      otherUserId: '@carol:hs',
      isSelfVerification: false,
      incoming: false,
    });
  });

  it('waits for the counterpart identity before sending and presenting verification', async () => {
    const context = setup();
    await run(context.svc);
    const outcome = firstValueFrom(
      context.svc.startUserVerification('@carol:hs', of('!dm:hs')),
    ).then(
      () => 'started',
      () => 'failed',
    );
    await settle();

    expect(context.engine.sentDirectRequests).toEqual([]);
    expect(context.svc.active()).toBeNull();

    context.engine.addUserIdentity('@carol:hs');

    await expect(outcome).resolves.toBe('started');
    await settle();
    expect(context.svc.active()).toMatchObject({
      otherUserId: '@carol:hs',
      isSelfVerification: false,
    });
  });

  it('reports unavailable identity finitely and ignores a later refresh', async () => {
    vi.useFakeTimers();
    const context = setup();
    const errors: unknown[] = [];
    const attempt = context.svc
      .startUserVerification('@carol:hs', of('!dm:hs'))
      .subscribe({ error: (error: unknown) => errors.push(error) });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(errors).toEqual([
        expect.objectContaining({
          operation: 'start-verification',
          kind: 'not-ready',
          recovery: 'retry',
          message: 'Verification is not ready for this user yet. Try again.',
        }),
      ]);

      context.engine.addUserIdentity('@carol:hs');

      expect(context.engine.sentDirectRequests).toEqual([]);
    } finally {
      attempt.unsubscribe();
    }
  });

  it('stops pending verification startup when the session lifetime ends', async () => {
    const context = setup();
    const lifetime = await run(context.svc);
    const attempt = context.svc
      .startUserVerification('@carol:hs', of('!dm:hs'))
      .subscribe({ error: () => undefined });

    lifetime.unsubscribe();
    context.engine.addUserIdentity('@carol:hs');

    expect(attempt.closed).toBe(true);
    expect(context.engine.sentDirectRequests).toEqual([]);
    expect(context.svc.active()).toBeNull();
  });

  it('does not send after the account signs out during identity lookup', async () => {
    const context = setup();
    const outcome = firstValueFrom(
      context.svc.startUserVerification('@carol:hs', of('!dm:hs')),
    ).catch((error: unknown) => error);
    await settle();

    context.engine.removeAccount(context.alice);

    await expect(outcome).resolves.toMatchObject({
      kind: 'stale-state',
      message: 'The active account changed. Start verification again.',
    });
    expect(context.engine.sentDirectRequests).toEqual([]);
  });

  it('retains the initiating Account while its direct room is being created', async () => {
    const context = setup();
    context.engine.addUserIdentity('@carol:hs');
    const directRoom = new Subject<string>();
    const outcome = firstValueFrom(
      context.svc.startUserVerification('@carol:hs', directRoom),
    ).catch((error: unknown) => error);
    await settle();

    context.session.set(sessionWith(context.alice, [context.alice, BOB], 2));
    directRoom.next('!dm:hs');
    directRoom.complete();

    await expect(outcome).resolves.toMatchObject({ kind: 'stale-state' });
    expect(context.engine.sentDirectRequests).toEqual([]);
  });

  it('refuses before acquiring the DM when the account has no crypto', async () => {
    const context = setup();
    context.engine.addAccount(context.alice, { crypto: false });
    const directRoom = vi.fn(() => of('!dm:hs'));

    await expect(
      firstValueFrom(
        context.svc.startUserVerification(
          '@carol:hs',
          new Observable<string>((subscriber) =>
            directRoom().subscribe(subscriber),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      kind: 'not-ready',
      message: 'Trust is not ready for this account yet.',
    });
    expect(directRoom).not.toHaveBeenCalled();
  });

  it('clears an active verification when the session lifetime ends', async () => {
    const context = setup();
    const lifetime = await run(context.svc);
    await outgoing(context);
    expect(context.svc.active()).not.toBeNull();

    lifetime.unsubscribe();

    expect(context.svc.active()).toBeNull();
  });

  it('drives the SAS flow: start → waiting → emoji shown', async () => {
    const context = setup();
    await run(context.svc);
    await outgoing(context, { phase: 'ready' });
    expect(context.svc.active()?.stage).toBe('ready');

    await firstValueFrom(context.svc.startSas());
    await settle();
    expect(context.svc.active()?.stage).toBe('waiting'); // started, no emoji yet

    context.engine.showSas(context.alice);
    await settle();
    expect(context.svc.active()?.stage).toBe('sas-shown');
    expect(context.svc.active()?.emoji).toHaveLength(7);
    expect(context.svc.active()?.emoji?.[0]).toEqual({
      glyph: '🐶',
      name: 'Dog',
    });
  });

  it('offers QR directions only for self-verification methods the other device supports', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);

    expect(context.svc.active()).toMatchObject({
      qrShowAvailable: true,
      qrScanAvailable: true,
    });

    context.engine.updateVerification(context.alice, { phase: 'done' });
    await incoming(context, {
      ...READY_WITH_QR,
      isSelfVerification: false,
      otherUserId: '@carol:hs',
    });

    expect(context.svc.active()).toMatchObject({
      qrShowAvailable: false,
      qrScanAvailable: false,
    });
  });

  it('does not expose QR bytes until the user explicitly asks to show them', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);
    expect(context.svc.active()?.stage).toBe('ready');

    const emitted = await firstValueFrom(context.svc.showQr());

    expect(context.svc.active()?.stage).toBe('qr-shown');
    expect(emitted).toEqual(new Uint8ClampedArray([0, 255, 7, 128]));
    expect(context.svc.active()).not.toHaveProperty('qrCodeData');
  });

  it('leaves the QR display once a verification method starts', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);
    await firstValueFrom(context.svc.showQr());

    context.engine.updateVerification(context.alice, { phase: 'started' });
    await settle();

    expect(context.svc.active()?.stage).toBe('waiting');
  });

  it('reports a QR code generated after the request moved on as stale', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);
    vi.spyOn(context.engine, 'showQr').mockReturnValue(
      of(failure('verification-gone')),
    );

    await expect(firstValueFrom(context.svc.showQr())).rejects.toMatchObject({
      kind: 'stale-state',
      operation: 'show-qr',
      message: 'The verification request changed. Try again.',
    });
    expect(context.svc.active()?.stage).toBe('ready');
  });

  it('leaves the QR display when the request is cancelled', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);
    await firstValueFrom(context.svc.showQr());

    context.engine.updateVerification(context.alice, {
      phase: 'cancelled',
      cancellation: { code: 'm.user' },
    });
    await settle();

    expect(context.svc.active()?.stage).toBe('cancelled');
  });

  it('keeps SAS available when QR generation has no usable payload', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);
    context.engine.qrPayload = '';

    await expect(firstValueFrom(context.svc.showQr())).rejects.toMatchObject({
      kind: 'unsupported',
      message:
        'QR verification isn’t available for these sessions. Use emoji verification instead.',
    });
    expect(context.svc.active()?.stage).toBe('ready');
  });

  it('refuses QR for a cross-user verification', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, {
      ...READY_WITH_QR,
      isSelfVerification: false,
      otherUserId: '@carol:hs',
    });

    await expect(firstValueFrom(context.svc.showQr())).rejects.toMatchObject({
      kind: 'unsupported',
      recovery: 'none',
    });
  });

  it('passes scanned bytes to the engine unchanged and waits for the other device', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);
    const scan = vi.spyOn(context.engine, 'scanQr');

    await firstValueFrom(
      context.svc.scanQr(new Uint8ClampedArray([0, 255, 7, 128])),
    );

    expect(scan).toHaveBeenCalledWith(
      context.alice,
      expect.any(String),
      'AP8HgA==',
    );
    expect(context.svc.active()?.stage).toBe('waiting');
  });

  it('refuses an empty scan', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, READY_WITH_QR);

    await expect(
      firstValueFrom(context.svc.scanQr(new Uint8ClampedArray())),
    ).rejects.toMatchObject({ kind: 'invalid-secret' });
  });

  it('asks before reciprocating a scan and confirms through the engine', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, { phase: 'started', qrScannedByOther: true });
    expect(context.svc.active()?.stage).toBe('qr-confirm');

    await firstValueFrom(context.svc.confirmQr());
    await settle();

    expect(context.svc.active()?.stage).toBe('waiting');
  });

  it('confirms the SAS through the engine and waits for the other side', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, { phase: 'started' });
    context.engine.showSas(context.alice);
    await settle();
    expect(context.svc.active()?.sasConfirmed).toBe(false);
    const confirm = vi.spyOn(context.engine, 'confirmSas');

    await firstValueFrom(context.svc.confirmSas());

    expect(confirm).toHaveBeenCalledOnce();
    // Our MAC is out but the other side hasn't answered, so the phase is still started:
    // the flag is what lets the UI show the wait instead of asking again.
    expect(context.svc.active()?.stage).toBe('sas-shown');
    expect(context.svc.active()?.sasConfirmed).toBe(true);
  });

  // The spinner has to answer the click, not the round-trip.
  it('starts waiting as soon as the answer is given, not when it lands', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, { phase: 'started' });
    context.engine.showSas(context.alice);
    await settle();
    const sent = new Subject<EngineResult<null>>();
    vi.spyOn(context.engine, 'confirmSas').mockReturnValue(sent);

    const confirmed = firstValueFrom(context.svc.confirmSas());
    expect(context.svc.active()?.sasConfirmed).toBe(true);

    sent.next({ ok: true, value: null });
    await confirmed;
    expect(context.svc.active()?.sasConfirmed).toBe(true);
  });

  // A stale wait carried into the next verification would show a spinner on a screen
  // that has not been answered yet — and hide the answer buttons with it.
  it('starts the next verification asking, not waiting', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, { phase: 'started' });
    context.engine.showSas(context.alice);
    await settle();
    await firstValueFrom(context.svc.confirmSas());
    expect(context.svc.active()?.sasConfirmed).toBe(true);

    context.engine.updateVerification(context.alice, { phase: 'cancelled' });
    await incoming(context);

    expect(context.svc.active()?.stage).toBe('requested');
    expect(context.svc.active()?.sasConfirmed).toBe(false);
  });

  it('drops back to asking when confirming the SAS fails', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, { phase: 'started' });
    context.engine.showSas(context.alice);
    await settle();
    vi.spyOn(context.engine, 'confirmSas').mockReturnValue(
      of(failure('request-failed')),
    );

    await expect(
      firstValueFrom(context.svc.confirmSas()),
    ).rejects.toMatchObject({
      operation: 'confirm-verification',
      kind: 'server-failure',
      recovery: 'retry',
    });
    expect(context.svc.active()?.sasConfirmed).toBe(false);
  });

  it('cancels the current flow through the engine', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, { phase: 'started' });
    const cancel = vi.spyOn(context.engine, 'cancelVerification');

    await firstValueFrom(context.svc.cancel());
    await settle();

    expect(cancel).toHaveBeenCalledOnce();
    expect(context.svc.active()?.stage).toBe('cancelled');
  });

  it('cancels and mismatches nothing quietly when no verification is in progress', async () => {
    const context = setup();
    const cancel = vi.spyOn(context.engine, 'cancelVerification');

    await firstValueFrom(context.svc.cancel(), { defaultValue: undefined });
    await firstValueFrom(context.svc.mismatchSas(), {
      defaultValue: undefined,
    });

    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['m.mismatched_sas', 'The emoji did not match — verification was stopped.'],
    ['m.timeout', 'The verification timed out.'],
    ['m.user', 'The verification was cancelled.'],
  ])('maps a %s cancellation to a friendly reason', async (code, reason) => {
    const context = setup();
    await run(context.svc);
    await incoming(context);

    context.engine.updateVerification(context.alice, {
      phase: 'cancelled',
      cancellation: { code },
    });
    await settle();

    expect(context.svc.active()).toMatchObject({
      stage: 'cancelled',
      cancelReason: reason,
    });
  });

  it('reflects a mismatch report as a cancelled verification', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context, { phase: 'started' });
    context.engine.showSas(context.alice);
    await settle();

    await firstValueFrom(context.svc.mismatchSas(), {
      defaultValue: undefined,
    });
    await settle();

    expect(context.svc.active()?.cancelReason).toMatch(/did not match/i);
  });

  it('reflects the done stage and dismiss() clears it until the next request', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context);

    context.engine.updateVerification(context.alice, { phase: 'done' });
    await settle();
    expect(context.svc.active()?.stage).toBe('done');

    context.svc.dismiss();
    expect(context.svc.active()).toBeNull();
    context.engine.updateVerification(context.alice, { otherDeviceId: 'X' });
    await settle();
    expect(context.svc.active()).toBeNull();

    await incoming(context, { otherDeviceId: 'NEXT' });
    expect(context.svc.active()?.otherDeviceId).toBe('NEXT');
  });

  it('errors when an action runs with no verification in progress', async () => {
    const { svc } = setup();
    await expect(firstValueFrom(svc.accept())).rejects.toThrow(
      /no verification/i,
    );
  });

  it('accepts the current request through the engine', async () => {
    const context = setup();
    await run(context.svc);
    await incoming(context);

    await firstValueFrom(context.svc.accept());
    await settle();

    expect(context.svc.active()?.stage).toBe('ready');
  });

  it('follows the newly active account on a switch', async () => {
    const context = setup();
    await run(context.svc);

    context.session.set(sessionWith(BOB, [context.alice, BOB]));
    await settle();

    context.engine.receiveVerification(context.alice, {
      otherUserId: '@old:hs',
    });
    await settle();
    expect(context.svc.active()).toBeNull();

    context.engine.receiveVerification(BOB, { otherUserId: '@new:hs' });
    await settle();
    expect(context.svc.active()?.otherUserId).toBe('@new:hs');
  });

  it('does not show a DM verification again after switching away and back', async () => {
    const context = setup();
    await run(context.svc);
    context.engine.addUserIdentity('@carol:hs');
    await firstValueFrom(
      context.svc.startUserVerification('@carol:hs', of('!dm:hs')),
    );
    await settle();
    expect(context.svc.active()?.otherUserId).toBe('@carol:hs');

    context.session.set(sessionWith(BOB, [context.alice, BOB]));
    await settle();
    context.session.set(sessionWith(context.alice, [context.alice, BOB]));
    await settle();

    expect(context.svc.active()).toBeNull();
  });

  it('shows an own-device request again after switching back only while it is in progress', async () => {
    const context = setup();
    await run(context.svc);
    await outgoing(context, { phase: 'ready' });

    context.session.set(sessionWith(BOB, [context.alice, BOB]));
    await settle();
    context.session.set(sessionWith(context.alice, [context.alice, BOB]));
    await settle();
    expect(context.svc.active()?.stage).toBe('ready');

    context.session.set(sessionWith(BOB, [context.alice, BOB]));
    await settle();
    context.engine.updateVerification(context.alice, { phase: 'cancelled' });
    context.session.set(sessionWith(context.alice, [context.alice, BOB]));
    await settle();
    expect(context.svc.active()).toBeNull();
  });

  describe('a request from another of the user’s own sessions', () => {
    const newPhone: DeviceInfo = {
      id: 'PHONE',
      displayName: 'Pixel 9',
      lastSeenTs: 1_700_000_000_000,
      lastSeenIp: '203.0.113.7',
      isCurrent: false,
      isVerified: false,
    };

    async function receive(
      options: Parameters<typeof setup>[0],
      request: Parameters<FakeTrustEngine['receiveVerification']>[1] = {
        otherDeviceId: 'PHONE',
      },
    ) {
      const context = setup(options);
      await run(context.svc);
      await incoming(context, request);
      return context;
    }

    it('describes the requester as a new session when this device is verified', async () => {
      const { svc } = await receive({
        thisDeviceVerified: true,
        devices: of([newPhone]),
      });

      expect(svc.active()?.newSession).toEqual({
        deviceId: 'PHONE',
        displayName: 'Pixel 9',
        lastSeenIp: '203.0.113.7',
        lastSeenTs: 1_700_000_000_000,
      });
    });

    it('presents the request at once and fills the details in when /devices answers', async () => {
      const devices = new Subject<DeviceInfo[]>();
      const { svc } = await receive({ thisDeviceVerified: true, devices });

      expect(svc.active()?.newSession).toEqual({
        deviceId: 'PHONE',
        displayName: null,
        lastSeenIp: null,
        lastSeenTs: null,
      });

      devices.next([newPhone]);

      expect(svc.active()?.newSession?.displayName).toBe('Pixel 9');
    });

    it('keeps the device id and leaves the rest unknown when /devices fails', async () => {
      const { svc } = await receive({
        thisDeviceVerified: true,
        devices: throwError(() => new Error('devices unavailable')),
      });

      expect(svc.active()?.newSession).toEqual({
        deviceId: 'PHONE',
        displayName: null,
        lastSeenIp: null,
        lastSeenTs: null,
      });
    });

    it('removes control and format characters from what the session calls itself', async () => {
      const { svc } = await receive({
        thisDeviceVerified: true,
        devices: of([{ ...newPhone, displayName: ' Pixel‮ 9​\u0007 ' }]),
      });

      expect(svc.active()?.newSession?.displayName).toBe('Pixel 9');
    });

    it('treats a name made only of invisible characters as no name', async () => {
      const { svc } = await receive({
        thisDeviceVerified: true,
        devices: of([{ ...newPhone, displayName: '‮​  ' }]),
      });

      expect(svc.active()?.newSession?.displayName).toBeNull();
    });

    it('removes control and format characters from the device id it shows', async () => {
      const { svc } = await receive(
        { thisDeviceVerified: true, devices: of([newPhone]) },
        { otherDeviceId: 'PH‮ON​E' },
      );

      expect(svc.active()?.newSession?.deviceId).toBe('PHONE');
    });

    it('does not repeat the device id as its name when the session is unnamed', async () => {
      const { svc } = await receive({
        thisDeviceVerified: true,
        devices: of([{ ...newPhone, displayName: 'PHONE' }]),
      });

      expect(svc.active()?.newSession?.displayName).toBeNull();
    });

    it('does not repeat a device id with hidden characters as its name', async () => {
      const id = 'PH‮ONE';
      const { svc } = await receive(
        {
          thisDeviceVerified: true,
          devices: of([{ ...newPhone, id, displayName: id }]),
        },
        { otherDeviceId: id },
      );

      expect(svc.active()?.newSession?.deviceId).toBe('PHONE');
      expect(svc.active()?.newSession?.displayName).toBeNull();
      expect(svc.active()?.otherDeviceId).toBe('PHONE');
    });

    it('treats an unknown trust state as the verified side', async () => {
      const { svc } = await receive({ thisDeviceVerified: null });

      expect(svc.active()?.newSession?.deviceId).toBe('PHONE');
    });

    it('leaves the request unchanged when this device is the unverified one', async () => {
      const { svc } = await receive({
        thisDeviceVerified: false,
        devices: of([newPhone]),
      });

      expect(svc.active()?.newSession).toBeNull();
    });

    it('only fills in details when the device list shows the requester as verified', async () => {
      const { svc } = await receive({
        thisDeviceVerified: true,
        devices: of([{ ...newPhone, isVerified: true }]),
      });

      expect(svc.active()?.newSession).toEqual({
        deviceId: 'PHONE',
        displayName: 'Pixel 9',
        lastSeenIp: '203.0.113.7',
        lastSeenTs: 1_700_000_000_000,
      });
    });

    it('leaves a request this device started unchanged', async () => {
      const { svc } = await receive(
        { thisDeviceVerified: true },
        { initiatedByMe: true },
      );

      expect(svc.active()?.newSession).toBeNull();
    });

    it('leaves a cross-user request unchanged', async () => {
      const { svc } = await receive(
        { thisDeviceVerified: true },
        { isSelfVerification: false, otherUserId: '@carol:hs' },
      );

      expect(svc.active()?.newSession).toBeNull();
    });

    it('keeps describing the requester once it has been verified', async () => {
      const context = await receive({
        thisDeviceVerified: true,
        devices: of([newPhone]),
      });

      context.engine.updateVerification(context.alice, { phase: 'done' });
      await settle();

      expect(context.svc.active()).toMatchObject({
        stage: 'done',
        newSession: { deviceId: 'PHONE', displayName: 'Pixel 9' },
      });
    });

    it('does not let an earlier request’s /devices answer reach the next request', async () => {
      const first = new Subject<DeviceInfo[]>();
      const second = new Subject<DeviceInfo[]>();
      const context = setup({ thisDeviceVerified: true });
      context.list.mockReturnValueOnce(first).mockReturnValueOnce(second);
      await run(context.svc);
      await incoming(context, { otherDeviceId: 'PHONE' });
      context.engine.updateVerification(context.alice, { phase: 'cancelled' });
      await incoming(context, { otherDeviceId: 'TABLET' });
      expect(context.list).toHaveBeenCalledTimes(2);

      first.next([newPhone]);

      expect(context.svc.active()?.newSession).toEqual({
        deviceId: 'TABLET',
        displayName: null,
        lastSeenIp: null,
        lastSeenTs: null,
      });

      second.next([{ ...newPhone, id: 'TABLET', displayName: 'Tab' }]);

      expect(context.svc.active()?.newSession?.displayName).toBe('Tab');
    });

    it('drops a /devices answer that arrives after an account switch', async () => {
      const devices = new Subject<DeviceInfo[]>();
      const context = await receive({ thisDeviceVerified: true, devices });
      expect(context.svc.active()?.newSession?.deviceId).toBe('PHONE');

      context.session.set(sessionWith(BOB, [context.alice, BOB]));
      await settle();
      expect(context.svc.active()).toBeNull();

      devices.next([newPhone]);

      expect(context.svc.active()).toBeNull();
    });

    describe('when this device’s trust state is not known yet', () => {
      async function receiveUnknown() {
        const context = await receive({ thisDeviceVerified: null });
        expect(context.svc.active()?.newSession).not.toBeNull();
        return context;
      }

      it('decides the side again, once, when it resolves to unverified', async () => {
        const { svc, thisDeviceVerified } = await receiveUnknown();

        thisDeviceVerified.set(false);
        TestBed.tick();

        expect(svc.active()?.newSession).toBeNull();
      });

      it('keeps the decision when it resolves to verified, and does not decide again', async () => {
        const { svc, thisDeviceVerified } = await receiveUnknown();

        thisDeviceVerified.set(true);
        TestBed.tick();
        thisDeviceVerified.set(false);
        TestBed.tick();

        expect(svc.active()?.newSession?.deviceId).toBe('PHONE');
      });

      it('does not decide again once the request has moved on from requested', async () => {
        const context = await receiveUnknown();
        context.engine.updateVerification(context.alice, { phase: 'ready' });
        await settle();

        context.thisDeviceVerified.set(false);
        TestBed.tick();

        expect(context.svc.active()?.newSession?.deviceId).toBe('PHONE');
      });
    });
  });
});
