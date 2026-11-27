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

/** The native methods called since the current `covered` case started. */
const nativeCalls = new Set();

const startCli = (executable) => {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  return {
    async call(request) {
      nativeCalls.add(request.method);
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
 * each entry's native method.
 */
export const covered = (entries, title, run) =>
  it(`${title} [${entries.join(', ')}]`, async () => {
    nativeCalls.clear();
    await run();
    for (const entry of entries) {
      const [owner, member] = entry.split('.');
      const { native } = surface.stateful[owner]?.[member] ?? {};
      expect(nativeCalls.has(native), `${entry} calls native ${native}`).toBe(
        true,
      );
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
    pollEvents: () => respond('pollEvents'),
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
  importResult: (result) => ({
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
  const respond = fromWasm.response;
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
      return { result: { events: events.splice(0), dropped: 0 } };
    },
    exportRoomKeys: () => respond(() => machine.exportRoomKeys(() => true)),
    importExportedRoomKeys: (keys) =>
      respond(
        () => machine.importExportedRoomKeys(keys, () => {}),
        fromWasm.importResult,
      ),
    importBackedUpRoomKeys: (rooms, version) =>
      respond(
        () =>
          machine.importBackedUpRoomKeys(
            new Map(
              Object.entries(rooms).map(([roomId, sessions]) => [
                room(roomId),
                new Map(Object.entries(sessions)),
              ]),
            ),
            undefined,
            version,
          ),
        fromWasm.importResult,
      ),
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
  return async (kind) => {
    const userId = `@${kind}${counter++}:localhost`;
    const deviceId = `${kind.toUpperCase()}${counter}`;
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
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(receiver.userId, '<receiver>')
      .replaceAll(receiver.deviceId, '<receiver device>')
      .replaceAll(receiver.identityKeys.ed25519, '<receiver ed25519>')
      .replaceAll(receiver.identityKeys.curve25519, '<receiver curve25519>'),
  );

export class Homeserver {
  deviceKeys = new Map();
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
            [device.deviceId]: body.device_keys,
          });
        }
        const keys = this.#otks(device.userId, device.deviceId);
        keys.push(...Object.entries(body.one_time_keys ?? {}));
        return { one_time_key_counts: { signed_curve25519: keys.length } };
      }
      case RequestType.KeysQuery: {
        const found = Object.keys(body.device_keys).filter((user) =>
          this.deviceKeys.has(user),
        );
        return {
          device_keys: Object.fromEntries(
            found.map((user) => [user, this.deviceKeys.get(user)]),
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

  async send(device, request) {
    this.shapes[device.kind][request.type] ??= this.requestShape(
      request,
      device,
    );
    const response = this.#respond(device, request);
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
