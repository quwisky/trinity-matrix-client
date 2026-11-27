/**
 * The native crypto crate (native/crypto) and the WASM package the web app ships must
 * interoperate as two devices, and emit the same request shapes for the same step. The
 * native side runs as its JSON-lines CLI; a tiny in-test homeserver carries the keys and
 * to-device messages between them.
 *
 * Without cargo on PATH the suite is skipped and says why; in CI (`CI` set) a missing cargo
 * fails instead, so the job cannot pass without running it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import { format, resolveConfig } from 'prettier';

const root = resolve(import.meta.dirname, '..');
const hasCargo = spawnSync('cargo', ['--version']).status === 0;
if (!hasCargo && process.env.CI) {
  throw new Error('The native crypto interop test needs cargo in CI.');
}
const skipped = hasCargo ? '' : ' (skipped: cargo is not on PATH)';
if (!hasCargo) {
  console.warn(`native crypto interop${skipped}; install Rust to run it.`);
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
      return JSON.parse(value);
    },
    stop: () => child.stdin.end(),
  };
};

const REQUEST_FIELDS = [
  'id',
  'type',
  'body',
  'event_type',
  'txn_id',
  'room_id',
  'version',
];
const plain = (request) =>
  Object.fromEntries(
    REQUEST_FIELDS.filter((field) => request[field] !== undefined).map(
      (field) => [field, request[field]],
    ),
  );

const decryptionSettings = {
  sender_device_trust_requirement: wasm.TrustRequirement.Untrusted,
};

const nativeDevice = async (cli, userId, deviceId) => {
  const respond = (method, params = {}) =>
    cli.call({ method, userId, deviceId, params });
  const call = async (method, params) => {
    const response = await respond(method, params);
    if (response.error)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const { identityKeys } = await call('init');
  return {
    kind: 'native',
    userId,
    deviceId,
    identityKeys,
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
    shareRoomKey: (roomId, users) => call('shareRoomKey', { roomId, users }),
    encryptRoomEvent: (roomId, eventType, content) =>
      call('encryptRoomEvent', { roomId, eventType, content }),
    decryptRoomEvent: (event, roomId) =>
      respond('decryptRoomEvent', { event, roomId, decryptionSettings }),
    getRoomEventEncryptionInfo: (event, roomId) =>
      respond('getRoomEventEncryptionInfo', { event, roomId }),
    close: () => call('close'),
  };
};

/** Drops `undefined` fields, as the native JSON leaves them out. */
const defined = (value) => JSON.parse(JSON.stringify(value));

/** The WASM getters, read into the native crate's JSON shapes (native/crypto/README.md). */
const fromWasm = {
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
  /** `{ result }` or `{ error }`, as a native call answers. */
  async response(run, map) {
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
  return {
    kind: 'wasm',
    userId,
    deviceId,
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
    shareRoomKey: async (roomId, list) =>
      (
        await machine.shareRoomKey(
          room(roomId),
          users(list),
          new wasm.EncryptionSettings(),
        )
      ).map(plain),
    encryptRoomEvent: (roomId, eventType, content) =>
      machine.encryptRoomEvent(room(roomId), eventType, content),
    decryptRoomEvent: (event, roomId) =>
      fromWasm.response(
        () =>
          machine.decryptRoomEvent(
            event,
            room(roomId),
            new wasm.DecryptionSettings(wasm.TrustRequirement.Untrusted),
          ),
        fromWasm.decrypted,
      ),
    getRoomEventEncryptionInfo: (event, roomId) =>
      fromWasm.response(
        () => machine.getRoomEventEncryptionInfo(event, room(roomId)),
        fromWasm.encryptionInfo,
      ),
    close: () => machine.close(),
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
const shape = (node, key = (name) => name, name = undefined) => {
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

/** Placeholders for IDs and key IDs, so two runs of the same request compare equal. */
const requestShape = (request, device) => {
  const key = (name) =>
    name
      .replaceAll(device.userId, '<user>')
      .replace(/^@[^:]+:localhost$/, '<other user>')
      .replace(
        /^(signed_curve25519|curve25519|ed25519):(.+)$/,
        (_, algorithm, id) =>
          `${algorithm}:${id === device.deviceId ? '<device>' : '<key>'}`,
      )
      .replace(new RegExp(`^${device.deviceId}$`), '<device>')
      .replace(/^[A-Z]+\d+$/, '<other device>')
      .replace(/^[A-Za-z0-9+/]{43}$/, '<curve25519 key>');
  return shape({ ...request, body: JSON.parse(request.body) }, key);
};

/** Replaces what differs between two receivers of the same message: their IDs and keys. */
const anonymise = (value, receiver) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(receiver.userId, '<receiver>')
      .replaceAll(receiver.deviceId, '<receiver device>')
      .replaceAll(receiver.identityKeys.ed25519, '<receiver ed25519>')
      .replaceAll(receiver.identityKeys.curve25519, '<receiver curve25519>'),
  );

class Homeserver {
  deviceKeys = new Map();
  oneTimeKeys = new Map();
  inbox = new Map();
  /** The first request of each type a device kind sent, as a shape. */
  shapes = { native: {}, wasm: {} };

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
    this.shapes[device.kind][request.type] ??= requestShape(request, device);
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

/** Everyone publishes keys and tracks everyone; `sender` claims keys and shares a room key. */
const shareRoom = async (server, sender, receivers, roomId) => {
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

const shareKey = async (server, sender, users, roomId) => {
  for (const share of await sender.shareRoomKey(roomId, users)) {
    await server.send(sender, share);
  }
};

const roomEvent = (sender, roomId, content) =>
  JSON.stringify({
    type: 'm.room.encrypted',
    event_id: `$${Math.random().toString(36).slice(2)}:localhost`,
    sender: sender.userId,
    origin_server_ts: Date.now(),
    room_id: roomId,
    content: JSON.parse(content),
  });

const { Decrypted, UnableToDecrypt } = wasm.ProcessedToDeviceEventType;
let counter = 0;

describe.skipIf(!hasCargo)(`native crypto interop with WASM${skipped}`, () => {
  let cli;
  const devices = [];
  const device = async (kind) => {
    const userId = `@${kind}${counter++}:localhost`;
    const deviceId = `${kind.toUpperCase()}${counter}`;
    const created =
      kind === 'native'
        ? await nativeDevice(cli, userId, deviceId)
        : await wasmDevice(userId, deviceId);
    devices.push(created);
    return created;
  };

  /**
   * One sender, a native and a WASM receiver, the same messages to both. Returns, per step,
   * what each receiver answered (native first), with the receivers' own IDs and keys replaced.
   */
  const exchange = async (server, senderKind) => {
    const sender = await device(senderKind);
    const receivers = [await device('native'), await device('wasm')];
    const users = [sender, ...receivers].map(({ userId }) => userId);
    const each = async (run) => {
      const answers = [];
      for (const receiver of receivers) {
        answers.push(anonymise(await run(receiver), receiver));
      }
      return answers;
    };
    const toDevice = (events, rawEvent) =>
      events.map((event) => ({ ...event, rawEvent: rawEvent(event.rawEvent) }));
    const roomId = `!${senderKind}:localhost`;
    await shareRoom(server, sender, receivers, roomId);
    const copies = receivers.map((receiver) => server.pending(receiver));

    const roomKey = await each(async (receiver) =>
      toDevice(await server.sync(receiver), JSON.parse),
    );
    receivers.forEach((receiver, index) =>
      server.deliver(receiver, copies[index]),
    );
    // A replayed olm message carries fresh ciphertext per receiver: compare its shape.
    const replay = await each(async (receiver) =>
      toDevice(await server.sync(receiver), (raw) => raw),
    ).then((answers) =>
      answers.map((events) =>
        toDevice(events, (raw) => shape(JSON.parse(raw))),
      ),
    );

    const content = { msgtype: 'm.text', body: `from ${senderKind}` };
    const event = roomEvent(
      sender,
      roomId,
      await sender.encryptRoomEvent(
        roomId,
        'm.room.message',
        JSON.stringify(content),
      ),
    );
    const decrypted = await each((receiver) =>
      receiver.decryptRoomEvent(event, roomId),
    );
    const encryptionInfo = await each((receiver) =>
      receiver.getRoomEventEncryptionInfo(event, roomId),
    );

    const lonelyRoom = `!${senderKind}-alone:localhost`;
    await shareKey(server, sender, [sender.userId], lonelyRoom);
    const lonely = roomEvent(
      sender,
      lonelyRoom,
      await sender.encryptRoomEvent(lonelyRoom, 'm.room.message', '{}'),
    );
    const missingKey = await each((receiver) =>
      receiver.decryptRoomEvent(lonely, lonelyRoom),
    );

    await shareKey(server, sender, users, `!${senderKind}-later:localhost`);
    const afterReplay = await each(async (receiver) =>
      (await server.sync(receiver)).map(({ type }) => type),
    );

    return {
      sender,
      content,
      steps: {
        roomKey,
        replay,
        decrypted,
        encryptionInfo,
        missingKey,
        afterReplay,
      },
    };
  };

  beforeAll(async () => {
    await wasm.initAsync();
    cli = startCli(buildCli());
  });

  afterAll(async () => {
    for (const created of devices) await created.close();
    cli?.stop();
  });

  describe.each(['native', 'wasm'])('%s sender', (senderKind) => {
    it('decrypts on native and WASM with the same results', async () => {
      const { sender, content, steps } = await exchange(
        new Homeserver(),
        senderKind,
      );
      for (const [step, [native, wasmAnswer]] of Object.entries(steps)) {
        expect(native, step).toEqual(wasmAnswer);
      }

      expect(steps.roomKey[0].map(({ type }) => type)).toEqual([Decrypted]);
      expect(steps.roomKey[0][0].rawEvent.type).toBe('m.room_key');
      expect(steps.replay[0].map(({ type }) => type)).toEqual([
        UnableToDecrypt,
      ]);
      expect(steps.afterReplay[0]).toEqual([Decrypted]);

      const { result } = steps.decrypted[0];
      expect(JSON.parse(result.event).content).toEqual(content);
      expect(result.sender).toBe(sender.userId);
      expect(result.senderCurve25519Key).toBe(sender.identityKeys.curve25519);
      expect(result.senderClaimedEd25519Key).toBe(sender.identityKeys.ed25519);
      // Neither device is cross-signed, so the shield is red.
      expect(result.shieldState.lax.color).toBe(wasm.ShieldColor.Red);
      expect(steps.missingKey[0].error.details.code).toBe(
        wasm.DecryptionErrorCode.MissingRoomKey,
      );
    });
  });

  it('emits the same request shapes as WASM and matches the golden file', async () => {
    const server = new Homeserver();
    const { steps } = await exchange(server, 'native');
    await exchange(server, 'wasm');

    const { RequestType } = wasm;
    expect(Object.keys(server.shapes.wasm).map(Number).sort()).toEqual(
      [
        RequestType.KeysUpload,
        RequestType.KeysQuery,
        RequestType.KeysClaim,
        RequestType.ToDevice,
      ].sort(),
    );
    expect(server.shapes.native).toEqual(server.shapes.wasm);
    const responses = Object.fromEntries(
      Object.entries(steps).map(([step, [native]]) => [step, shape(native)]),
    );
    // Written as Prettier writes it, so `pnpm format:check` accepts the updated file.
    const golden = resolve(
      import.meta.dirname,
      'native-crypto-interop.golden.json',
    );
    const options = { ...(await resolveConfig(golden)), filepath: golden };
    await expect(
      await format(
        JSON.stringify({ requests: server.shapes.wasm, responses }),
        options,
      ),
    ).toMatchFileSnapshot(golden);
  });
});
