import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';
import { inspect } from 'node:util';

import { install } from './install';
import type { NativeRequest, NativeResponse } from './types';

const ME = '@alice:example.org';
const BOB = '@bob:example.org';
const FLOW = '$request';

const description = {
  userId: ME,
  deviceId: 'ALICE',
  identityKeys: {
    ed25519: 'ed-key',
    curve25519: 'mB7Ywmbd9WlFtWhT/4ZbVlUFkNmz04hxkx1bt+QBJ0E',
  },
  deviceCreationTimeMs: 1234,
};

const request = (fields: Record<string, unknown> = {}) => ({
  kind: 'request',
  ownUserId: ME,
  otherUserId: BOB,
  flowId: FLOW,
  roomId: '!dm:example.org',
  phase: real.VerificationRequestPhase.Requested,
  isPassive: false,
  isReady: false,
  isDone: false,
  isCancelled: false,
  isSelfVerification: false,
  weStarted: false,
  timedOut: false,
  expiresAtMs: Date.now() + 600_000,
  theirSupportedMethods: [real.VerificationMethod.SasV1],
  ...fields,
});
const sas = (fields: Record<string, unknown> = {}) => ({
  kind: 'sas',
  otherUserId: BOB,
  otherDeviceId: 'BOB',
  flowId: FLOW,
  isDone: false,
  isCancelled: false,
  ...fields,
});
const qr = (fields: Record<string, unknown> = {}) => ({
  kind: 'qr',
  otherUserId: BOB,
  otherDeviceId: 'BOB',
  flowId: FLOW,
  state: real.QrState.Created,
  hasBeenScanned: false,
  isDone: false,
  isCancelled: false,
  ...fields,
});
const transitioned = (verification: Record<string, unknown>) =>
  request({
    phase: real.VerificationRequestPhase.Transitioned,
    verification,
  });
const EMOJI = Array.from({ length: 7 }, (_, index) => ({
  symbol: `${index}`,
  description: `emoji ${index}`,
}));
const toDevice = {
  id: 'out',
  type: real.RequestType.ToDevice,
  event_type: 'm.key.verification.cancel',
  txn_id: 'txn',
  body: '{}',
};

type Answer = unknown | ((request: NativeRequest) => NativeResponse);

/**
 * A crate with one machine: `answers` maps a method to its result or to a function answering the
 * request; `events` are what the next poll answers (an answer function may push some).
 */
function fakeCrate(answers: Record<string, Answer>) {
  const requests: NativeRequest[] = [];
  const events: Record<string, unknown>[] = [];
  const crate = { requests, events, dropped: 0, panicOn: new Set<string>() };
  let open = false;
  const answer = (request: NativeRequest): NativeResponse => {
    requests.push(request);
    if (request.method === 'init') {
      open = true;
      return { result: description };
    }
    if (request.method === 'roomKeyRequestsEnabled') return { result: true };
    if (request.method === 'pollEvents') {
      const dropped = crate.dropped;
      crate.dropped = 0;
      return { result: { events: events.splice(0), dropped } };
    }
    if (!open) return { error: { code: 'UnknownMachine', message: 'init' } };
    if (crate.panicOn.delete(request.method)) {
      open = false;
      return { error: { code: 'Panic', message: 'panic' } };
    }
    const found = answers[request.method];
    if (typeof found === 'function')
      return (found as (request: NativeRequest) => NativeResponse)(request);
    if (request.method in answers) return { result: found };
    return { error: { code: 'UnknownMethod', message: request.method } };
  };
  const run = async (text: string): Promise<string> => {
    const parsed = JSON.parse(text) as NativeRequest | NativeRequest[];
    return JSON.stringify(
      Array.isArray(parsed) ? parsed.map(answer) : answer(parsed),
    );
  };
  return { crate, bridge: { call: run, callBatch: run } };
}

/** `answers` stays live: a test may add answers after the machine is open. */
async function machine(
  answers: Record<string, Answer> = {},
  options: { onMachineLost?: (reason: string) => void } = {},
) {
  const defaults = {
    receiveVerificationEvent: null,
    getVerificationRequest: request(),
    receiveSyncChanges: [],
  };
  for (const [method, answer] of Object.entries(defaults))
    if (!(method in answers)) answers[method] = answer;
  const { crate, bridge } = fakeCrate(answers);
  const { uninstallForTests } = install({
    bridge,
    storeDirectory: '/stores',
    ...options,
  });
  try {
    const store = await real.StoreHandle.openWithKey(
      'prefix',
      new Uint8Array(32).fill(7),
    );
    const olm = await real.OlmMachine.initFromStore(
      new real.UserId(ME),
      new real.DeviceId('ALICE'),
      store,
    );
    return { olm, crate };
  } finally {
    uninstallForTests();
  }
}

const sent = (crate: { requests: NativeRequest[] }, method: string) =>
  crate.requests.filter((request) => request.method === method);
const bob = () => new real.UserId(BOB);
const room = () => new real.RoomId('!dm:example.org');
const inRoomRequest = JSON.stringify({
  type: 'm.room.message',
  event_id: FLOW,
  sender: BOB,
  content: { msgtype: 'm.key.verification.request', methods: [] },
});
const sync = (olm: real.OlmMachine) =>
  olm.receiveSyncChanges('[]', new real.DeviceLists(), new Map(), new Set());
/** Answers with `result` and queues `events` for the poll of the same batch. */
const withEvents =
  (
    crate: { events: Record<string, unknown>[] },
    result: unknown,
    ...events: Record<string, unknown>[]
  ) =>
  (): NativeResponse => {
    crate.events.push(...events);
    return { result };
  };

/** An incoming in-room request, in the registry as matrix-js-sdk reads it. */
async function incoming(
  answers: Record<string, Answer> = {},
  options: { onMachineLost?: (reason: string) => void } = {},
) {
  const opened = await machine(answers, options);
  await opened.olm.receiveVerificationEvent(inRoomRequest, room());
  const found = opened.olm.getVerificationRequest(bob(), FLOW)!;
  return { ...opened, found };
}

describe('verification requests on the native shim', () => {
  it('puts an incoming request in the registry before the event resolves, as one object', async () => {
    const { olm, crate, found } = await incoming();
    expect(sent(crate, 'getVerificationRequest')[0]?.params).toEqual({
      userId: BOB,
      flowId: FLOW,
    });
    expect(found).toBeInstanceOf(real.VerificationRequest);
    expect(
      (found as unknown as { __wbg_ptr?: number }).__wbg_ptr,
    ).toBeUndefined();
    expect(olm.getVerificationRequest(bob(), FLOW)).toBe(found);
    expect(olm.getVerificationRequests(bob())).toEqual([found]);
    expect(olm.getVerificationRequests(new real.UserId(ME))).toEqual([]);
    // matrix-js-sdk's synchronous reads.
    expect(found.flowId).toBe(FLOW);
    expect(found.roomId?.toString()).toBe('!dm:example.org');
    expect(found.otherUserId.toString()).toBe(BOB);
    expect(found.otherDeviceId).toBeUndefined();
    expect(found.weStarted()).toBe(false);
    expect(found.isSelfVerification()).toBe(false);
    expect(found.isPassive()).toBe(false);
    expect(found.isCancelled()).toBe(false);
    expect(found.phase()).toBe(real.VerificationRequestPhase.Requested);
    expect(found.theirSupportedMethods).toEqual([
      real.VerificationMethod.SasV1,
    ]);
    expect(found.cancelInfo).toBeUndefined();
    expect(found.getVerification()).toBeUndefined();
  });

  it('fetches a to-device request from the sync input before it resolves', async () => {
    const toDeviceRequest = JSON.stringify({
      type: 'm.key.verification.request',
      sender: BOB,
      content: { transaction_id: 'flow-1', methods: [] },
    });
    const { olm, crate } = await machine({
      receiveSyncChanges: [{ type: 2, rawEvent: toDeviceRequest }],
      getVerificationRequest: request({ flowId: 'flow-1', roomId: undefined }),
    });
    await sync(olm);
    expect(sent(crate, 'getVerificationRequest')[0]?.params).toEqual({
      userId: BOB,
      flowId: 'flow-1',
    });
    expect(olm.getVerificationRequest(bob(), 'flow-1')?.flowId).toBe('flow-1');
  });

  it('updates the mirror and runs its callbacks before the causing call resolves', async () => {
    const order: string[] = [];
    const answers: Record<string, Answer> = {};
    const { crate, found } = await incoming(answers);
    answers['acceptVerificationRequest'] = withEvents(crate, toDevice, {
      type: 'verificationRequestChanged',
      request: request({ phase: real.VerificationRequestPhase.Ready }),
    });
    found.registerChangesCallback(async () => {
      order.push(`first ${found.phase()}`);
    });
    found.registerChangesCallback(async () => {
      order.push(`second ${found.phase()}`);
    });
    const ready = real.VerificationRequestPhase.Ready;
    const outgoing = await found.acceptWithMethods([
      real.VerificationMethod.SasV1,
    ]);
    order.push('resolved');
    expect(order).toEqual([`first ${ready}`, `second ${ready}`, 'resolved']);
    expect(outgoing).toBeInstanceOf(real.ToDeviceRequest);
    expect(sent(crate, 'acceptVerificationRequest')[0]?.params).toEqual({
      userId: BOB,
      flowId: FLOW,
      methods: [real.VerificationMethod.SasV1],
    });
  });

  it('answers the time left from the deadline, and timedOut once it passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const { found } = await incoming({
        getVerificationRequest: request({ expiresAtMs: 1_060_000 }),
      });
      expect(found.timeRemainingMillis()).toBe(60_000);
      expect(found.timedOut()).toBe(false);
      vi.setSystemTime(1_059_000);
      expect(found.timeRemainingMillis()).toBe(1000);
      vi.setSystemTime(1_070_000);
      expect(found.timeRemainingMillis()).toBe(0);
      expect(found.timedOut()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a SAS or QR stand-in by kind, keeps it for its flow and updates it from its events', async () => {
    const answers: Record<string, Answer> = {};
    const { crate, found } = await incoming(answers);
    answers['startSas'] = withEvents(crate, [sas(), toDevice], {
      type: 'verificationRequestChanged',
      request: transitioned(sas()),
    });
    const requestChanges = vi.fn();
    found.registerChangesCallback(requestChanges);
    const [started, outgoing] = (await found.startSas())!;
    expect(started).toBeInstanceOf(real.Sas);
    expect(outgoing).toBeInstanceOf(real.ToDeviceRequest);
    expect(found.getVerification()).toBe(started);
    expect(found.getVerification()).toBe(started);
    expect(requestChanges).toHaveBeenCalledTimes(1);
    const sasChanges = vi.fn(async () => {
      expect(started.emoji()).toHaveLength(7);
    });
    started.registerChangesCallback(sasChanges);
    answers['acceptSas'] = withEvents(crate, null, {
      type: 'verificationChanged',
      verification: sas({ emoji: EMOJI, decimals: [1, 2, 3] }),
    });
    expect(await started.accept()).toBeUndefined();
    expect(sasChanges).toHaveBeenCalledTimes(1);
    expect(requestChanges).toHaveBeenCalledTimes(1);
    const emoji = started.emoji()!;
    expect(emoji[0]).toBeInstanceOf(real.Emoji);
    expect([emoji[0]!.symbol, emoji[0]!.description]).toEqual(['0', 'emoji 0']);
    expect([...started.decimals()!]).toEqual([1, 2, 3]);
    expect(started.decimals()).toBeInstanceOf(Uint16Array);
    expect(started.otherUserId.toString()).toBe(BOB);
    expect([started.isDone(), started.isCancelled()]).toEqual([false, false]);
  });

  it('replaces the stand-in when the flow changes its verification, as getVerification shows it', async () => {
    const answers: Record<string, Answer> = {};
    const { crate, found } = await incoming(answers);
    answers['generateQrCode'] = withEvents(crate, qr(), {
      type: 'verificationRequestChanged',
      request: transitioned(qr()),
    });
    const shown = (await found.generateQrCode())!;
    expect(shown).toBeInstanceOf(real.Qr);
    // The other side starts SAS instead: the request changes while Transitioned.
    answers['acceptVerificationRequest'] = withEvents(crate, null, {
      type: 'verificationRequestChanged',
      request: transitioned(sas()),
    });
    await found.acceptWithMethods([]);
    const first = found.getVerification();
    expect(first).toBeInstanceOf(real.Sas);
    expect(first).not.toBe(shown);
    // The SAS of the other side's start replaces ours (they won the tie).
    answers['acceptSas'] = withEvents(crate, null, {
      type: 'verificationRequestChanged',
      request: transitioned(sas({ emoji: EMOJI, decimals: [7, 8, 9] })),
    });
    await (first as real.Sas).accept();
    const second = found.getVerification();
    expect(second).toBeInstanceOf(real.Sas);
    expect(second).not.toBe(first);
    // The replaced objects refuse to act on the flow's new verification.
    await expect((first as real.Sas).cancel()).rejects.toMatchObject({
      code: 'StaleObject',
    });
    await expect(shown.toBytes()).rejects.toMatchObject({
      code: 'StaleObject',
    });
    expect(sent(crate, 'cancelSas')).toEqual([]);
    expect(sent(crate, 'qrCodeBytes')).toEqual([]);
  });
});

describe("a poll's events", () => {
  /** A started SAS whose request and SAS mirrors hold callbacks. */
  async function started(options = {}) {
    const answers: Record<string, Answer> = {};
    const opened = await incoming(answers, options);
    answers['startSas'] = withEvents(opened.crate, [sas(), toDevice], {
      type: 'verificationRequestChanged',
      request: transitioned(sas()),
    });
    const [verifier] = (await opened.found.startSas())!;
    return { ...opened, answers, verifier };
  }
  const done = {
    phase: real.VerificationRequestPhase.Done,
    isDone: true,
  };

  /** A SAS whose emoji were shown, so it can confirm. */
  async function shown(options = {}) {
    const opened = await started(options);
    opened.answers['acceptSas'] = withEvents(opened.crate, null, {
      type: 'verificationChanged',
      verification: sas({ emoji: EMOJI, decimals: [1, 2, 3] }),
    });
    await opened.verifier.accept();
    opened.verifier.emoji();
    return opened;
  }
  /** The crate's order for a SAS that ends: its last change, then its request's end. */
  const ending = [
    { type: 'verificationChanged', verification: sas({ isDone: true }) },
    { type: 'verificationRequestChanged', request: request(done) },
  ];

  it('updates every mirror of the poll before any callback runs', async () => {
    const { crate, answers, found, verifier } = await shown();
    const seen: string[] = [];
    verifier.registerChangesCallback(async () => {
      seen.push(`sas done ${verifier.isDone()}, request ${found.phase()}`);
    });
    found.registerChangesCallback(async () => {
      seen.push(`request ${found.phase()}`);
    });
    answers['confirmSas'] = withEvents(crate, [], ...ending);
    await verifier.confirm();
    expect(seen).toEqual([
      `sas done true, request ${done.phase}`,
      `request ${done.phase}`,
    ]);
  });

  it('loses the machine on a malformed event and delivers none of the poll', async () => {
    const lost = vi.fn();
    const { crate, answers, verifier, olm } = await started({
      onMachineLost: lost,
    });
    const changes = vi.fn();
    verifier.registerChangesCallback(changes);
    answers['acceptSas'] = withEvents(
      crate,
      null,
      { type: 'verificationRequestChanged', request: { kind: 'request' } },
      { type: 'verificationChanged', verification: sas({ isDone: true }) },
    );
    await Promise.resolve(verifier.accept()).catch(() => undefined);
    expect(lost).toHaveBeenCalledWith('pollEvents answered a malformed event');
    expect(changes).not.toHaveBeenCalled();
    await expect(olm.trackedUsers()).rejects.toThrow();
  });

  it('runs the later callbacks of a poll when an earlier one throws', async () => {
    const { crate, answers, found, verifier } = await shown();
    verifier.registerChangesCallback(() => {
      throw new Error('a callback failed');
    });
    const sasChanges = vi.fn();
    verifier.registerChangesCallback(sasChanges);
    const requestChanges = vi.fn();
    found.registerChangesCallback(requestChanges);
    answers['confirmSas'] = withEvents(crate, [], ...ending);
    await verifier.confirm();
    expect(sasChanges).toHaveBeenCalledTimes(1);
    expect(requestChanges).toHaveBeenCalledTimes(1);
  });

  it('ignores a change of a flow the registry no longer holds', async () => {
    const answers: Record<string, Answer> = {};
    const { olm, crate } = await machine(answers);
    answers['trackedUsers'] = withEvents(crate, [], {
      type: 'verificationChanged',
      verification: sas({ isDone: true }),
    });
    await olm.trackedUsers();
    expect(olm.getVerificationRequests(bob())).toEqual([]);
  });
});

describe('the decimals a SAS confirms', () => {
  async function shownSas() {
    const answers: Record<string, Answer> = { confirmSas: [] };
    const { crate, found } = await incoming(answers);
    answers['startSas'] = withEvents(crate, [sas(), toDevice], {
      type: 'verificationRequestChanged',
      request: transitioned(sas()),
    });
    const [started] = (await found.startSas())!;
    answers['acceptSas'] = withEvents(crate, null, {
      type: 'verificationChanged',
      verification: sas({ emoji: EMOJI, decimals: [1, 2, 3] }),
    });
    await started.accept();
    return { crate, answers, found, started };
  }

  it('sends the decimals matrix-js-sdk read, not ones a later event brought', async () => {
    const { crate, answers, started } = await shownSas();
    started.emoji();
    answers['acceptSas'] = withEvents(crate, null, {
      type: 'verificationChanged',
      verification: sas({ emoji: EMOJI, decimals: [4, 5, 6] }),
    });
    await started.accept();
    expect([...started.decimals()!]).toEqual([4, 5, 6]);
    // decimals() handed out [4, 5, 6] now: what the user was shown last.
    await started.confirm();
    expect(sent(crate, 'confirmSas').at(-1)?.params).toEqual({
      userId: BOB,
      flowId: FLOW,
      decimals: [4, 5, 6],
    });
  });

  it('keeps the decimals read before an event changed the mirror', async () => {
    const { crate, answers, started } = await shownSas();
    started.emoji();
    answers['acceptSas'] = withEvents(crate, null, {
      type: 'verificationChanged',
      verification: sas({ emoji: EMOJI, decimals: [4, 5, 6] }),
    });
    await started.accept();
    answers['confirmSas'] = () => ({
      error: {
        code: 'StaleObject',
        message: 'the SAS on this flow is not the one shown',
      },
    });
    await expect(started.confirm()).rejects.toMatchObject({
      code: 'StaleObject',
    });
    expect(sent(crate, 'confirmSas')[0]?.params?.['decimals']).toEqual([
      1, 2, 3,
    ]);
  });

  it("sends the flow's shown decimals from the SAS that replaced the one read", async () => {
    const { crate, answers, found, started } = await shownSas();
    started.decimals();
    answers['acceptSas'] = withEvents(crate, null, {
      type: 'verificationRequestChanged',
      request: transitioned(sas({ emoji: EMOJI, decimals: [7, 8, 9] })),
    });
    await started.accept();
    const replacement = found.getVerification() as real.Sas;
    expect(replacement).not.toBe(started);
    await replacement.confirm().catch(() => undefined);
    expect(sent(crate, 'confirmSas')[0]?.params?.['decimals']).toEqual([
      1, 2, 3,
    ]);
  });

  it('confirms nothing when no decimals were shown', async () => {
    const { crate, started } = await shownSas();
    await expect(started.confirm()).rejects.toMatchObject({
      code: 'InvalidRequest',
    });
    expect(sent(crate, 'confirmSas')).toEqual([]);
  });

  it('answers the confirmation requests, a signature upload last', async () => {
    const { crate, answers, started } = await shownSas();
    started.emoji();
    answers['confirmSas'] = [
      toDevice,
      { type: real.RequestType.SignatureUpload, body: '{}' },
    ];
    const requests = await started.confirm();
    expect(requests[0]).toBeInstanceOf(real.ToDeviceRequest);
    expect(requests[1]).toBeInstanceOf(real.SignatureUploadRequest);
    expect(sent(crate, 'confirmSas')).toHaveLength(1);
  });
});

describe('cancelling a flow the crate collected', () => {
  const unknown = (): NativeResponse => ({
    error: { code: 'UnknownVerification', message: 'no request' },
  });

  it('answers "no request" for a flow the mirror saw cancelled, as WASM', async () => {
    const { found } = await incoming({
      getVerificationRequest: request({
        phase: real.VerificationRequestPhase.Cancelled,
        isCancelled: true,
        cancelInfo: {
          cancelCode: 'm.user',
          reason: 'no',
          cancelledbyUs: false,
        },
      }),
      cancelVerificationRequest: unknown,
      acceptVerificationRequest: unknown,
    });
    expect(await found.cancel()).toBeUndefined();
    expect(await found.acceptWithMethods([])).toBeUndefined();
    const info = found.cancelInfo!;
    expect(info).toBeInstanceOf(real.CancelInfo);
    expect([info.cancelCode(), info.reason(), info.cancelledbyUs()]).toEqual([
      'm.user',
      'no',
      false,
    ]);
  });

  it('fails for a flow the mirror did not see end', async () => {
    const { found } = await incoming({ cancelVerificationRequest: unknown });
    await expect(found.cancel()).rejects.toMatchObject({
      code: 'UnknownVerification',
    });
  });

  it('answers "no request" from a cancelled SAS and QR code too', async () => {
    const answers: Record<string, Answer> = {
      cancelSas: unknown,
      cancelQr: unknown,
    };
    const { crate, found } = await incoming(answers);
    answers['generateQrCode'] = withEvents(crate, qr(), {
      type: 'verificationRequestChanged',
      request: transitioned(qr()),
    });
    const shown = (await found.generateQrCode())!;
    await expect(shown.cancel()).rejects.toMatchObject({
      code: 'UnknownVerification',
    });
    answers['confirmQrScanning'] = withEvents(crate, null, {
      type: 'verificationChanged',
      verification: qr({ isCancelled: true, state: real.QrState.Cancelled }),
    });
    await shown.confirmScanning();
    expect(await shown.cancel()).toBeUndefined();
    expect(shown.state()).toBe(real.QrState.Cancelled);
  });
});

describe("the registry over a machine's life", () => {
  it('drops a flow that was over before a sync input, as upstream collects it then', async () => {
    const answers: Record<string, Answer> = {};
    const { olm, crate, found } = await incoming(answers);
    await sync(olm);
    expect(olm.getVerificationRequest(bob(), FLOW)).toBe(found);
    answers['cancelVerificationRequest'] = withEvents(crate, toDevice, {
      type: 'verificationRequestChanged',
      request: request({
        isCancelled: true,
        phase: real.VerificationRequestPhase.Cancelled,
      }),
    });
    await found.cancel();
    // Still listed until the next sync input, as on WASM.
    expect(olm.getVerificationRequests(bob())).toEqual([found]);
    await sync(olm);
    expect(olm.getVerificationRequest(bob(), FLOW)).toBeUndefined();
    expect(olm.getVerificationRequests(bob())).toEqual([]);
    // The held object still answers, as WASM's does.
    expect(found.isCancelled()).toBe(true);
  });

  it('is empty after a reload and after close', async () => {
    const { olm, crate, found } = await incoming({ trackedUsers: [] });
    expect(olm.getVerificationRequests(bob())).toEqual([found]);
    // The crate dropped the machine: its verifications lived in its memory.
    crate.panicOn.add('trackedUsers');
    await olm.trackedUsers();
    expect(sent(crate, 'init')).toHaveLength(2);
    expect(olm.getVerificationRequests(bob())).toEqual([]);
    const other = await incoming();
    other.olm.close();
    expect(other.olm.getVerificationRequests(bob())).toEqual([]);
  });

  it('replays verification reads after a reload, not calls that advance a flow', async () => {
    const { olm, crate, found } = await incoming({
      acceptVerificationRequest: null,
    });
    crate.panicOn.add('acceptVerificationRequest');
    await expect(found.acceptWithMethods([])).rejects.toMatchObject({
      code: 'Panic',
    });
    expect(sent(crate, 'acceptVerificationRequest')).toHaveLength(1);
    crate.panicOn.add('getVerificationRequest');
    await olm.receiveVerificationEvent(inRoomRequest, room());
    expect(sent(crate, 'getVerificationRequest')).toHaveLength(3);
    expect(olm.getVerificationRequest(bob(), FLOW)).toBeDefined();
  });
});

describe('lost events', () => {
  it('retries every session that failed to decrypt and reads verifications again', async () => {
    const answers: Record<string, Answer> = {
      decryptRoomEvent: () => ({
        error: {
          code: 'MegolmDecryptionError',
          message: 'missing key',
          details: { code: 0, description: 'missing' },
        },
      }),
    };
    const { olm, crate, found } = await incoming(answers);
    const retried = vi.fn();
    olm.registerRoomKeyUpdatedCallback(retried);
    const event = JSON.stringify({
      type: 'm.room.encrypted',
      content: {
        session_id: 'session-1',
        sender_key: 'mB7Ywmbd9WlFtWhT/4ZbVlUFkNmz04hxkx1bt+QBJ0E',
      },
    });
    await expect(
      olm.decryptRoomEvent(
        event,
        room(),
        new real.DecryptionSettings(real.TrustRequirement.Untrusted),
      ),
    ).rejects.toBeInstanceOf(real.MegolmDecryptionError);
    const changes = vi.fn();
    found.registerChangesCallback(changes);
    answers['getVerificationRequest'] = request({
      phase: real.VerificationRequestPhase.Ready,
    });
    crate.dropped = 3;
    await olm.trackedUsers().catch(() => undefined);
    expect(retried).toHaveBeenCalledTimes(1);
    const [[keys]] = retried.mock.calls as [[real.RoomKeyInfo[]]];
    expect(keys.map((key) => [key.roomId.toString(), key.sessionId])).toEqual([
      ['!dm:example.org', 'session-1'],
    ]);
    // The refresh is a call of its own; once it is answered, the missed change runs the callback.
    await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(1));
    expect(found.phase()).toBe(real.VerificationRequestPhase.Ready);
  });
});

describe('secrets bundles', () => {
  const bundle = {
    cross_signing: {
      master_key: 'master-seed',
      self_signing_key: 'self-seed',
      user_signing_key: 'user-seed',
    },
    backup: {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      key: 'backup-key',
      backup_version: '1',
    },
  };

  it('wraps the exported JSON: to_json gives it back, nothing prints it, free drops it', async () => {
    const { olm } = await machine({ exportSecretsBundle: bundle });
    const exported = await olm.exportSecretsBundle();
    expect(exported).toBeInstanceOf(real.SecretsBundle);
    expect(exported.to_json()).toEqual(bundle);
    for (const shown of [
      JSON.stringify(exported),
      inspect(exported, { depth: 5 }),
    ])
      expect(shown).not.toMatch(/seed|backup-key/);
    exported.free();
    expect(() => exported.to_json()).toThrow();
  });

  it('fails closed on a bundle without its seeds', async () => {
    const { olm } = await machine({
      exportSecretsBundle: { cross_signing: {} },
    });
    await expect(olm.exportSecretsBundle()).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
  });

  it('imports the to_json form and frees the bundle, as WASM consumes it', async () => {
    const { olm, crate } = await machine({ importSecretsBundle: null });
    const free = vi.fn();
    await olm.importSecretsBundle({
      to_json: () => bundle,
      free,
    } as unknown as real.SecretsBundle);
    expect(sent(crate, 'importSecretsBundle')[0]?.params).toEqual({ bundle });
    expect(free).toHaveBeenCalledTimes(1);
  });
});

/** What upstream's attachment encryptor reports, in the shape WASM's EncryptedAttachment parses. */
const MEDIA = JSON.stringify({
  v: 'v2',
  key: {
    kty: 'oct',
    key_ops: ['encrypt', 'decrypt'],
    alg: 'A256CTR',
    k: 'qcHVMSgYg-71CauWBezXI5qkaRb0LuIy-Wx5kIaHMIA',
    ext: true,
  },
  iv: 'X85+XgHN+HEAAAAAAAAAAA',
  hashes: { sha256: 'Rl5qMa0ghIJE6hnmhRMe8dNe8cDz6mQS2a6nApyfIx8' },
});

describe('room key bundles', () => {
  const data = {
    senderUser: BOB,
    roomId: '!dm:example.org',
    url: 'mxc://example.org/bundle',
    encryptionInfo: '{"key":"file-key"}',
  };

  it('hands out the bundle data with its file key hidden, and receives by room, inviter and URL', async () => {
    const { olm, crate } = await machine({
      getReceivedRoomKeyBundleData: data,
      receiveRoomKeyBundle: null,
    });
    const found = (await olm.getReceivedRoomKeyBundleData(room(), bob()))!;
    expect(found).toBeInstanceOf(real.StoredRoomKeyBundleData);
    expect(found.url).toBe(data.url);
    expect(found.senderUser.toString()).toBe(BOB);
    expect(found.encryptionInfo).toBe(data.encryptionInfo);
    expect(JSON.stringify(found)).not.toContain('file-key');
    expect(inspect(found)).not.toContain('file-key');
    await olm.receiveRoomKeyBundle(found, new Uint8Array([0, 1, 254, 255]));
    expect(sent(crate, 'receiveRoomKeyBundle')[0]?.params).toEqual({
      roomId: data.roomId,
      inviter: BOB,
      url: data.url,
      encryptedBundle: 'AAH+/w==',
    });
  });

  it('builds the attachment, shares it by strategy name and tracks the download flag', async () => {
    const { olm, crate } = await machine({
      buildRoomKeyBundle: {
        encryptedData: 'AAH+/w==',
        mediaEncryptionInfo: MEDIA,
      },
      shareRoomKeyBundleData: [toDevice],
      hasDownloadedAllRoomKeys: false,
      setHasDownloadedAllRoomKeys: null,
    });
    const built = (await olm.buildRoomKeyBundle(room()))!;
    expect(built).toBeInstanceOf(real.EncryptedAttachment);
    expect([...built.encryptedData]).toEqual([0, 1, 254, 255]);
    const requests = await olm.shareRoomKeyBundleData(
      bob(),
      room(),
      'mxc://example.org/bundle',
      '{}',
      real.CollectStrategy.identityBasedStrategy(),
    );
    expect(requests[0]).toBeInstanceOf(real.ToDeviceRequest);
    expect(sent(crate, 'shareRoomKeyBundleData')[0]?.params).toMatchObject({
      sharingStrategy: 'identityBasedStrategy',
      url: 'mxc://example.org/bundle',
    });
    expect(await olm.hasDownloadedAllRoomKeys(room())).toBe(false);
    await olm.setHasDownloadedAllRoomKeys(room());
    expect(sent(crate, 'setHasDownloadedAllRoomKeys')[0]?.params).toEqual({
      roomId: '!dm:example.org',
    });
  });
});

describe('dehydrated devices', () => {
  it('creates in one call on keysForUpload, once per object', async () => {
    const { olm, crate } = await machine({
      createDehydratedDevice: { body: '{"device_id":"D"}' },
    });
    const devices = olm.dehydratedDevices();
    expect(devices).toBeInstanceOf(real.DehydratedDevices);
    const device = await devices.create();
    expect(device).toBeInstanceOf(real.DehydratedDevice);
    expect(sent(crate, 'createDehydratedDevice')).toEqual([]);
    const key = real.DehydratedDeviceKey.createRandomKey();
    const upload = await device.keysForUpload('Dehydrated device', key);
    expect(upload).toBeInstanceOf(real.PutDehydratedDeviceRequest);
    expect(upload.body).toBe('{"device_id":"D"}');
    expect(sent(crate, 'createDehydratedDevice')[0]?.params).toEqual({
      initialDeviceDisplayName: 'Dehydrated device',
      dehydratedDeviceKey: key.toBase64(),
    });
    await expect(device.keysForUpload('again', key)).rejects.toMatchObject({
      code: 'InvalidRequest',
    });
    expect(sent(crate, 'createDehydratedDevice')).toHaveLength(1);
  });

  it('rehydrates, feeds events to the held device and drops it on free', async () => {
    const key = real.DehydratedDeviceKey.createRandomKey();
    const { olm, crate } = await machine({
      getDehydratedDeviceKey: key.toBase64(),
      saveDehydratedDeviceKey: null,
      rehydrateDevice: null,
      receiveRehydratedEvents: [
        {
          algorithm: 1,
          roomId: '!dm:example.org',
          senderKey: 'mB7Ywmbd9WlFtWhT/4ZbVlUFkNmz04hxkx1bt+QBJ0E',
          sessionId: 'session-1',
        },
      ],
      dropRehydratedDevice: null,
    });
    const devices = olm.dehydratedDevices();
    const cached = (await devices.getDehydratedDeviceKey())!;
    expect(cached).toBeInstanceOf(real.DehydratedDeviceKey);
    expect(cached.toBase64()).toBe(key.toBase64());
    await devices.saveDehydratedDeviceKey(key);
    expect(sent(crate, 'saveDehydratedDeviceKey')[0]?.params).toEqual({
      dehydratedDeviceKey: key.toBase64(),
    });
    const device = await devices.rehydrate(key, new real.DeviceId('D'), '{}');
    expect(device).toBeInstanceOf(real.RehydratedDevice);
    expect(sent(crate, 'rehydrateDevice')[0]?.params).toEqual({
      dehydratedDeviceKey: key.toBase64(),
      deviceId: 'D',
      deviceData: '{}',
    });
    const keys = await device.receiveEvents('[]');
    expect(keys[0]).toBeInstanceOf(real.RoomKeyInfo);
    expect(keys[0]!.sessionId).toBe('session-1');
    expect(sent(crate, 'receiveRehydratedEvents')[0]?.params).toEqual({
      deviceId: 'D',
      toDeviceEvents: '[]',
    });
    device.free();
    await vi.waitFor(() =>
      expect(sent(crate, 'dropRehydratedDevice')[0]?.params).toEqual({
        deviceId: 'D',
      }),
    );
  });
});

describe('QR codes', () => {
  it('reads the bytes only when asked and sends scanned bytes as base64', async () => {
    const answers: Record<string, Answer> = { qrCodeBytes: 'AAH+/w==' };
    const { crate, found } = await incoming(answers);
    answers['scanQrCode'] = withEvents(
      crate,
      qr({ state: real.QrState.Reciprocated }),
      {
        type: 'verificationRequestChanged',
        request: transitioned(qr({ state: real.QrState.Reciprocated })),
      },
    );
    // As matrix-js-sdk calls it through the repository's patch: the bytes beside the scan.
    const scan = found.scanQrCode as unknown as (
      scan: unknown,
      bytes: Uint8ClampedArray,
    ) => Promise<real.Qr>;
    const scanned = await scan.call(
      found,
      undefined,
      new Uint8ClampedArray([0, 1, 254, 255]),
    );
    expect(sent(crate, 'scanQrCode')[0]?.params).toEqual({
      userId: BOB,
      flowId: FLOW,
      data: 'AAH+/w==',
    });
    expect(scanned.state()).toBe(real.QrState.Reciprocated);
    expect(sent(crate, 'qrCodeBytes')).toEqual([]);
    const bytes = await scanned.toBytes();
    expect(bytes).toBeInstanceOf(Uint8ClampedArray);
    expect([...bytes]).toEqual([0, 1, 254, 255]);
  });
});
