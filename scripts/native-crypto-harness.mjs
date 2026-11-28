/**
 * Shared by the native crypto interop and contract tests: the crate's JSON-lines CLI and the
 * WASM package as two kinds of device with one interface, a tiny homeserver between them, and
 * `covered`, which ties a test case to entries of native/crypto/surface.json.
 *
 * Without cargo on PATH the suites are skipped and say why; in CI (`CI` set) a missing cargo
 * fails instead, so the job cannot pass without running them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';

const root = resolve(import.meta.dirname, '..');
export const hasCargo = spawnSync('cargo', ['--version']).status === 0;
if (!hasCargo && process.env.CI) {
  throw new Error('The native crypto tests need cargo in CI.');
}
export const skipped = hasCargo ? '' : ' (skipped: cargo is not on PATH)';
if (!hasCargo) {
  console.warn(`native crypto tests${skipped}; install Rust to run them.`);
}

/** Builds the CLI (incrementally) and returns its path, or fails with cargo's output. */
const buildCli = () => {
  const manifest = resolve(root, 'native/crypto/Cargo.toml');
  const args = ['build', '--locked', '--bin', 'trinity-crypto-cli'];
  const result = spawnSync(
    'cargo',
    [
      ...args,
      '--manifest-path',
      manifest,
      '--message-format=json-render-diagnostics',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `cargo build of native/crypto failed:\n${result.stderr.slice(-4000)}`,
    );
  }
  const executable = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .find(
      (message) =>
        message.target?.name === 'trinity-crypto-cli' && message.executable,
    )?.executable;
  if (!executable)
    throw new Error('cargo build did not report the trinity-crypto-cli binary');
  return executable;
};

/** Native answer objects (and every object inside one) → the native method that answered. */
const answerOf = new WeakMap();
const claim = (method, node) => {
  if (!node || typeof node !== 'object' || answerOf.has(node)) return;
  answerOf.set(node, method);
  for (const child of Object.values(node)) claim(method, child);
};

/** Per running `both`/`each` step and device: the native calls made, with their results. */
const frames = [];

/**
 * The native methods whose own answers `value` holds: any object a call returned (or that is
 * inside one), or, when `value` is a primitive, the one call of the step that returned it.
 */
const answered = (value, calls = []) => {
  const methods = new Set();
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const method = answerOf.get(node);
    if (method) methods.add(method);
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  if (value === null || typeof value !== 'object') {
    const same = calls.filter((call) => call.result === value);
    if (same.length === 1) methods.add(same[0].method);
  }
  return methods;
};

/** Answers of `both`/`each` → the native methods whose answers they hold. */
const answersOf = new WeakMap();
/** The native methods whose answers reached a comparison in the current `covered` case. */
const comparedCalls = new Set();

/** Runs `run` on each device in turn (native first) and keeps the raw answers. */
const stepOn = async (devices, run, map) => {
  const answers = [];
  const methods = new Set();
  for (const device of devices) {
    const calls = [];
    frames.push(calls);
    let value;
    try {
      value = await run(device);
    } finally {
      frames.splice(frames.indexOf(calls), 1);
    }
    for (const method of answered(value, calls)) methods.add(method);
    answers.push(map(value, device));
  }
  answersOf.set(answers, methods);
  return answers;
};

/** Runs the same step on each device (native first), with each device's own IDs replaced. */
export const both = (devices, run) => stepOn(devices, run, anonymise);

/** Runs the same step on each device (native first) and returns the raw answers. */
export const each = (devices, run) => stepOn(devices, run, (value) => value);

/**
 * Compares the native answer (first) with WASM's, both through `view` (answer, index), and
 * counts every native call whose own answer the compared answers hold. Answers made by
 * `both`/`each`, or holding native answer objects, count; a value computed from an answer
 * does not.
 */
export const expectSame = (answers, step, view = (answer) => answer) => {
  const [native, other] = answers.map((answer, index) => view(answer, index));
  expect(native, step).toEqual(other);
  for (const source of [answers, ...answers]) {
    if (source && typeof source === 'object') {
      for (const method of answersOf.get(source) ?? [])
        comparedCalls.add(method);
    }
  }
  for (const method of answered(answers)) comparedCalls.add(method);
};

const startCli = (executable) => {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  return {
    async call(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const { value, done } = await lines.next();
      if (done) throw new Error('trinity-crypto-cli exited');
      const response = JSON.parse(value);
      claim(request.method, response);
      for (const calls of frames) {
        calls.push({ method: request.method, result: response.result });
      }
      return response;
    },
    stop: () => child.stdin.end(),
  };
};

const surface = JSON.parse(
  readFileSync(resolve(root, 'native/crypto/surface.json'), 'utf8'),
);

/**
 * A test case for the surface entries it lists (`Class.member`), which
 * scripts/native-crypto-surface.spec.mjs reads statically. The case fails unless the answer of
 * each entry's native method reached a comparison with WASM (`expectSame`, or
 * `expectSameRequests` for the requests the homeserver saw), so neither setup calls nor calls
 * whose answer is dropped count.
 */
export const covered = (entries, title, run, timeout) =>
  it(`${title} [${entries.join(', ')}]`, { timeout }, async () => {
    comparedCalls.clear();
    await run();
    for (const entry of entries) {
      const [owner, member] = entry.split('.');
      const { native } = surface.stateful[owner]?.[member] ?? {};
      expect(
        comparedCalls.has(native),
        `${entry}: the answer of native ${native} is compared with WASM`,
      ).toBe(true);
    }
  });

const REQUEST_FIELDS = [
  'id',
  'type',
  'body',
  'event_type',
  'txn_id',
  'room_id',
  'version',
];
export const plain = (request) =>
  Object.fromEntries(
    REQUEST_FIELDS.filter((field) => request[field] !== undefined).map(
      (field) => [field, request[field]],
    ),
  );

const decryptionSettings = {
  sender_device_trust_requirement: wasm.TrustRequirement.Untrusted,
};

/**
 * Events grouped by type, each type in arrival order, so the comparison holds only what is
 * guaranteed. Within a type the order is fixed on both sides: WASM awaits each callback before
 * the next item of its stream, and native queues a stream's items in order. Across types
 * nothing is: WASM runs each callback registration on its own promise chain, so native's queue
 * order between types is not compared.
 */
const byType = (response) => {
  const events = response.result?.events;
  if (events) {
    const types = [...new Set(events.map(({ type }) => type))].sort();
    response.result.events = types.flatMap((type) =>
      events.filter((event) => event.type === type),
    );
  }
  return response;
};

/** Drops `undefined` fields, as the native JSON leaves them out. */
export const defined = (value) => JSON.parse(JSON.stringify(value));

const nativeDevice = async (cli, userId, deviceId) => {
  const respond = (method, params = {}) =>
    cli.call({ method, userId, deviceId, params });
  const call = async (method, params) => {
    const response = await respond(method, params);
    if (response.error)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const description = await call('init');
  let closed = false;
  return {
    kind: 'native',
    userId,
    deviceId,
    identityKeys: description.identityKeys,
    description,
    respond,
    outgoingRequests: () => call('outgoingRequests'),
    // The whole answer, so a comparison of it counts (scripts/native-crypto-harness.mjs).
    markRequestAsSent: async (requestId, requestType, response) => {
      const answer = await respond('markRequestAsSent', {
        requestId,
        requestType,
        response,
      });
      if (answer.error)
        throw new Error(`markRequestAsSent: ${JSON.stringify(answer.error)}`);
      return answer;
    },
    receiveSyncChanges: (toDeviceEvents, oneTimeKeysCounts) =>
      call('receiveSyncChanges', {
        toDeviceEvents,
        changedDevices: { changed: [], left: [] },
        oneTimeKeysCounts,
        unusedFallbackKeys: [],
      }),
    receiveSyncChangesMsc4186: (toDeviceEvents, oneTimeKeysCounts) =>
      respond('receiveSyncChangesMsc4186', {
        toDeviceEvents,
        changedDevices: { changed: [], left: [] },
        oneTimeKeysCounts,
        unusedFallbackKeys: [],
      }),
    updateTrackedUsers: (users) => call('updateTrackedUsers', { users }),
    getMissingSessions: (users) => call('getMissingSessions', { users }),
    shareRoomKey: (roomId, users, sharingStrategy, historyVisibility) =>
      call('shareRoomKey', {
        roomId,
        users,
        encryptionSettings: defined({ sharingStrategy, historyVisibility }),
      }),
    encryptStateEvent: (roomId, eventType, stateKey, content) =>
      respond('encryptStateEvent', { roomId, eventType, stateKey, content }),
    invalidateGroupSession: (roomId) =>
      respond('invalidateGroupSession', { roomId }),
    getRoomSettings: (roomId) => respond('getRoomSettings', { roomId }),
    setRoomSettings: (roomId, roomSettings) =>
      respond('setRoomSettings', { roomId, roomSettings }),
    roomKeyRequestsEnabled: (enabled) =>
      respond('roomKeyRequestsEnabled', defined({ enabled })),
    getSecretsFromInbox: (secretName) =>
      respond('getSecretsFromInbox', { secretName }),
    deleteSecretsFromInbox: (secretName) =>
      respond('deleteSecretsFromInbox', { secretName }),
    pushSecretToVerifiedDevices: (secretName) =>
      respond('pushSecretToVerifiedDevices', { secretName }),
    exportSecretsBundle: () => respond('exportSecretsBundle'),
    importSecretsBundle: (bundle) => respond('importSecretsBundle', { bundle }),
    buildRoomKeyBundle: (roomId) => respond('buildRoomKeyBundle', { roomId }),
    shareRoomKeyBundleData: (user, roomId, url, info, sharingStrategy) =>
      respond(
        'shareRoomKeyBundleData',
        defined({
          userId: user,
          roomId,
          url,
          mediaEncryptionInfo: info,
          sharingStrategy,
        }),
      ),
    getReceivedRoomKeyBundleData: (roomId, inviter) =>
      respond('getReceivedRoomKeyBundleData', { roomId, inviter }),
    // The shim passes the fields of the bundle data it was handed.
    receiveRoomKeyBundle: (data, encryptedBundle) =>
      respond('receiveRoomKeyBundle', {
        roomId: data.roomId,
        inviter: data.senderUser,
        url: data.url,
        encryptedBundle,
      }),
    getPendingKeyBundleDetailsForRoom: (roomId) =>
      respond('getPendingKeyBundleDetailsForRoom', { roomId }),
    getAllRoomsPendingKeyBundles: () => respond('getAllRoomsPendingKeyBundles'),
    storeRoomPendingKeyBundle: (roomId, inviter) =>
      respond('storeRoomPendingKeyBundle', { roomId, inviter }),
    clearRoomPendingKeyBundle: (roomId) =>
      respond('clearRoomPendingKeyBundle', { roomId }),
    hasDownloadedAllRoomKeys: (roomId) =>
      respond('hasDownloadedAllRoomKeys', { roomId }),
    setHasDownloadedAllRoomKeys: (roomId) =>
      respond('setHasDownloadedAllRoomKeys', { roomId }),
    createDehydratedDevice: (initialDeviceDisplayName, dehydratedDeviceKey) =>
      respond('createDehydratedDevice', {
        initialDeviceDisplayName,
        dehydratedDeviceKey,
      }),
    getDehydratedDeviceKey: () => respond('getDehydratedDeviceKey'),
    saveDehydratedDeviceKey: (dehydratedDeviceKey) =>
      respond('saveDehydratedDeviceKey', { dehydratedDeviceKey }),
    rehydrateDevice: (dehydratedDeviceKey, id, deviceData) =>
      respond('rehydrateDevice', {
        dehydratedDeviceKey,
        deviceId: id,
        deviceData,
      }),
    receiveRehydratedEvents: (id, toDeviceEvents) =>
      respond('receiveRehydratedEvents', { deviceId: id, toDeviceEvents }),
    dropRehydratedDevice: (id) =>
      respond('dropRehydratedDevice', { deviceId: id }),
    encryptRoomEvent: (roomId, eventType, content) =>
      call('encryptRoomEvent', { roomId, eventType, content }),
    decryptRoomEvent: (event, roomId) =>
      respond('decryptRoomEvent', { event, roomId, decryptionSettings }),
    getRoomEventEncryptionInfo: (event, roomId) =>
      respond('getRoomEventEncryptionInfo', { event, roomId }),
    pollEvents: async () => byType(await respond('pollEvents')),
    exportRoomKeys: () => respond('exportRoomKeys'),
    importExportedRoomKeys: (exportedRoomKeys) =>
      respond('importExportedRoomKeys', { exportedRoomKeys }),
    importBackedUpRoomKeys: (backedUpRoomKeys, backupVersion) =>
      respond('importBackedUpRoomKeys', { backedUpRoomKeys, backupVersion }),
    roomKeyCounts: () => respond('roomKeyCounts'),
    backupRoomKeys: () => respond('backupRoomKeys'),
    getBackupKeys: () => respond('getBackupKeys'),
    saveBackupDecryptionKey: (decryptionKeyBase64, version) =>
      respond('saveBackupDecryptionKey', { decryptionKeyBase64, version }),
    enableBackupV1: (publicKeyBase64, version) =>
      respond('enableBackupV1', { publicKeyBase64, version }),
    disableBackup: () => respond('disableBackup'),
    isBackupEnabled: () => respond('isBackupEnabled'),
    verifyBackup: (backupInfo) => respond('verifyBackup', { backupInfo }),
    sign: (message) => respond('sign', { message }),
    trackedUsers: () => respond('trackedUsers'),
    markAllTrackedUsersAsDirty: () => respond('markAllTrackedUsersAsDirty'),
    queryKeysForUsers: (users) => respond('queryKeysForUsers', { users }),
    getDevice: (user, id) =>
      respond('getDevice', { userId: user, deviceId: id }),
    // Native answers in no order, WASM sorted below: the shim keys them by device ID.
    getUserDevices: async (user) => {
      const answer = await respond('getUserDevices', { userId: user });
      answer.result?.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
      return answer;
    },
    getIdentity: (user) => respond('getIdentity', { userId: user }),
    setLocalTrust: (user, id, localState) =>
      respond('setLocalTrust', { userId: user, deviceId: id, localState }),
    verifyDevice: (user, id) =>
      respond('verifyDevice', { userId: user, deviceId: id }),
    encryptToDeviceEvent: (user, id, eventType, content) =>
      respond('encryptToDeviceEvent', {
        userId: user,
        deviceId: id,
        eventType,
        content,
      }),
    verifyIdentity: (user) => respond('verifyIdentity', { userId: user }),
    withdrawVerification: (user) =>
      respond('withdrawVerification', { userId: user }),
    pinCurrentMasterKey: (user) =>
      respond('pinCurrentMasterKey', { userId: user }),
    bootstrapCrossSigning: (reset) =>
      respond('bootstrapCrossSigning', { reset }),
    crossSigningStatus: () => respond('crossSigningStatus'),
    exportCrossSigningKeys: () => respond('exportCrossSigningKeys'),
    importCrossSigningKeys: (keys) => respond('importCrossSigningKeys', keys),
    // Verification: the other user and the flow ID address each object.
    getVerificationRequest: (user, flowId) =>
      respond('getVerificationRequest', { userId: user, flowId }),
    getVerificationRequests: (user) =>
      respond('getVerificationRequests', { userId: user }),
    getVerification: (user, flowId) =>
      respond('getVerification', { userId: user, flowId }),
    receiveVerificationEvent: (event, roomId) =>
      respond('receiveVerificationEvent', { event, roomId }),
    requestDeviceVerification: (user, id, methods, ed25519Key) =>
      respond(
        'requestDeviceVerification',
        defined({ userId: user, deviceId: id, methods, ed25519Key }),
      ),
    requestIdentityVerification: (params) =>
      respond('requestIdentityVerification', defined(params)),
    verificationRequestContent: (user, methods) =>
      respond('verificationRequestContent', defined({ userId: user, methods })),
    acceptVerificationRequest: (user, flowId, methods) =>
      respond(
        'acceptVerificationRequest',
        defined({ userId: user, flowId, methods }),
      ),
    cancelVerificationRequest: (user, flowId) =>
      respond('cancelVerificationRequest', { userId: user, flowId }),
    startSas: (user, flowId) => respond('startSas', { userId: user, flowId }),
    generateQrCode: (user, flowId) =>
      respond('generateQrCode', { userId: user, flowId }),
    scanQrCode: (user, flowId, data) =>
      respond('scanQrCode', { userId: user, flowId, data }),
    acceptSas: (user, flowId) => respond('acceptSas', { userId: user, flowId }),
    confirmSas: (user, flowId, decimals) =>
      respond('confirmSas', defined({ userId: user, flowId, decimals })),
    cancelSas: (user, flowId, code) =>
      respond('cancelSas', defined({ userId: user, flowId, code })),
    cancelQr: (user, flowId, code) =>
      respond('cancelQr', defined({ userId: user, flowId, code })),
    confirmQrScanning: (user, flowId) =>
      respond('confirmQrScanning', { userId: user, flowId }),
    reciprocateQr: (user, flowId) =>
      respond('reciprocateQr', { userId: user, flowId }),
    qrCodeBytes: (user, flowId) =>
      respond('qrCodeBytes', { userId: user, flowId }),
    async close() {
      if (!closed) await call('close');
      closed = true;
    },
  };
};

/** The WASM getters, read into the native crate's JSON shapes (native/crypto/README.md). */
export const fromWasm = {
  shield: ({ color, code, message }) => ({ color, code, message }),
  encryptionInfo: (info) => ({
    sender: info.sender.toString(),
    senderDevice: info.senderDevice?.toString(),
    forwarder: info.forwarder?.toString(),
    forwarderDevice: info.forwarderDevice?.toString(),
    senderCurve25519Key: info.senderCurve25519Key,
    senderClaimedEd25519Key: info.senderClaimedEd25519Key,
    shieldState: {
      lax: fromWasm.shield(info.shieldState(false)),
      strict: fromWasm.shield(info.shieldState(true)),
    },
  }),
  decrypted: (decrypted) => ({
    ...fromWasm.encryptionInfo(decrypted),
    event: decrypted.event,
    forwardingCurve25519KeyChain: decrypted.forwardingCurve25519KeyChain,
  }),
  error: (error) =>
    error instanceof wasm.MegolmDecryptionError
      ? {
          code: 'MegolmDecryptionError',
          message: error.description,
          details: {
            code: error.code,
            description: error.description,
            withheldCode: error.withheldCode,
            maybe_withheld: error.maybe_withheld,
          },
        }
      : { code: 'CryptoError', message: String(error.message ?? error) },
  toDevice: (event) => ({
    type: event.type,
    rawEvent: event.rawEvent,
    encryptionInfo: event.encryptionInfo && {
      senderCurve25519Key: event.encryptionInfo.senderCurve25519Key,
      sender: event.encryptionInfo.sender.toString(),
      senderDevice: event.encryptionInfo.senderDevice?.toString(),
      isSenderVerified: event.encryptionInfo.isSenderVerified(),
    },
    utdInfo: event.utdInfo && { reason: event.utdInfo.reason },
  }),
  importResult: (result, lastProgress) => ({
    importedCount: result.importedCount,
    totalCount: result.totalCount,
    keys: Object.fromEntries(
      [...result.keys()].map(([room, senders]) => [
        room,
        Object.fromEntries(
          [...senders].map(([sender, sessions]) => [sender, [...sessions]]),
        ),
      ]),
    ),
    lastProgress,
  }),
  roomKeyInfo: (info) => ({
    algorithm: info.algorithm,
    roomId: info.roomId.toString(),
    senderKey: info.senderKey.toBase64(),
    sessionId: info.sessionId,
  }),
  withheldInfo: (info) => ({
    sender: info.sender.toString(),
    algorithm: info.algorithm,
    withheldCode: info.withheldCode,
    roomId: info.roomId.toString(),
    sessionId: info.sessionId,
  }),
  /** A `Device` snapshot: every getter matrix-js-sdk reads, plus the trust state. */
  device: (device) => ({
    userId: device.userId.toString(),
    deviceId: device.deviceId.toString(),
    displayName: device.displayName,
    keys: Object.fromEntries(
      [...device.keys].map(([id, key]) => [id.toString(), key.toBase64()]),
    ),
    algorithms: device.algorithms,
    signatures: Object.fromEntries(
      Object.keys(JSON.parse(device.signatures.asJSON())).map((signer) => [
        signer,
        Object.fromEntries(
          [...device.signatures.get(new wasm.UserId(signer))].map(
            ([id, maybe]) => [
              id,
              {
                isValid: maybe.isValid(),
                signature: maybe.signature?.toBase64(),
                invalidSignatureSource: maybe.invalidSignatureSource,
              },
            ],
          ),
        ),
      ]),
    ),
    isVerified: device.isVerified(),
    isCrossSigningTrusted: device.isCrossSigningTrusted(),
    isCrossSignedByOwner: device.isCrossSignedByOwner(),
    isLocallyTrusted: device.isLocallyTrusted(),
    isBlacklisted: device.isBlacklisted(),
    localTrustState: device.localTrustState,
    isDeleted: device.isDeleted(),
    isDehydrated: device.isDehydrated,
  }),
  /** An `OwnUserIdentity` or `OtherUserIdentity` snapshot. */
  identity: (identity) => {
    const own = identity instanceof wasm.OwnUserIdentity;
    return {
      kind: own ? 'own' : 'other',
      isVerified: identity.isVerified(),
      wasPreviouslyVerified: identity.wasPreviouslyVerified(),
      hasVerificationViolation: identity.hasVerificationViolation(),
      masterKey: identity.masterKey,
      selfSigningKey: identity.selfSigningKey,
      ...(own
        ? { userSigningKey: identity.userSigningKey }
        : { identityNeedsUserApproval: identity.identityNeedsUserApproval() }),
    };
  },
  cancelInfo: (info) =>
    info && {
      cancelCode: info.cancelCode(),
      reason: info.reason(),
      cancelledbyUs: info.cancelledbyUs(),
    },
  /** A `VerificationRequest` snapshot: every getter, `timeRemainingMillis` as a deadline. */
  verificationRequest: (request) =>
    defined({
      kind: 'request',
      ownUserId: request.ownUserId.toString(),
      otherUserId: request.otherUserId.toString(),
      flowId: request.flowId,
      phase: request.phase(),
      isPassive: request.isPassive(),
      isReady: request.isReady(),
      isDone: request.isDone(),
      isCancelled: request.isCancelled(),
      isSelfVerification: request.isSelfVerification(),
      weStarted: request.weStarted(),
      timedOut: request.timedOut(),
      expiresAtMs: Date.now() + request.timeRemainingMillis(),
      otherDeviceId: request.otherDeviceId?.toString(),
      roomId: request.roomId?.toString(),
      cancelInfo: fromWasm.cancelInfo(request.cancelInfo),
      // The getter throws on a method WASM does not know.
      theirSupportedMethods: (() => {
        try {
          return request.theirSupportedMethods;
        } catch (error) {
          return { throws: String(error.message ?? error) };
        }
      })(),
      ourSupportedMethods: request.ourSupportedMethods,
      verification: fromWasm.verification(request.getVerification()),
    }),
  /** A `Sas` or `Qr` snapshot, or `undefined`. */
  verification: (verification) => {
    if (verification instanceof wasm.Sas) return fromWasm.sas(verification);
    if (verification instanceof wasm.Qr) return fromWasm.qr(verification);
    return undefined;
  },
  sas: (sas) =>
    defined({
      kind: 'sas',
      userId: sas.userId.toString(),
      deviceId: sas.deviceId.toString(),
      otherUserId: sas.otherUserId.toString(),
      otherDeviceId: sas.otherDeviceId.toString(),
      flowId: sas.flowId,
      supportsEmoji: sas.supportsEmoji(),
      startedFromRequest: sas.startedFromRequest(),
      isSelfVerification: sas.isSelfVerification(),
      haveWeConfirmed: sas.haveWeConfirmed(),
      hasBeenAccepted: sas.hasBeenAccepted(),
      weStarted: sas.weStarted(),
      timedOut: sas.timedOut(),
      canBePresented: sas.canBePresented(),
      isDone: sas.isDone(),
      isCancelled: sas.isCancelled(),
      roomId: sas.roomId?.toString(),
      cancelInfo: fromWasm.cancelInfo(sas.cancelInfo()),
      emoji: sas
        .emoji()
        ?.map(({ symbol, description }) => ({ symbol, description })),
      emojiIndex: sas.emojiIndex() && [...sas.emojiIndex()],
      decimals: sas.decimals() && [...sas.decimals()],
    }),
  qr: (qr) =>
    defined({
      kind: 'qr',
      state: qr.state(),
      hasBeenScanned: qr.hasBeenScanned(),
      hasBeenConfirmed: qr.hasBeenConfirmed(),
      userId: qr.userId.toString(),
      otherUserId: qr.otherUserId.toString(),
      otherDeviceId: qr.otherDeviceId.toString(),
      weStarted: qr.weStarted(),
      isDone: qr.isDone(),
      isCancelled: qr.isCancelled(),
      isSelfVerification: qr.isSelfVerification(),
      reciprocated: qr.reciprocated(),
      flowId: qr.flowId,
      roomId: qr.roomId?.toString(),
      cancelInfo: fromWasm.cancelInfo(qr.cancelInfo()),
    }),
  /** An outgoing verification request (`ToDeviceRequest` or `RoomMessageRequest`), or null. */
  outgoing: (request) => (request ? plain(request) : null),
  pendingBundle: (details) => ({
    roomId: details.roomId.toString(),
    inviterId: details.inviterId.toString(),
    inviteAcceptedAtMillis: details.inviteAcceptedAtMillis,
  }),
  crossSigningStatus: ({ hasMaster, hasSelfSigning, hasUserSigning }) => ({
    hasMaster,
    hasSelfSigning,
    hasUserSigning,
  }),
  /** `{ result }` or `{ error }`, as a native call answers. */
  async response(run, map = (result) => result ?? null) {
    try {
      return defined({ result: map(await run()) });
    } catch (error) {
      return defined({ error: fromWasm.error(error) });
    }
  },
};

const wasmDevice = async (userId, deviceId) => {
  const machine = await wasm.OlmMachine.initialize(
    new wasm.UserId(userId),
    new wasm.DeviceId(deviceId),
  );
  const users = (list) => list.map((user) => new wasm.UserId(user));
  const room = (roomId) => new wasm.RoomId(roomId);
  // The callbacks stand in for the native queue.
  const events = [];
  machine.registerRoomKeyUpdatedCallback(async (infos) => {
    events.push({
      type: 'roomKeysReceived',
      keys: infos.map(fromWasm.roomKeyInfo),
    });
  });
  machine.registerRoomKeysWithheldCallback(async (infos) => {
    events.push({
      type: 'roomKeysWithheld',
      keys: infos.map(fromWasm.withheldInfo),
    });
  });
  machine.registerUserIdentityUpdatedCallback(async (userId) => {
    events.push({ type: 'userIdentityUpdated', userId: userId.toString() });
  });
  machine.registerDevicesUpdatedCallback(async (userIds) => {
    events.push({ type: 'devicesUpdated', userIds: [...userIds].sort() });
  });
  // WASM also passes the value, which matrix-js-sdk ignores; the native event has the name only.
  const secretValues = [];
  machine.registerReceiveSecretCallback(async (name, value) => {
    events.push({ type: 'secretReceived', name });
    secretValues.push(value);
  });
  /** The `RehydratedDevice` held, as matrix-js-sdk holds it until `free()`. */
  let rehydrated;
  const dehydrationKey = (base64) =>
    wasm.DehydratedDeviceKey.createKeyFromArray(
      new Uint8Array(Buffer.from(base64, 'base64')),
    );
  const withDehydratedDevices = async (run) => {
    const devices = machine.dehydratedDevices();
    try {
      return await run(devices);
    } finally {
      devices.free();
    }
  };
  // WASM runs change callbacks on its own promise chain, some time after the call. The
  // native crate queues a call's events before it returns: let the callbacks run first, so
  // both see the objects as the call left them.
  const callbacksRun = () => new Promise((done) => setTimeout(done, 0));
  const respond = async (run, map) => {
    const answer = await fromWasm.response(run, map);
    await callbacksRun();
    return answer;
  };
  // WASM's object methods; native resolves the object by its keys on each call.
  const onDevice = async (user, id) => {
    const found = await machine.getDevice(
      new wasm.UserId(user),
      new wasm.DeviceId(id),
    );
    if (!found) throw new Error(`unknown device ${user} ${id}`);
    return found;
  };
  const onIdentity = async (user) => {
    const found = await machine.getIdentity(new wasm.UserId(user));
    if (!found) throw new Error(`unknown identity ${user}`);
    return found;
  };
  // Verification objects as matrix-js-sdk holds them: the request first seen for a flow, and
  // the latest Sas or Qr (matrix-js-sdk switches its verifier when the request changes). Change
  // callbacks follow the native crate's watches: one live callback per object key, replaced
  // when the object is handed out again or its request changes while it holds one, and ended
  // with the object. (A replaced object gets no more events, so nothing else needs ending.)
  const held = new Map();
  const live = new Map();
  const heldKey = (user, flowId, kind) => `${user}|${flowId}|${kind}`;
  const kindOf = (object) =>
    object instanceof wasm.VerificationRequest
      ? 'request'
      : object instanceof wasm.Sas
        ? 'sas'
        : 'qr';
  const over = (object) => object.isDone() || object.isCancelled();
  const seen = (object) => {
    if (!object) return object;
    const kind = kindOf(object);
    const user = object.otherUserId.toString();
    const flowId = object.flowId;
    const watchKey = `${user}|${flowId}|${kind === 'request'}`;
    if (kind !== 'request' || !held.has(heldKey(user, flowId, kind)))
      held.set(heldKey(user, flowId, kind), object);
    if (over(object)) return object;
    const token = {};
    live.set(watchKey, token);
    object.registerChangesCallback(async () => {
      if (live.get(watchKey) !== token) return;
      if (kind === 'request') {
        events.push({
          type: 'verificationRequestChanged',
          request: fromWasm.verificationRequest(object),
        });
        if (over(object)) {
          live.delete(watchKey);
        } else if (object.getVerification()) {
          seen(object.getVerification());
        }
      } else {
        events.push({
          type: 'verificationChanged',
          verification: fromWasm.verification(object),
        });
        if (over(object)) live.delete(watchKey);
      }
    });
    return object;
  };
  const userIdOf = (user) => new wasm.UserId(user);
  const onRequest = (user, flowId) => {
    const found =
      held.get(heldKey(user, flowId, 'request')) ??
      machine.getVerificationRequest(userIdOf(user), flowId);
    if (!found) throw new Error(`unknown verification request ${flowId}`);
    return seen(found);
  };
  const onVerification = (kind, type) => (user, flowId) => {
    const found =
      held.get(heldKey(user, flowId, kind)) ??
      machine.getVerification(userIdOf(user), flowId);
    if (!(found instanceof type)) throw new Error(`no ${kind} for ${flowId}`);
    return seen(found);
  };
  const onSas = onVerification('sas', wasm.Sas);
  const onQr = onVerification('qr', wasm.Qr);
  const outgoing = fromWasm.outgoing;
  let closed = false;
  return {
    kind: 'wasm',
    userId,
    deviceId,
    machine,
    identityKeys: {
      ed25519: machine.identityKeys.ed25519.toBase64(),
      curve25519: machine.identityKeys.curve25519.toBase64(),
    },
    outgoingRequests: async () => (await machine.outgoingRequests()).map(plain),
    markRequestAsSent: async (id, type, response) => {
      const result = await machine.markRequestAsSent(id, type, response);
      await callbacksRun();
      return { result };
    },
    receiveSyncChanges: async (toDeviceEvents, counts) => {
      const received = await machine.receiveSyncChanges(
        toDeviceEvents,
        new wasm.DeviceLists(),
        new Map(Object.entries(counts)),
        new Set(),
      );
      await callbacksRun();
      return received.map((event) => defined(fromWasm.toDevice(event)));
    },
    receiveSyncChangesMsc4186: (toDeviceEvents, counts) =>
      respond(
        () =>
          machine.receiveSyncChangesMsc4186(
            toDeviceEvents,
            new wasm.DeviceLists(),
            new Map(Object.entries(counts)),
            new Set(),
          ),
        (received) =>
          received.map((event) => defined(fromWasm.toDevice(event))),
      ),
    secretValues,
    updateTrackedUsers: async (list) =>
      (await machine.updateTrackedUsers(users(list))) ?? null,
    getMissingSessions: async (list) => {
      const request = await machine.getMissingSessions(users(list));
      return request ? plain(request) : null;
    },
    shareRoomKey: async (roomId, list, sharingStrategy, historyVisibility) => {
      const settings = new wasm.EncryptionSettings();
      if (historyVisibility !== undefined)
        settings.historyVisibility = historyVisibility;
      if (sharingStrategy) {
        // A constructor name, or a WASM CollectStrategy as matrix-js-sdk builds it.
        settings.sharingStrategy =
          typeof sharingStrategy === 'string'
            ? wasm.CollectStrategy[sharingStrategy]()
            : sharingStrategy;
      }
      return (
        await machine.shareRoomKey(room(roomId), users(list), settings)
      ).map(plain);
    },
    encryptRoomEvent: (roomId, eventType, content) =>
      machine.encryptRoomEvent(room(roomId), eventType, content),
    encryptStateEvent: (roomId, eventType, stateKey, content) =>
      respond(() =>
        machine.encryptStateEvent(room(roomId), eventType, stateKey, content),
      ),
    invalidateGroupSession: (roomId) =>
      respond(() => machine.invalidateGroupSession(room(roomId))),
    getRoomSettings: (roomId) =>
      respond(
        () => machine.getRoomSettings(room(roomId)),
        (settings) =>
          settings
            ? defined({
                algorithm: settings.algorithm,
                encryptStateEvents: settings.encryptStateEvents,
                onlyAllowTrustedDevices: settings.onlyAllowTrustedDevices,
                sessionRotationPeriodMs: settings.sessionRotationPeriodMs,
                sessionRotationPeriodMessages:
                  settings.sessionRotationPeriodMessages,
              })
            : null,
      ),
    setRoomSettings: (roomId, fields) =>
      respond(() => {
        const settings = new wasm.RoomSettings();
        Object.assign(settings, fields);
        return machine.setRoomSettings(room(roomId), settings);
      }),
    roomKeyRequestsEnabled: (enabled) =>
      respond(() => {
        if (enabled !== undefined) machine.roomKeyRequestsEnabled = enabled;
        return machine.roomKeyRequestsEnabled;
      }),
    getSecretsFromInbox: (name) =>
      respond(
        () => machine.getSecretsFromInbox(name),
        (set) => [...set].sort(),
      ),
    deleteSecretsFromInbox: (name) =>
      respond(() => machine.deleteSecretsFromInbox(name)),
    pushSecretToVerifiedDevices: (name) =>
      respond(() => machine.pushSecretToVerifiedDevices(name)),
    exportSecretsBundle: () =>
      respond(
        () => machine.exportSecretsBundle(),
        (bundle) => {
          const json = bundle.to_json();
          bundle.free();
          return json;
        },
      ),
    importSecretsBundle: (json) =>
      respond(() =>
        machine.importSecretsBundle(wasm.SecretsBundle.from_json(json)),
      ),
    buildRoomKeyBundle: (roomId) =>
      respond(
        () => machine.buildRoomKeyBundle(room(roomId)),
        (attachment) =>
          attachment
            ? {
                encryptedData: Buffer.from(attachment.encryptedData).toString(
                  'base64',
                ),
                mediaEncryptionInfo: attachment.mediaEncryptionInfo,
              }
            : null,
      ),
    shareRoomKeyBundleData: (user, roomId, url, info, strategy) =>
      respond(
        () =>
          machine.shareRoomKeyBundleData(
            new wasm.UserId(user),
            room(roomId),
            url,
            info,
            wasm.CollectStrategy[strategy](),
          ),
        (requests) => requests.map(plain),
      ),
    getReceivedRoomKeyBundleData: (roomId, inviter) =>
      respond(
        () =>
          machine.getReceivedRoomKeyBundleData(
            room(roomId),
            new wasm.UserId(inviter),
          ),
        (data) => {
          if (!data) return null;
          const view = {
            senderUser: data.senderUser.toString(),
            roomId: data.roomId.toString(),
            url: data.url,
            encryptionInfo: data.encryptionInfo,
          };
          data.free();
          return view;
        },
      ),
    // receiveRoomKeyBundle consumes the bundle data: fetched for each call, as matrix-js-sdk does.
    receiveRoomKeyBundle: (view, encryptedBundle) =>
      respond(async () =>
        machine.receiveRoomKeyBundle(
          await machine.getReceivedRoomKeyBundleData(
            room(view.roomId),
            new wasm.UserId(view.senderUser),
          ),
          new Uint8Array(Buffer.from(encryptedBundle, 'base64')),
        ),
      ),
    getPendingKeyBundleDetailsForRoom: (roomId) =>
      respond(
        () => machine.getPendingKeyBundleDetailsForRoom(room(roomId)),
        (details) => (details ? fromWasm.pendingBundle(details) : null),
      ),
    getAllRoomsPendingKeyBundles: () =>
      respond(
        () => machine.getAllRoomsPendingKeyBundles(),
        (all) =>
          all
            .map(fromWasm.pendingBundle)
            .sort((a, b) => a.roomId.localeCompare(b.roomId)),
      ),
    storeRoomPendingKeyBundle: (roomId, inviter) =>
      respond(() =>
        machine.storeRoomPendingKeyBundle(
          room(roomId),
          new wasm.UserId(inviter),
        ),
      ),
    clearRoomPendingKeyBundle: (roomId) =>
      respond(() => machine.clearRoomPendingKeyBundle(room(roomId))),
    hasDownloadedAllRoomKeys: (roomId) =>
      respond(() => machine.hasDownloadedAllRoomKeys(room(roomId))),
    setHasDownloadedAllRoomKeys: (roomId) =>
      respond(() => machine.setHasDownloadedAllRoomKeys(room(roomId))),
    createDehydratedDevice: (name, key) =>
      respond(async () => {
        const created = await withDehydratedDevices((devices) =>
          devices.create(),
        );
        try {
          const request = await created.keysForUpload(
            name,
            dehydrationKey(key),
          );
          return { body: request.body };
        } finally {
          created.free();
        }
      }),
    getDehydratedDeviceKey: () =>
      respond(async () => {
        const key = await withDehydratedDevices((devices) =>
          devices.getDehydratedDeviceKey(),
        );
        return key ? key.toBase64() : null;
      }),
    saveDehydratedDeviceKey: (key) =>
      respond(() =>
        withDehydratedDevices((devices) =>
          devices.saveDehydratedDeviceKey(dehydrationKey(key)),
        ),
      ),
    rehydrateDevice: (key, id, deviceData) =>
      respond(async () => {
        rehydrated?.free();
        rehydrated = undefined;
        rehydrated = await withDehydratedDevices((devices) =>
          devices.rehydrate(
            dehydrationKey(key),
            new wasm.DeviceId(id),
            deviceData,
          ),
        );
        return null;
      }),
    receiveRehydratedEvents: (_id, toDeviceEvents) =>
      respond(
        () => rehydrated.receiveEvents(toDeviceEvents),
        (infos) => infos.map(fromWasm.roomKeyInfo),
      ),
    dropRehydratedDevice: () =>
      respond(() => {
        rehydrated.free();
      }),
    decryptRoomEvent: (event, roomId) =>
      respond(
        () =>
          machine.decryptRoomEvent(
            event,
            room(roomId),
            new wasm.DecryptionSettings(wasm.TrustRequirement.Untrusted),
          ),
        fromWasm.decrypted,
      ),
    getRoomEventEncryptionInfo: (event, roomId) =>
      respond(
        () => machine.getRoomEventEncryptionInfo(event, room(roomId)),
        fromWasm.encryptionInfo,
      ),
    // The callbacks run from WASM's own promise chain: let it settle first.
    pollEvents: async () => {
      await new Promise((settled) => setTimeout(settled, 10));
      return byType({ result: { events: events.splice(0), dropped: 0 } });
    },
    exportRoomKeys: () => respond(() => machine.exportRoomKeys(() => true)),
    // The listeners record their last call, which native returns as `lastProgress`.
    importExportedRoomKeys: (keys) => {
      let last = null;
      return respond(
        () =>
          machine.importExportedRoomKeys(keys, (...args) => {
            last = args.map(Number);
          }),
        (result) => fromWasm.importResult(result, last),
      );
    },
    importBackedUpRoomKeys: (rooms, version) => {
      let last = null;
      return respond(
        () =>
          machine.importBackedUpRoomKeys(
            new Map(
              Object.entries(rooms).map(([roomId, sessions]) => [
                room(roomId),
                new Map(Object.entries(sessions)),
              ]),
            ),
            (...args) => {
              last = args.map(Number);
            },
            version,
          ),
        // WASM reports failures only to its listener, which it calls once per valid key.
        (result) => ({
          ...fromWasm.importResult(result, last),
          failures: last?.[2],
        }),
      );
    },
    roomKeyCounts: () =>
      respond(
        () => machine.roomKeyCounts(),
        ({ total, backedUp }) => ({ total, backedUp }),
      ),
    backupRoomKeys: () =>
      respond(
        () => machine.backupRoomKeys(),
        (request) => (request ? plain(request) : null),
      ),
    getBackupKeys: () =>
      respond(
        () => machine.getBackupKeys(),
        (keys) => ({
          decryptionKeyBase64: keys.decryptionKey?.toBase64(),
          backupVersion: keys.backupVersion,
        }),
      ),
    saveBackupDecryptionKey: (key, version) =>
      respond(() =>
        machine.saveBackupDecryptionKey(
          wasm.BackupDecryptionKey.fromBase64(key),
          version,
        ),
      ),
    enableBackupV1: (key, version) =>
      respond(() => machine.enableBackupV1(key, version)),
    disableBackup: () => respond(() => machine.disableBackup()),
    isBackupEnabled: () => respond(() => machine.isBackupEnabled()),
    verifyBackup: (info) =>
      respond(
        () => machine.verifyBackup(info),
        (verification) => ({
          deviceState: verification.deviceState,
          userState: verification.userState,
          trusted: verification.trusted(),
        }),
      ),
    sign: (message) =>
      respond(
        () => machine.sign(message),
        (signatures) => JSON.parse(signatures.asJSON()),
      ),
    markAllTrackedUsersAsDirty: () =>
      respond(() => machine.markAllTrackedUsersAsDirty()),
    trackedUsers: () =>
      respond(
        () => machine.trackedUsers(),
        (set) => [...set].map(String).sort(),
      ),
    queryKeysForUsers: (list) =>
      respond(() => plain(machine.queryKeysForUsers(users(list)))),
    getDevice: (user, id) =>
      respond(
        () => machine.getDevice(new wasm.UserId(user), new wasm.DeviceId(id)),
        (found) => (found ? fromWasm.device(found) : null),
      ),
    getUserDevices: (user) =>
      respond(
        () => machine.getUserDevices(new wasm.UserId(user)),
        (found) =>
          found
            .devices()
            .map(fromWasm.device)
            .sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
      ),
    getIdentity: (user) =>
      respond(
        () => machine.getIdentity(new wasm.UserId(user)),
        (found) => (found ? fromWasm.identity(found) : null),
      ),
    setLocalTrust: (user, id, state) =>
      respond(async () => (await onDevice(user, id)).setLocalTrust(state)),
    verifyDevice: (user, id) =>
      respond(async () => plain(await (await onDevice(user, id)).verify())),
    encryptToDeviceEvent: (user, id, eventType, content) =>
      respond(async () =>
        (await onDevice(user, id)).encryptToDeviceEvent(eventType, content),
      ),
    verifyIdentity: (user) =>
      respond(async () => plain(await (await onIdentity(user)).verify())),
    withdrawVerification: (user) =>
      respond(async () => (await onIdentity(user)).withdrawVerification()),
    pinCurrentMasterKey: (user) =>
      respond(async () => (await onIdentity(user)).pinCurrentMasterKey()),
    bootstrapCrossSigning: (reset) =>
      respond(
        () => machine.bootstrapCrossSigning(reset),
        (requests) => ({
          uploadKeysRequest:
            requests.uploadKeysRequest && plain(requests.uploadKeysRequest),
          uploadSigningKeysRequest: {
            body: requests.uploadSigningKeysRequest.body,
          },
          uploadSignaturesRequest: plain(requests.uploadSignaturesRequest),
        }),
      ),
    crossSigningStatus: () =>
      respond(() => machine.crossSigningStatus(), fromWasm.crossSigningStatus),
    exportCrossSigningKeys: () =>
      respond(
        () => machine.exportCrossSigningKeys(),
        (keys) =>
          keys
            ? {
                masterKey: keys.masterKey,
                self_signing_key: keys.self_signing_key,
                userSigningKey: keys.userSigningKey,
              }
            : null,
      ),
    importCrossSigningKeys: ({ masterKey, selfSigningKey, userSigningKey }) =>
      respond(
        () =>
          machine.importCrossSigningKeys(
            masterKey,
            selfSigningKey,
            userSigningKey,
          ),
        fromWasm.crossSigningStatus,
      ),
    getVerificationRequest: (user, flowId) =>
      respond(
        () => machine.getVerificationRequest(userIdOf(user), flowId),
        (found) => (found ? fromWasm.verificationRequest(seen(found)) : null),
      ),
    getVerificationRequests: (user) =>
      respond(
        () => machine.getVerificationRequests(userIdOf(user)),
        (found) =>
          found
            .map((it) => fromWasm.verificationRequest(seen(it)))
            .sort((a, b) => a.flowId.localeCompare(b.flowId)),
      ),
    getVerification: (user, flowId) =>
      respond(
        () => machine.getVerification(userIdOf(user), flowId),
        (found) => (found ? fromWasm.verification(seen(found)) : null),
      ),
    receiveVerificationEvent: (event, roomId) =>
      respond(() => machine.receiveVerificationEvent(event, room(roomId))),
    requestDeviceVerification: (user, id, methods) =>
      respond(async () => {
        const [request, toDevice] = (
          await onDevice(user, id)
        ).requestVerification(methods);
        return [fromWasm.verificationRequest(seen(request)), plain(toDevice)];
      }),
    requestIdentityVerification: ({
      userId: user,
      methods,
      roomId,
      requestEventId,
    }) =>
      respond(async () => {
        const identity = await onIdentity(user);
        if (identity instanceof wasm.OwnUserIdentity) {
          const [request, toDevice] =
            await identity.requestVerification(methods);
          return [fromWasm.verificationRequest(seen(request)), plain(toDevice)];
        }
        return fromWasm.verificationRequest(
          seen(
            identity.requestVerification(
              room(roomId),
              new wasm.EventId(requestEventId),
              methods,
            ),
          ),
        );
      }),
    verificationRequestContent: (user, methods) =>
      respond(async () =>
        (await onIdentity(user)).verificationRequestContent(methods),
      ),
    acceptVerificationRequest: (user, flowId, methods) =>
      respond(() => {
        const request = onRequest(user, flowId);
        return outgoing(
          methods ? request.acceptWithMethods(methods) : request.accept(),
        );
      }),
    cancelVerificationRequest: (user, flowId) =>
      respond(() => outgoing(onRequest(user, flowId).cancel())),
    startSas: (user, flowId) =>
      respond(async () => {
        const started = await onRequest(user, flowId).startSas();
        if (!started) return null;
        const [sas, request] = started;
        return [fromWasm.sas(seen(sas)), plain(request)];
      }),
    generateQrCode: (user, flowId) =>
      respond(async () => {
        const qr = await onRequest(user, flowId).generateQrCode();
        return qr ? fromWasm.qr(seen(qr)) : null;
      }),
    scanQrCode: (user, flowId, data) =>
      respond(async () => {
        const qr = await onRequest(user, flowId).scanQrCode(
          wasm.QrCodeScan.fromBytes(
            new Uint8ClampedArray(Buffer.from(data, 'base64')),
          ),
        );
        return qr ? fromWasm.qr(seen(qr)) : null;
      }),
    acceptSas: (user, flowId) =>
      respond(() => outgoing(onSas(user, flowId).accept())),
    confirmSas: (user, flowId) =>
      respond(async () =>
        (await onSas(user, flowId).confirm()).map((request) => plain(request)),
      ),
    cancelSas: (user, flowId, code) =>
      respond(() => {
        const sas = onSas(user, flowId);
        return outgoing(code ? sas.cancelWithCode(code) : sas.cancel());
      }),
    cancelQr: (user, flowId, code) =>
      respond(() => {
        const qr = onQr(user, flowId);
        return outgoing(code ? qr.cancelWithCode(code) : qr.cancel());
      }),
    confirmQrScanning: (user, flowId) =>
      respond(() => outgoing(onQr(user, flowId).confirmScanning())),
    reciprocateQr: (user, flowId) =>
      respond(() => outgoing(onQr(user, flowId).reciprocate())),
    qrCodeBytes: (user, flowId) =>
      respond(() =>
        Buffer.from(onQr(user, flowId).toBytes()).toString('base64'),
      ),
    close() {
      if (!closed) machine.close();
      closed = true;
    },
  };
};

let counter = 0;

/**
 * Starts the CLI for the enclosing `describe` and returns a factory for devices of either
 * kind, all closed after the suite.
 */
export const useDevices = () => {
  let cli;
  const devices = [];
  beforeAll(async () => {
    await wasm.initAsync();
    cli = startCli(buildCli());
  });
  afterAll(async () => {
    for (const created of devices) await created.close();
    cli?.stop();
  });
  /** `ids` names a device of an existing user, such as a second device. */
  return async (kind, ids = {}) => {
    const userId = ids.userId ?? `@${kind}${counter++}:localhost`;
    const deviceId = ids.deviceId ?? `${kind.toUpperCase()}${counter}`;
    const created =
      kind === 'native'
        ? await nativeDevice(cli, userId, deviceId)
        : await wasmDevice(userId, deviceId);
    devices.push(created);
    return created;
  };
};

/** Values that are kept in a shape; every other leaf becomes its type. */
const LITERAL = new Set([
  'type',
  'event_type',
  'algorithm',
  'algorithms',
  'color',
  'code',
  'reason',
]);

/** Leaves to types (except `LITERAL` fields), keys through `key`, sorted. */
export const shape = (node, key = (name) => name, name = undefined) => {
  if (LITERAL.has(name)) return node;
  if (Array.isArray(node)) return node.map((item) => shape(item, key));
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .map(([child, item]) => [key(child), shape(item, key, child)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return node === null ? 'null' : typeof node;
};

/** Replaces what differs between two receivers of the same message: their IDs and keys. */
export const anonymise = (value, receiver) =>
  value === undefined
    ? value
    : JSON.parse(
        JSON.stringify(value)
          .replaceAll(receiver.userId, '<receiver>')
          .replaceAll(receiver.deviceId, '<receiver device>')
          .replaceAll(receiver.identityKeys.ed25519, '<receiver ed25519>')
          .replaceAll(
            receiver.identityKeys.curve25519,
            '<receiver curve25519>',
          ),
      );

export class Homeserver {
  /** User → device ID → signed device keys. */
  deviceKeys = new Map();
  /** User → `{ master_key, self_signing_key, user_signing_key }` as uploaded. */
  crossSigning = new Map();
  oneTimeKeys = new Map();
  inbox = new Map();
  /** The first request of each type a device kind sent, as a shape. */
  shapes = { native: {}, wasm: {} };
  /** markRequestAsSent's answer to the first request of each type a device kind sent. */
  marked = { native: {}, wasm: {} };
  /** The native methods whose answers are in `shapes` and `marked`. */
  answered = new Set();

  constructor(requestShape = () => undefined) {
    this.requestShape = requestShape;
  }

  #respond(device, request) {
    const body = JSON.parse(request.body);
    const { RequestType } = wasm;
    switch (request.type) {
      case RequestType.KeysUpload: {
        if (body.device_keys) {
          this.deviceKeys.set(device.userId, {
            ...this.deviceKeys.get(device.userId),
            [device.deviceId]: body.device_keys,
          });
        }
        const keys = this.#otks(device.userId, device.deviceId);
        keys.push(...Object.entries(body.one_time_keys ?? {}));
        return { one_time_key_counts: { signed_curve25519: keys.length } };
      }
      case RequestType.KeysQuery: {
        const found = Object.keys(body.device_keys).filter(
          (user) => this.deviceKeys.has(user) || this.crossSigning.has(user),
        );
        // A copy: the client must not see later changes to what the server holds.
        const keys = (name, users) =>
          structuredClone(
            Object.fromEntries(
              users
                .filter((user) => this.crossSigning.get(user)?.[name])
                .map((user) => [user, this.crossSigning.get(user)[name]]),
            ),
          );
        return {
          device_keys: structuredClone(
            Object.fromEntries(
              found.map((user) => [user, this.deviceKeys.get(user) ?? {}]),
            ),
          ),
          // As the spec has it, a user's signatures on someone else's master key are visible
          // only to that user.
          master_keys: Object.fromEntries(
            Object.entries(keys('master_key', found)).map(([user, key]) => [
              user,
              {
                ...key,
                signatures: Object.fromEntries(
                  Object.entries(key.signatures ?? {}).filter(([signer]) =>
                    [user, device.userId].includes(signer),
                  ),
                ),
              },
            ]),
          ),
          self_signing_keys: keys('self_signing_key', found),
          // Only the user's own user-signing key is visible.
          user_signing_keys: keys(
            'user_signing_key',
            found.filter((user) => user === device.userId),
          ),
          failures: {},
        };
      }
      case RequestType.KeysClaim: {
        const claimed = {};
        for (const [user, devices] of Object.entries(body.one_time_keys)) {
          for (const target of Object.keys(devices)) {
            const [id, key] = this.#otks(user, target).pop();
            claimed[user] = { ...claimed[user], [target]: { [id]: key } };
          }
        }
        return { one_time_keys: claimed, failures: {} };
      }
      case RequestType.ToDevice: {
        for (const [user, devices] of Object.entries(body.messages)) {
          for (const [target, content] of Object.entries(devices)) {
            // `*`: every device of the user but the sender.
            const targets =
              target === '*'
                ? Object.keys(this.deviceKeys.get(user) ?? {}).filter(
                    (id) => user !== device.userId || id !== device.deviceId,
                  )
                : [target];
            for (const id of targets)
              this.#queue(user, id).push({
                type: request.event_type,
                sender: device.userId,
                content,
              });
          }
        }
        return {};
      }
      case RequestType.SignatureUpload: {
        for (const [user, signed] of Object.entries(body)) {
          for (const [id, object] of Object.entries(signed)) {
            const target =
              this.deviceKeys.get(user)?.[id] ??
              Object.values(this.crossSigning.get(user) ?? {}).find((key) =>
                Object.values(key.keys).includes(id),
              );
            if (!target) throw new Error(`no key ${id} of ${user} to sign`);
            for (const [signer, signatures] of Object.entries(
              object.signatures,
            )) {
              target.signatures ??= {};
              target.signatures[signer] = {
                ...target.signatures[signer],
                ...signatures,
              };
            }
          }
        }
        return { failures: {} };
      }
      case RequestType.RoomMessage:
        return {
          event_id: this.sendRoomEvent(
            device,
            request.room_id,
            request.event_type,
            body,
          ),
        };
      default:
        throw new Error(`unexpected request type ${request.type}`);
    }
  }

  /** Room ID → `{ members, events }`, for in-room verification. */
  rooms = new Map();
  /** `user|device|room` → how many of the room's events that device has received. */
  #cursors = new Map();

  joinRoom(roomId, members) {
    this.rooms.set(roomId, { members, events: [] });
  }

  /** `PUT /rooms/{roomId}/send/{type}`: the new event's ID. */
  sendRoomEvent(device, roomId, type, content) {
    const eventId = `$${randomBytes(18).toString('base64url')}`;
    this.rooms.get(roomId).events.push({
      event_id: eventId,
      type,
      sender: device.userId,
      content,
      origin_server_ts: Date.now(),
    });
    return eventId;
  }

  /**
   * Hands `device` the room events it has not seen (its own included), as a sync would, and
   * returns receiveVerificationEvent's answers.
   */
  async syncRooms(device) {
    const answers = [];
    for (const [roomId, { members, events }] of this.rooms) {
      if (!members.includes(device)) continue;
      const key = `${device.userId}|${device.deviceId}|${roomId}`;
      const from = this.#cursors.get(key) ?? 0;
      this.#cursors.set(key, events.length);
      for (const event of events.slice(from)) {
        const answer = await device.receiveVerificationEvent(
          JSON.stringify(event),
          roomId,
        );
        expect(answer.error, 'receiveVerificationEvent').toBeUndefined();
        answers.push(answer);
      }
    }
    return answers;
  }

  #otks(user, device) {
    const id = `${user}|${device}`;
    if (!this.oneTimeKeys.has(id)) this.oneTimeKeys.set(id, []);
    return this.oneTimeKeys.get(id);
  }

  #queue(user, device) {
    const id = `${user}|${device}`;
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    return this.inbox.get(id);
  }

  /** User → the dehydrated device of `PUT /dehydrated_device`. */
  dehydrated = new Map();
  /** mxc URL → uploaded bytes (base64). */
  media = new Map();

  /** `PUT /dehydrated_device`: publishes its keys as a device of the user. */
  putDehydratedDevice(device, request) {
    const body = JSON.parse(request.body);
    this.dehydrated.set(device.userId, body);
    this.deviceKeys.set(device.userId, {
      ...this.deviceKeys.get(device.userId),
      [body.device_id]: body.device_keys,
    });
    this.#otks(device.userId, body.device_id).push(
      ...Object.entries(body.one_time_keys ?? {}),
    );
    return body.device_id;
  }

  /** `POST /media/upload`: the content URI. */
  upload(base64) {
    const url = `mxc://localhost/${randomBytes(9).toString('base64url')}`;
    this.media.set(url, base64);
    return url;
  }

  /** `/keys/device_signing/upload`: replaces the user's cross-signing keys. */
  uploadSigningKeys(device, request) {
    const body = JSON.parse(request.body);
    this.crossSigning.set(
      device.userId,
      Object.fromEntries(Object.entries(body).filter(([, key]) => key)),
    );
  }

  /** Flips the first character of a stored device signature, as a tampering server would. */
  tamper(user, deviceId, signer, keyId) {
    const signatures = this.deviceKeys.get(user)[deviceId].signatures[signer];
    const signature = signatures[keyId];
    expect(signature, `signature ${keyId} to tamper with`).toBeDefined();
    signatures[keyId] =
      (signature.startsWith('A') ? 'B' : 'A') + signature.slice(1);
  }

  /** Answers `request`, marks it as sent and returns markRequestAsSent's answer. */
  async send(device, request) {
    const first = !(request.type in this.shapes[device.kind]);
    if (first) {
      this.shapes[device.kind][request.type] = this.requestShape(
        request,
        device,
      );
      for (const method of answered(request)) this.answered.add(method);
    }
    const response = this.#respond(device, request);
    // A signature upload returned by a call (not by outgoingRequests) has no ID to mark.
    if (request.id === undefined) return undefined;
    const marked = await device.markRequestAsSent(
      request.id,
      request.type,
      JSON.stringify(response),
    );
    if (first) {
      this.marked[device.kind][request.type] = marked;
      for (const method of answered(marked)) this.answered.add(method);
    }
    return marked;
  }

  /**
   * Compares the requests each device kind sent (the first of each type, by shape) and the
   * answers to marking them as sent, and counts the native calls that made them.
   */
  expectSameRequests() {
    expect(this.shapes.native, 'request shapes').toEqual(this.shapes.wasm);
    expect(this.marked.native, 'markRequestAsSent').toEqual(this.marked.wasm);
    for (const method of this.answered) comparedCalls.add(method);
  }

  async flush(device) {
    for (const request of await device.outgoingRequests())
      await this.send(device, request);
  }

  pending(device) {
    return [...this.#queue(device.userId, device.deviceId)];
  }

  deliver(device, events) {
    this.#queue(device.userId, device.deviceId).push(...events);
  }

  /** Hands `device` its to-device events; `msc4186` passes them as simplified sliding sync. */
  async sync(device, { msc4186 = false } = {}) {
    const events = this.#queue(device.userId, device.deviceId).splice(0);
    const counts = {
      signed_curve25519: this.#otks(device.userId, device.deviceId).length,
    };
    return msc4186
      ? device.receiveSyncChangesMsc4186(JSON.stringify(events), counts)
      : device.receiveSyncChanges(JSON.stringify(events), counts);
  }

  /** The to-device events queued for a device, taken (a dehydrated device's events). */
  take(userId, deviceId) {
    return this.#queue(userId, deviceId).splice(0);
  }
}

export const shareKey = async (
  server,
  sender,
  users,
  roomId,
  sharingStrategy,
) => {
  for (const share of await sender.shareRoomKey(
    roomId,
    users,
    sharingStrategy,
  )) {
    await server.send(sender, share);
  }
};

/** Everyone publishes keys and tracks everyone; `sender` claims keys and shares a room key. */
export const shareRoom = async (server, sender, receivers, roomId) => {
  const everyone = [sender, ...receivers];
  const users = everyone.map(({ userId }) => userId);
  for (const device of everyone) await server.flush(device);
  for (const device of everyone) {
    await device.updateTrackedUsers(users);
    await server.flush(device);
  }
  const claim = await sender.getMissingSessions(
    receivers.map(({ userId }) => userId),
  );
  expect(claim?.type).toBe(wasm.RequestType.KeysClaim);
  await server.send(sender, claim);
  await shareKey(server, sender, users, roomId);
};

export const roomEvent = (sender, roomId, content) =>
  JSON.stringify({
    type: 'm.room.encrypted',
    event_id: `$${Math.random().toString(36).slice(2)}:localhost`,
    sender: sender.userId,
    origin_server_ts: Date.now(),
    room_id: roomId,
    content: JSON.parse(content),
  });
