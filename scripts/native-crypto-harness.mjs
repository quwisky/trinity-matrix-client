/**
 * Shared by the native crypto interop and contract tests: the crate's JSON-lines CLI and the
 * WASM package as two kinds of device with one interface, a tiny homeserver between them, and
 * `covered`, which ties a test case to entries of native/crypto/surface.json.
 *
 * Without cargo on PATH the suites are skipped and say why; in CI (`CI` set) a missing cargo
 * fails instead, so the job cannot pass without running them.
 */
import { spawn, spawnSync } from 'node:child_process';
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

/** The native methods called inside `compared` since the current `covered` case started. */
const nativeCalls = new Set();
let comparing = 0;

/** Runs a step whose answers the case compares with WASM; only its native calls count. */
export const compared = async (run) => {
  comparing += 1;
  try {
    return await run();
  } finally {
    comparing -= 1;
  }
};

/** Runs the same step on each device (native first), with each device's own IDs replaced. */
export const both = (devices, run) =>
  compared(async () => {
    const answers = [];
    for (const device of devices) {
      answers.push(anonymise(await run(device), device));
    }
    return answers;
  });

const startCli = (executable) => {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  return {
    async call(request) {
      if (comparing) nativeCalls.add(request.method);
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const { value, done } = await lines.next();
      if (done) throw new Error('trinity-crypto-cli exited');
      return JSON.parse(value);
    },
    stop: () => child.stdin.end(),
  };
};

const surface = JSON.parse(
  readFileSync(resolve(root, 'native/crypto/surface.json'), 'utf8'),
);

/**
 * A test case for the surface entries it lists (`Class.member`), which
 * scripts/native-crypto-surface.spec.mjs reads statically. The case fails unless it called
 * each entry's native method inside a compared step (`compared` or `both`), so setup calls
 * do not count.
 */
export const covered = (entries, title, run) =>
  it(`${title} [${entries.join(', ')}]`, async () => {
    nativeCalls.clear();
    await run();
    for (const entry of entries) {
      const [owner, member] = entry.split('.');
      const { native } = surface.stateful[owner]?.[member] ?? {};
      expect(
        nativeCalls.has(native),
        `${entry} calls native ${native} in a compared step`,
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
 * Events grouped by type, each type in arrival order: neither side orders events across types
 * (WASM's callbacks run on separate promise chains).
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
    markRequestAsSent: (requestId, requestType, response) =>
      call('markRequestAsSent', { requestId, requestType, response }),
    receiveSyncChanges: (toDeviceEvents, oneTimeKeysCounts) =>
      call('receiveSyncChanges', {
        toDeviceEvents,
        changedDevices: { changed: [], left: [] },
        oneTimeKeysCounts,
        unusedFallbackKeys: [],
      }),
    updateTrackedUsers: (users) => call('updateTrackedUsers', { users }),
    getMissingSessions: (users) => call('getMissingSessions', { users }),
    shareRoomKey: (roomId, users, sharingStrategy) =>
      call('shareRoomKey', {
        roomId,
        users,
        encryptionSettings: defined({ sharingStrategy }),
      }),
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
    queryKeysForUsers: (users) => respond('queryKeysForUsers', { users }),
    getDevice: (user, id) =>
      respond('getDevice', { userId: user, deviceId: id }),
    getUserDevices: (user) => respond('getUserDevices', { userId: user }),
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
  const respond = fromWasm.response;
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
    markRequestAsSent: (id, type, response) =>
      machine.markRequestAsSent(id, type, response),
    receiveSyncChanges: async (toDeviceEvents, counts) =>
      (
        await machine.receiveSyncChanges(
          toDeviceEvents,
          new wasm.DeviceLists(),
          new Map(Object.entries(counts)),
          new Set(),
        )
      ).map((event) => defined(fromWasm.toDevice(event))),
    updateTrackedUsers: (list) => machine.updateTrackedUsers(users(list)),
    getMissingSessions: async (list) => {
      const request = await machine.getMissingSessions(users(list));
      return request ? plain(request) : null;
    },
    shareRoomKey: async (roomId, list, sharingStrategy) => {
      const settings = new wasm.EncryptionSettings();
      if (sharingStrategy) {
        settings.sharingStrategy = wasm.CollectStrategy[sharingStrategy]();
      }
      return (
        await machine.shareRoomKey(room(roomId), users(list), settings)
      ).map(plain);
    },
    encryptRoomEvent: (roomId, eventType, content) =>
      machine.encryptRoomEvent(room(roomId), eventType, content),
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
            claimed[user] = { [target]: { [id]: key } };
          }
        }
        return { one_time_keys: claimed, failures: {} };
      }
      case RequestType.ToDevice: {
        for (const [user, devices] of Object.entries(body.messages)) {
          for (const [target, content] of Object.entries(devices)) {
            this.#queue(user, target).push({
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
      default:
        throw new Error(`unexpected request type ${request.type}`);
    }
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

  async send(device, request) {
    this.shapes[device.kind][request.type] ??= this.requestShape(
      request,
      device,
    );
    const response = this.#respond(device, request);
    // A signature upload returned by a call (not by outgoingRequests) has no ID to mark.
    if (request.id === undefined) return;
    await device.markRequestAsSent(
      request.id,
      request.type,
      JSON.stringify(response),
    );
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

  async sync(device) {
    const events = this.#queue(device.userId, device.deviceId).splice(0);
    const counts = {
      signed_curve25519: this.#otks(device.userId, device.deviceId).length,
    };
    return device.receiveSyncChanges(JSON.stringify(events), counts);
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
